import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Service, advanceExpiredTurns, WAIT_EXPIRY_ACTOR } from '../server/service.ts';
import { notificationText, waitDeadline } from '../server/notifications.ts';
import { SQLiteRepo } from './sqlite-repo.ts';

const owner = { id: 'chatgpt:owner', role: 'superadmin' as const, teams: [] },
  visitor = { id: 'chatgpt:person', emailKey: 'chatgpt-email:person@example.test', role: 'viewer' as const, teams: [] };
async function setup() {
  const repo = new SQLiteRepo(),
    s = new Service(repo, owner);
  await s.init();
  const cid = (await s.list()).campaigns.find((c: any) => c.team_id === 'C').id;
  let d = await s.view(cid);
  d = await s.mutate(cid, {
    action: 'import_roster',
    version: d.campaign.version,
    source: {
      format: 'vacaciones-roster-v1',
      team: 'C',
      year: 2026,
      copySelections: false,
      rows: [
        { code: 'AA', label: 'A', seniority: '' },
        { code: 'BB', label: 'B', seniority: '' },
        { code: 'CC', label: 'C', seniority: '' },
      ],
    },
  });
  d = await s.mutate(cid, {
    action: 'config',
    version: d.campaign.version,
    config: {
      ...d.config,
      previousScores: { AA: 10, BB: 20, CC: 30 },
      previousScoresSource: 'Puntuaciones de ensayo verificadas',
    },
  });
  return { repo, s, cid, d, person: new Service(repo, visitor) };
}
async function act(s: Service, cid: string, body: any, now?: number) {
  await s.election().mutate(cid, { ...body, version: (await s.load(cid)).campaign.version }, now);
  return s.view(cid);
}
const start = (d: any) => ({
  action: 'start',
  order: d.members.map((m: any) => m.id),
  source: 'Orden histórico confirmado por administrador',
  rulesConfirmed: true,
  allowDeferral: true,
});
const MIN = 60_000;

test('guardar «esperar» valida el plazo y conserva modo y minutos', async () => {
  const { s, cid, d } = await setup(),
    [a] = d.members,
    date = d.result.cycles[0].date;
  await assert.rejects(
    act(s, cid, { action: 'preferences', memberId: a.id, dates: [date], mode: 'wait', waitMinutes: 0 }),
    /plazo/,
  );
  await assert.rejects(
    act(s, cid, { action: 'preferences', memberId: a.id, dates: [date], mode: 'wait', waitMinutes: 24 * 60 + 1 }),
    /plazo/,
  );
  await assert.rejects(act(s, cid, { action: 'preferences', memberId: a.id, dates: [date], mode: 'otro' }), /plazo/);
  const saved = await act(s, cid, {
    action: 'preferences',
    memberId: a.id,
    dates: [date],
    mode: 'wait',
    waitMinutes: 90,
  });
  const p = saved.election.preferences.find((x: any) => x.member_id === a.id);
  assert.equal(p.mode, 'wait');
  assert.equal(p.waitMinutes, 90);
  // An older client that sends no mode keeps the immediate behaviour.
  const legacy = await act(s, cid, { action: 'preferences', memberId: a.id, dates: [date] });
  assert.equal(legacy.election.preferences.find((x: any) => x.member_id === a.id).mode, 'immediate');
});

test('los ciclos de la lista pueden llevar nombre: se guardan, se limpian y se validan', async () => {
  const { s, cid, d } = await setup(),
    [a] = d.members,
    [first, second, third] = d.result.cycles.map((c: any) => c.date);
  const saved = await act(s, cid, {
    action: 'preferences',
    memberId: a.id,
    dates: [first, second],
    mode: 'manual',
    labels: { [first]: '  Eclipse ', [second]: '', [third]: 'Fuera de la lista' },
  });
  assert.deepEqual(saved.election.preferences.find((p: any) => p.member_id === a.id).labels, { [first]: 'Eclipse' });
  await assert.rejects(
    act(s, cid, { action: 'preferences', memberId: a.id, dates: [first], labels: { [first]: 'x'.repeat(41) } }),
    /40 caracteres/,
  );
  await assert.rejects(
    act(s, cid, { action: 'preferences', memberId: a.id, dates: [first], labels: ['Eclipse'] }),
    /caracteres/,
  );
  // A list without names, from an older client, simply has none.
  const legacy = await act(s, cid, { action: 'preferences', memberId: a.id, dates: [first] });
  assert.deepEqual(legacy.election.preferences.find((p: any) => p.member_id === a.id).labels, {});
});

