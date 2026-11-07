import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importRoster } from './import-helper.ts';
import { SQLiteRepo } from './sqlite-repo.ts';
import { Service } from '../server/service.ts';
import { VA_TEAM, ensureVaTeam } from '../server/teams.ts';
import { loadVaQuotas } from '../server/va-quotas.ts';
import { calendar, iso, rotationCode, serial } from '../domain/calendar.ts';
import { vaDaysOff } from '../server/va-integrity.ts';
import { calendarOwner, lockedDays } from '../app/own-cycles.ts';
import { choiceIssues } from '../domain/election.ts';
import { earlyProof } from '../domain/early-election.ts';
import { occupancyOf } from '../domain/policy.ts';
import { defaultConfig } from '../domain/defaults.ts';
import type { Principal } from '../server/permissions.ts';

const owner: Principal = { id: 'chatgpt:owner', role: 'superadmin', teams: [] };
const VA = 'va-2026';

/**
 * Team C with three controllers in the 2026 ordinary campaign, and the 2026 VA campaign
 * with the same people, `days` VA days each and the given HR places per day.
 */
async function setup(places: Record<string, number>, days = [3, 3, 3], realRotation = false) {
  const repo = new SQLiteRepo(),
    s = new Service(repo, owner);
  await s.init();
  const ordinary = (await s.list()).campaigns.find((c: { team_id: string }) => c.team_id === 'C').id;
  let d = await s.view(ordinary);
  d = await importRoster(s, ordinary, {
    action: 'import_roster',
    version: d.campaign.version,
    source: {
      format: 'vacaciones-roster-v1',
      team: 'C',
      year: 2026,
      copySelections: false,
      rows: ['AA', 'BB', 'CC'].map((code) => ({ code, label: 'CTA ' + code, seniority: '' })),
    },
  });
  // Same night shifts, hence the same cycles, but no free days to dodge in the dates below.
  const alwaysWorking = {
    ...d.config,
    rotation: d.config.rotation.map((row: string[]) => row.map((s) => (s === ' ' ? 'M' : s))),
  };
  await repo.batch([
    ...(realRotation
      ? []
      : [{ sql: 'UPDATE parameters SET json=? WHERE campaign_id=?', args: [JSON.stringify(alwaysWorking), ordinary] }]),
    ensureVaTeam,
    {
      sql: "INSERT INTO campaigns(id,team_id,year,status,version,data_kind,created_at) VALUES(?,?,2026,'open',1,'real','2026-01-01')",
      args: [VA, VA_TEAM],
    },
    { sql: 'INSERT INTO parameters(campaign_id,json,version) VALUES(?,?,1)', args: [VA, JSON.stringify(d.config)] },
    ...d.members.map((m: { id: string; person_id: string; code: string }, i: number) => ({
      sql: "INSERT INTO campaign_members(id,campaign_id,person_id,code,label,seniority,position,entitlement,version) VALUES(?,?,?,?,?,'',?,?,1)",
      args: ['va-' + m.code, VA, m.person_id, m.code, 'CTA ' + m.code, i, days[i]],
    })),
    ...Object.entries(places).map(([date, n]) => ({
      sql: 'INSERT INTO va_quotas(year,date,places) VALUES(2026,?,?)',
      args: [date, n],
    })),
  ]);
  return { repo, s, ordinary, cycles: calendar(2026, 'C', d.config) };
}
async function act(s: Service, cid: string, body: Record<string, unknown>) {
  await s.election().mutate(cid, { ...body, version: (await s.load(cid)).campaign.version });
  return s.view(cid);
}
const start = (allowDeferral = true) => ({
  action: 'start',
  order: ['va-AA', 'va-BB', 'va-CC'],
  source: 'Orden del censo de VA',
  rulesConfirmed: true,
  allowDeferral,
});
/** What the engine says of one choice in a loaded campaign, with its external data. */
const issuesIn = (d: Awaited<ReturnType<Service['load']>>, memberId: string, date: string) =>
  choiceIssues(
    {
      year: d.campaign.year,
      team: d.campaign.team_id,
      config: d.config,
      members: d.members,
      requests: [],
      awards: d.awards,
      external: d.external,
    },
    memberId,
    [date],
  );
const day = (n: number) => '2026-03-' + String(n).padStart(2, '0');
const many = (n: number, places = 3) => Object.fromEntries(Array.from({ length: n }, (_, i) => [day(i + 1), places]));

test('VA: dos rondas exactas, un día en la primera y el saldo en la segunda', async () => {
  const { s } = await setup(many(12));
  let v = await act(s, VA, start());
  assert.equal(v.election.turn.needed, 1, 'primera ronda: un día');
  v = await act(s, VA, { action: 'choose', memberId: 'va-AA', dates: [day(1)] });
  v = await act(s, VA, { action: 'choose', memberId: 'va-BB', dates: [day(2)] });
  v = await act(s, VA, { action: 'choose', memberId: 'va-CC', dates: [day(3)] });
  assert.equal(v.election.turn.memberId, 'va-AA');
  assert.equal(v.election.turn.needed, 2, 'segunda ronda: el saldo restante');
  await assert.rejects(act(s, VA, { action: 'defer', memberId: 'va-AA' }), /última ronda/);
  await act(s, VA, { action: 'choose', memberId: 'va-AA', dates: [day(4), day(5)] });
  await act(s, VA, { action: 'choose', memberId: 'va-BB', dates: [day(6), day(7)] });
  v = await act(s, VA, { action: 'choose', memberId: 'va-CC', dates: [day(8), day(9)] });
  assert.equal(v.election.state.status, 'complete');
  assert.equal(v.awards.length, 9);
});

test('VA: el cupo de cada día y los días sin plazas se respetan', async () => {
  const { s } = await setup({ [day(1)]: 1, [day(2)]: 3, [day(3)]: 3 }, [1, 1, 1]);
  await act(s, VA, start());
  await act(s, VA, { action: 'choose', memberId: 'va-AA', dates: [day(1)] });
  await assert.rejects(act(s, VA, { action: 'choose', memberId: 'va-BB', dates: [day(1)] }), /no quedan plazas/);
  await assert.rejects(act(s, VA, { action: 'choose', memberId: 'va-BB', dates: [day(20)] }), /sin plazas de VA/);
  const v = await act(s, VA, { action: 'choose', memberId: 'va-BB', dates: [day(2)] });
  assert.deepEqual(
    v.result.cycles.map((c: { date: string; max: number; occupied: number }) => [c.date, c.max, c.occupied]),
    [
      [day(1), 1, 1],
      [day(2), 3, 1],
      [day(3), 3, 0],
    ],
  ); // The administrator's manual awards, with the election paused, go through the same quotas.
  await act(s, VA, { action: 'pause' });
  const award = async (memberId: string, date: string) =>
    s.mutate(VA, { action: 'award', version: (await s.load(VA)).campaign.version, memberId, date });
  await assert.rejects(award('va-CC', day(1)), /no quedan plazas/);
  await award('va-CC', day(3));
});

test('VA: los días de cada participante son los congelados en su ficha de campaña', async () => {
  const { s } = await setup(many(10), [1, 2, 3]);
  await act(s, VA, start());
  await act(s, VA, { action: 'choose', memberId: 'va-AA', dates: [day(1)] });
  await act(s, VA, { action: 'choose', memberId: 'va-BB', dates: [day(2)] });
  const second = await act(s, VA, { action: 'choose', memberId: 'va-CC', dates: [day(3)] });
  // AA has used up their only day: the second round starts with BB, who owes one more.
  assert.equal(second.election.turn.memberId, 'va-BB');
  assert.equal(second.election.turn.needed, 1);
});