test('el turno con lista «esperar» no se adjudica hasta que vence; el planificador lo aplica después', async () => {
  const { repo, s, cid, d } = await setup(),
    [a, b] = d.members,
    date = d.result.cycles[0].date;
  await act(s, cid, { action: 'preferences', memberId: a.id, dates: [date], mode: 'wait', waitMinutes: 30 });
  const t0 = Date.now();
  let view = await act(s, cid, start(d), t0);
  assert.equal(view.election.turn.memberId, a.id);
  assert.equal(view.election.pendingAutomatic, false);
  assert.equal(view.election.listPlan.deadline, new Date(t0 + 30 * MIN).toISOString());
  assert.deepEqual(view.election.listPlan.dates, [date]);
  assert.equal(await s.election().expire(cid, t0 + 29 * MIN), 0);
  assert.deepEqual(await advanceExpiredTurns(repo, t0 + 31 * MIN), { applied: 1, errors: 0 });
  view = await s.view(cid);
  assert.deepEqual(
    view.awards.filter((x: any) => x.member_id === a.id).map((x: any) => x.cycle_date),
    [date],
  );
  assert.equal(view.election.turn.memberId, b.id);
  const audit = await repo.all("SELECT actor FROM audit WHERE campaign_id=? AND action='advance'", [cid]);
  assert.deepEqual(
    audit.map((r: any) => r.actor),
    [WAIT_EXPIRY_ACTOR.id],
  );
});

test('si el titular elige antes del plazo, su lista no actúa después', async () => {
  const { s, cid, d } = await setup(),
    [a, b] = d.members,
    [first, second] = d.result.cycles.map((c: any) => c.date);
  await act(s, cid, { action: 'preferences', memberId: a.id, dates: [first], mode: 'wait', waitMinutes: 10 });
  const t0 = Date.now();
  await act(s, cid, start(d), t0);
  const view = await act(s, cid, { action: 'choose', memberId: a.id, dates: [second] }, t0 + MIN);
  assert.equal(await s.election().expire(cid, t0 + 60 * MIN), 0);
  assert.deepEqual(
    view.awards.filter((x: any) => x.member_id === a.id).map((x: any) => x.cycle_date),
    [second],
  );
  assert.equal((await s.view(cid)).election.turn.memberId, b.id);
});

test('al reanudar, el plazo empieza a contar de nuevo', async () => {
  const { s, cid, d } = await setup(),
    [a] = d.members,
    date = d.result.cycles[0].date;
  await act(s, cid, { action: 'preferences', memberId: a.id, dates: [date], mode: 'wait', waitMinutes: 30 });
  const t0 = Date.now();
  await act(s, cid, start(d), t0);
  await act(s, cid, { action: 'pause' }, t0 + 5 * MIN);
  assert.equal(await s.election().expire(cid, t0 + 40 * MIN), 0);
  const view = await act(s, cid, { action: 'resume' }, t0 + 60 * MIN);
  assert.equal(view.election.listPlan.deadline, new Date(t0 + 90 * MIN).toISOString());
  assert.equal(await s.election().expire(cid, t0 + 80 * MIN), 0);
  assert.equal(await s.election().expire(cid, t0 + 91 * MIN), 1);
});

test('el responsable ve la cola de la ronda y la simulación al reanudar; un controlador no', async () => {
  const { s, cid, d, person } = await setup(),
    [a, b, c] = d.members,
    [first, second] = d.result.cycles.map((x: any) => x.date);
  await act(s, cid, { action: 'preferences', memberId: b.id, dates: [second] });
  await act(s, cid, { action: 'preferences', memberId: c.id, dates: [first], mode: 'wait', waitMinutes: 120 });
  await act(s, cid, start(d));
  let view = await act(s, cid, { action: 'pause' });
  assert.deepEqual(
    view.election.queue.map((e: any) => [e.memberId, e.mode, e.waitMinutes]),
    [
      [a.id, 'none', 0],
      [b.id, 'immediate', 0],
      [c.id, 'wait', 120],
    ],
  );
  assert.deepEqual(view.election.chain.applied, []);
  assert.deepEqual(view.election.chain.stop, { memberId: a.id, reason: 'manual' });
  await act(s, cid, { action: 'link_account', memberId: a.id, subject: 'person@example.test', accountVersion: 0 });
  const theirs = await person.view(cid);
  assert.equal(theirs.election.queue, null);
  assert.equal(theirs.election.chain, null);
  view = await act(s, cid, { action: 'resume' });
  view = await act(s, cid, { action: 'choose', memberId: a.id, dates: [first] });
  // B's immediate list is due: the panel announces it with its cycle, then stops at C's wait.
  assert.deepEqual(view.election.chain.applied, [{ memberId: b.id, dates: [second] }]);
  assert.deepEqual(view.election.chain.stop, { memberId: c.id, reason: 'wait', waitMinutes: 120 });
});

test('el aviso «Es tu turno» indica la hora límite de una lista que espera', async () => {
  const { repo, s, cid, d } = await setup(),
    [a] = d.members,
    date = d.result.cycles[0].date;
  await act(s, cid, { action: 'preferences', memberId: a.id, dates: [date], mode: 'wait', waitMinutes: 45 });
  const t0 = Date.parse('2026-11-02T09:00:00Z');
  await act(s, cid, start(d), t0);
  const deadline = await waitDeadline(repo, cid, a.id);
  assert.equal(deadline, new Date(t0 + 45 * MIN).toISOString());
  assert.match(notificationText({ id: cid + ':' + a.id + ':1:0', round: 1 }, { deadline }).body, /hasta las 10:45/);
  assert.match(notificationText({ id: cid + ':' + a.id + ':1:0', round: 1 }).body, /Ya puedes elegir/);
});