test('VA: no se elige un día de las vacaciones ordinarias, ni del ciclo de diciembre anterior', async () => {
  const { repo, s, ordinary, cycles } = await setup(many(31));
  // AA holds an ordinary cycle that covers some March days.
  const march = cycles.find((c) => c.date <= day(10) && c.end >= day(10))!;
  const aa = (await s.load(ordinary)).members.find((m: { code: string }) => m.code === 'AA');
  await repo.batch([
    {
      sql: 'INSERT INTO awards(id,campaign_id,member_id,cycle_date) VALUES(?,?,?,?)',
      args: ['ord-aa', ordinary, aa.id, march.date],
    },
  ]);
  await act(s, VA, start());
  await assert.rejects(
    act(s, VA, { action: 'choose', memberId: 'va-AA', dates: [day(10)] }),
    /coincide con sus vacaciones ordinarias/,
  );
  await act(s, VA, { action: 'choose', memberId: 'va-AA', dates: [day(30)] });

  // The last 2025 cycle runs into January 2026: those January days are blocked too.
  await s.createCampaigns(2025, null, null);
  const previous = (await s.list()).campaigns.find(
    (c: { team_id: string; year: number }) => c.team_id === 'C' && c.year === 2025,
  ).id;
  let p = await s.view(previous);
  p = await importRoster(s, previous, {
    action: 'import_roster',
    version: p.campaign.version,
    source: {
      format: 'vacaciones-roster-v1',
      team: 'C',
      year: 2025,
      copySelections: false,
      rows: ['AA', 'BB', 'CC'].map((code) => ({ code, label: 'CTA ' + code, seniority: '' })),
    },
  });
  // Its campaign keeps the last cycle, which runs from December 30 into January.
  p = await s.mutate(previous, {
    action: 'config',
    version: p.campaign.version,
    config: { ...p.config, excludeLast: false },
  });
  const last = calendar(2025, 'C', p.config).at(-1)!;
  assert.ok(last.end.startsWith('2026-01'), 'el último ciclo de 2025 termina en enero');
  const bb = p.members.find((m: { code: string }) => m.code === 'BB');
  // The same person as BB of the 2026 campaigns.
  const person = (await s.load(VA)).members.find((m: { code: string }) => m.code === 'BB').person_id;
  await repo.batch([
    { sql: 'UPDATE campaign_members SET person_id=? WHERE id=?', args: [person, bb.id] },
    { sql: 'INSERT INTO va_quotas(year,date,places) VALUES(2026,?,3)', args: [last.end] },
    {
      sql: 'INSERT INTO awards(id,campaign_id,member_id,cycle_date) VALUES(?,?,?,?)',
      args: ['ord-bb', previous, bb.id, last.date],
    },
  ]);
  await assert.rejects(
    act(s, VA, { action: 'choose', memberId: 'va-BB', dates: [last.end] }),
    /coincide con sus vacaciones ordinarias/,
  );
});

test('VA: la base de datos impide un día de VA sobre ordinarias o por encima de sus plazas, también con datos ya leídos', async () => {
  const { repo, s, ordinary, cycles } = await setup(many(31));
  await act(s, VA, start());
  await act(s, VA, { action: 'choose', memberId: 'va-AA', dates: [day(10)] });
  const march = cycles.find((c) => c.date <= day(10) && c.end >= day(10))!;
  const members = (await s.load(ordinary)).members;
  const insert = (id: string, campaign: string, member: string, date: string) => ({
    sql: 'INSERT INTO awards(id,campaign_id,member_id,cycle_date) VALUES(?,?,?,?)',
    args: [id, campaign, member, date],
  });
  // A VA write prepared without seeing an ordinary award (as a concurrent request would)
  // is rejected by the assertion in its own batch.
  await repo.batch([insert('ord-bb', ordinary, members[1].id, march.date)]);
  await assert.rejects(
    s.commit([insert('va-late', VA, 'va-BB', day(11))]),
    /mismo día en vacaciones ordinarias y de VA/,
  );
  // And a VA day never goes over its places, whatever path writes it.
  await repo.batch([{ sql: 'UPDATE va_quotas SET places=1 WHERE date=?', args: [day(20)] }]);
  await s.commit([insert('x1', VA, 'va-CC', day(20))]);
  await assert.rejects(s.commit([insert('x2', VA, 'va-BB', day(20))]), /por encima de sus plazas/);
});

test('VA: una simulación de VA ve las ordinarias reales en lectura, sin aserciones', async () => {
  const { repo, s, ordinary, cycles } = await setup(many(31));
  await act(s, VA, start());
  await act(s, VA, { action: 'choose', memberId: 'va-AA', dates: [day(10)] });
  const march = cycles.find((c) => c.date <= day(10) && c.end >= day(10))!;
  const insert = (id: string, campaign: string, member: string, date: string) => ({
    sql: 'INSERT INTO awards(id,campaign_id,member_id,cycle_date) VALUES(?,?,?,?)',
    args: [id, campaign, member, date],
  });
  const simulation = async (cid: string, name: string) => {
    await s.createSimulation(cid, { version: (await s.load(cid)).campaign.version, name });
    const row = (await repo.all('SELECT id FROM campaigns WHERE simulation_name=?', [name]))[0];
    return s.load(row.id);
  };
  // It sees the live ordinary awards, read only.
  const bb = (await s.load(ordinary)).members.find((m: { code: string }) => m.code === 'BB');
  await repo.batch([insert('ord-bb', ordinary, bb.id, march.date)]);
  const v = await simulation(VA, 'Ensayo VA');
  const simBB = v.members.find((m: { code: string }) => m.code === 'BB');
  assert.match(issuesIn(v, simBB.id, day(11)).join(), /coincide con sus vacaciones ordinarias/);
  await s.commit([insert('sim-bb', v.campaign.id, simBB.id, day(11))]);
});

test('VA: preferencias automáticas, deshacer y rehacer con el motor común', async () => {
  const { s } = await setup(many(12));
  let v = await act(s, VA, start());
  await act(s, VA, { action: 'preferences', memberId: 'va-BB', dates: [day(1), day(5)], automatic: true });
  v = await act(s, VA, { action: 'choose', memberId: 'va-AA', dates: [day(1)] });
  // BB's list chooses at once: day 1 still has places.
  for (let step = 0; step < 10 && v.election.pendingAutomatic; step++) v = await act(s, VA, { action: 'advance' });
  assert.ok(
    v.awards.some((a: { member_id: string; cycle_date: string }) => a.member_id === 'va-BB' && a.cycle_date === day(1)),
  );
  v = await act(s, VA, { action: 'choose', memberId: 'va-CC', dates: [day(2)] });
  const before = v.awards.length;
  v = await act(s, VA, { action: 'election_undo', historyId: v.election.undo });
  assert.equal(v.awards.length, before - 1);
  assert.equal(v.election.turn.memberId, 'va-CC');
  v = await act(s, VA, { action: 'election_redo', historyId: v.election.redo });
  assert.equal(v.awards.length, before);
});

test('VA: la prueba directa de anticipadas en la segunda ronda, aunque el predecesor deba varios días', async () => {
  const { repo, s } = await setup({ ...many(10, 3), [day(20)]: 1 });
  // Early choices are made by the controller themself, from their linked account.
  const cc = new Service(repo, { id: 'chatgpt:cc', emailKey: 'chatgpt-email:cc@x.test', role: 'viewer', teams: [] });
  const person = (await s.load(VA)).members.find((m: { code: string }) => m.code === 'CC').person_id;
  await repo.batch([
    {
      sql: 'INSERT INTO controller_accounts(person_id,principal_key,version) VALUES(?,?,1)',
      args: [person, 'chatgpt-email:cc@x.test'],
    },
  ]);
  await act(s, VA, start());
  await act(s, VA, { action: 'choose', memberId: 'va-AA', dates: [day(1)] });
  await act(s, VA, { action: 'choose', memberId: 'va-BB', dates: [day(2)] });
  await act(s, VA, { action: 'choose', memberId: 'va-CC', dates: [day(3)] });
  // AA chooses their remaining two days; BB, who owes two, comes next.
  const ahead = await act(s, VA, { action: 'choose', memberId: 'va-AA', dates: [day(4), day(5)] });
  assert.equal(ahead.election.turn.memberId, 'va-BB');
  assert.equal(ahead.election.turn.needed, 2);
  // CC may take ahead of BB a day with two free places, not the last place of day 20.
  await assert.rejects(act(cc, VA, { action: 'early_choose', memberId: 'va-CC', date: day(20) }));
  await act(cc, VA, { action: 'early_choose', memberId: 'va-CC', date: day(6) });
  // Stored, though discreet: views keep it out until its slot (as in ordinary campaigns).
  const stored = await repo.all('SELECT member_id,cycle_date FROM awards WHERE campaign_id=?', [VA]);
  assert.ok(stored.some((a) => a.member_id === 'va-CC' && a.cycle_date === day(6)));
});

test('VA: los cupos quedan fijos al iniciar la campaña y no hay simulador personal', async () => {
  const { repo, s } = await setup(many(5));
  const va: Principal = { id: 'chatgpt:va', role: 'team_admin', teams: [VA_TEAM] };
  const body = {
    action: 'preview' as const,
    year: 2026,
    source: { title: 'Cupos RRHH', sha256: 'a'.repeat(64), receivedAt: '2026-01-01' },
    days: many(5, 2),
  };
  assert.ok((await loadVaQuotas(repo, va, body)).reviewToken, 'antes de iniciar se pueden cargar');
  await act(s, VA, start());
  await assert.rejects(loadVaQuotas(repo, va, body), /ya se ha iniciado/);
  await assert.rejects(s.personalSimulation().view(VA), /no está disponible en este tipo de campaña/);
});

test('VA: aplazamiento en la primera ronda y turno conjunto en la segunda, ejecutados por el servidor', async () => {
  const { s } = await setup(many(12));
  let v = await act(s, VA, start());
  // AA defers their first day: it joins the rest of their balance in the second round.
  v = await act(s, VA, { action: 'defer', memberId: 'va-AA' });
  assert.equal(v.election.turn.memberId, 'va-BB');
  await act(s, VA, { action: 'choose', memberId: 'va-BB', dates: [day(1)] });
  v = await act(s, VA, { action: 'register_joint', members: ['va-BB', 'va-CC'], round: 2 });
  v = await act(s, VA, { action: 'choose', memberId: 'va-CC', dates: [day(2)] });
  assert.equal(v.election.turn.memberId, 'va-AA');
  assert.equal(v.election.turn.needed, 3, 'el saldo completo, aplazado incluido');
  v = await act(s, VA, { action: 'choose', memberId: 'va-AA', dates: [day(3), day(4), day(5)] });
  assert.deepEqual(v.election.turn.participants, ['va-BB', 'va-CC']);
  v = await act(s, VA, {
    action: 'choose_joint',
    entries: [
      { member_id: 'va-BB', dates: [day(6), day(7)] },
      { member_id: 'va-CC', dates: [day(6), day(7)] },
    ],
  });
  assert.equal(v.election.state.status, 'complete');
});

test('VA: reconstrucción con pasos, retroceso y finalización', async () => {
  const { s } = await setup(many(12));
  await act(s, VA, start());
  await act(s, VA, { action: 'choose', memberId: 'va-AA', dates: [day(1)] });
  let v = await act(s, VA, { action: 'choose', memberId: 'va-BB', dates: [day(2)] });
  const target = v.election.reconstruction.candidates.find(
    (e: { action: string; memberIds: string[] }) => e.action === 'choose' && e.memberIds.includes('va-BB'),
  );
  v = await act(s, VA, { action: 'reconstruction_start', historyId: target.id });
  assert.equal(v.election.reconstruction.current.memberId, 'va-BB');
  v = await act(s, VA, { action: 'reconstruction_step', kind: 'choose', mode: 'manual', dates: [day(8)] });
  v = await act(s, VA, { action: 'reconstruction_back' });
  assert.equal(v.election.reconstruction.current.memberId, 'va-BB');
  v = await act(s, VA, { action: 'reconstruction_step', kind: 'choose', mode: 'manual', dates: [day(9)] });
  v = await act(s, VA, { action: 'reconstruction_finish' });
  assert.deepEqual(v.awards.map((a: { member_id: string; cycle_date: string }) => [a.member_id, a.cycle_date]).sort(), [
    ['va-AA', day(1)],
    ['va-BB', day(9)],
  ]);
});

test('VA: los cupos se fijan con la primera adjudicación, aunque no se haya iniciado la elección', async () => {
  const { repo, s } = await setup(many(5));
  const va: Principal = { id: 'chatgpt:va', role: 'team_admin', teams: [VA_TEAM] };
  await s.commit([
    {
      sql: 'INSERT INTO awards(id,campaign_id,member_id,cycle_date) VALUES(?,?,?,?)',
      args: ['a1', VA, 'va-AA', day(1)],
    },
  ]);
  const body = {
    action: 'preview' as const,
    year: 2026,
    source: { title: 'Cupos RRHH', sha256: 'a'.repeat(64), receivedAt: '2026-01-01' },
    days: { [day(2)]: 1 },
  };
  await assert.rejects(loadVaQuotas(repo, va, body), /ya se ha iniciado/);
});

test('VA: una simulación por encima de cupo no bloquea las escrituras reales', async () => {
  const { repo, s, ordinary } = await setup(many(5, 1));
  await s.createSimulation(VA, { version: (await s.load(VA)).campaign.version, name: 'Ensayo VA' });
  const sim = (await repo.all('SELECT id FROM campaigns WHERE simulation_name=?', ['Ensayo VA']))[0].id;
  const members = (await s.load(sim)).members;
  // Written past any check, as a broken simulation might be.
  await repo.batch(
    members.map((m: { id: string }, i: number) => ({
      sql: 'INSERT INTO awards(id,campaign_id,member_id,cycle_date) VALUES(?,?,?,?)',
      args: ['sim-' + i, sim, m.id, day(1)],
    })),
  );
  const o = await s.load(ordinary);
  await s.commit([
    {
      sql: 'UPDATE campaigns SET version=version+1 WHERE id=?',
      args: [o.campaign.id],
    },
  ]);
});

test('VA: la vista no ofrece aplazar en la última ronda', async () => {
  const { s } = await setup(many(12));
  let v = await act(s, VA, start());
  assert.equal(v.election.turn.canDefer, true, 'en la primera ronda sí');
  await act(s, VA, { action: 'choose', memberId: 'va-AA', dates: [day(1)] });
  await act(s, VA, { action: 'choose', memberId: 'va-BB', dates: [day(2)] });
  v = await act(s, VA, { action: 'choose', memberId: 'va-CC', dates: [day(3)] });
  assert.equal(v.election.turn.round, 2);
  assert.equal(v.election.turn.canDefer, false);
});

test('VA: el índice lista las simulaciones solo a quien administra VA, sin mezclarlas con las ordinarias', async () => {
  const { repo, s } = await setup(many(5, 1));
  await s.createSimulation(VA, { version: (await s.load(VA)).campaign.version, name: 'Ensayo VA' });
  const index = await s.list();
  assert.deepEqual(
    index.vaSimulations?.map((c: { simulation_name: string }) => c.simulation_name),
    ['Ensayo VA'],
  );
  assert.ok(!index.campaigns.some((c: { team_id: string }) => c.team_id === VA_TEAM));
  const vaAdmin = await new Service(repo, { id: 'chatgpt:va', role: 'team_admin', teams: [VA_TEAM] }).list();
  assert.equal(vaAdmin.vaSimulations?.length, 1);
  const other = await new Service(repo, { id: 'chatgpt:c', role: 'team_admin', teams: ['C'] }).list();
  assert.equal(other.vaSimulations, undefined);
  const viewer = await new Service(repo, { id: 'chatgpt:v', role: 'viewer', teams: [] }).list();
  assert.equal(viewer.vaSimulations, undefined);
});

test('VA: una elección ficticia en la simulación no toca la campaña real', async () => {
  const { repo, s } = await setup(many(12));
  await s.createSimulation(VA, { version: (await s.load(VA)).campaign.version, name: 'Ensayo VA' });
  const sim = (await repo.all('SELECT id FROM campaigns WHERE simulation_name=?', ['Ensayo VA']))[0].id;
  const members = (await s.load(sim)).members;
  await act(s, sim, { ...start(), order: members.map((m: { id: string }) => m.id) });
  const v = await act(s, sim, {
    action: 'choose',
    memberId: members.find((m: { code: string }) => m.code === 'AA').id,
    dates: [day(1)],
  });
  assert.equal(v.awards.length, 1);
  assert.equal((await s.load(VA)).awards.length, 0);
});

test('a day the rotation leaves free cannot be a VA day, and the calendars learn why', async () => {
  const probe = await setup({}, undefined, true);
  const { config } = await probe.s.load(probe.ordinary);
  const free: string[] = [],
    working: string[] = [];
  for (let d = serial('2026-03-01'); d < serial('2026-03-20'); d++)
    (rotationCode(d, 2026, 'C', config) === ' ' ? free : working).push(iso(d));
  const { s } = await setup({ [free[0]]: 2, [working[0]]: 2 }, undefined, true);
  const d = await s.load(VA);
  assert.match(issuesIn(d, 'va-AA', free[0]).join(), /libre de su turnero/);
  assert.deepEqual(issuesIn(d, 'va-AA', working[0]), []);
  const { daysOff } = (await s.view(VA)) as unknown as { daysOff: Record<string, { rest: string[] }> };
  assert.ok(daysOff['va-AA'].rest.includes(free[0]));
  assert.ok(!daysOff['va-AA'].rest.includes(working[0]));
});

test('the days off cover only the members passed in', () => {
  const external = { blocked: { p1: ['2026-03-01'], p2: ['2026-03-02'] }, rest: { p1: ['2026-03-03'] } };
  assert.deepEqual(vaDaysOff(external, [{ id: 'm1', person_id: 'p1' }]), {
    m1: { ordinary: ['2026-03-01'], rest: ['2026-03-03'] },
  });
  assert.deepEqual(vaDaysOff(undefined, [{ id: 'm1', person_id: 'p1' }]), {});
});

test('own VA days, ordinary vacations and free days lock in that order', () => {
  const locked = lockedDays(['2026-01-01'], {
    ordinary: ['2026-01-01', '2026-01-02'],
    rest: ['2026-01-01', '2026-01-02', '2026-01-03'],
  });
  assert.deepEqual(Object.fromEntries(locked), {
    '2026-01-01': 'va',
    '2026-01-02': 'ordinary',
    '2026-01-03': 'rest',
  });
  assert.equal(lockedDays(['2026-01-01'], undefined).size, 0);
});

test('the VA calendar locks the days of whoever the turn being chosen belongs to', () => {
  const turn = { daily: true, choosing: true, mine: 'admin' };
  assert.equal(calendarOwner({ ...turn, participants: ['target'] }), 'target');
  assert.equal(calendarOwner({ ...turn, mine: null, participants: ['target'] }), 'target');
  assert.equal(calendarOwner({ ...turn, participants: ['a', 'b'], jointTarget: 'b' }), 'b');
  assert.equal(calendarOwner({ ...turn, participants: ['a', 'b'] }), 'a');
  // Outside a turn being chosen, and in ordinary campaigns, nothing changes.
  assert.equal(calendarOwner({ ...turn, choosing: false, participants: ['target'], editedList: 'list' }), 'list');
  assert.equal(calendarOwner({ ...turn, choosing: false, participants: ['target'] }), 'admin');
  assert.equal(calendarOwner({ ...turn, daily: false, participants: ['target'] }), 'admin');
});
