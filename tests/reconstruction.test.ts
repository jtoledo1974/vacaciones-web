import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Service } from '../server/service.ts';
import { SQLiteRepo } from './sqlite-repo.ts';
const owner = { id: 'chatgpt:owner', role: 'superadmin' as const, teams: [] };
async function fixture() {
  const repo = new SQLiteRepo(),
    s = new Service(repo, owner);
  await s.init();
  const cid = (await s.list()).campaigns.find((c) => c.team_id === 'C').id;
  let d = await s.view(cid);
  d = await s.mutate(cid, {
    action: 'import_roster',
    version: d.campaign.version,
    source: {
      format: 'vacaciones-roster-v1',
      team: 'C',
      year: 2026,
      copySelections: false,
      rows: ['AA', 'BB', 'CC', 'DD'].map((code) => ({ code, label: 'Ejemplo ' + code, seniority: '' })),
    },
  });
  d = await s.mutate(cid, {
    action: 'config',
    version: d.campaign.version,
    config: {
      ...d.config,
      previousScores: { AA: 10, BB: 20, CC: 30, DD: 40 },
      previousScoresSource: 'Puntuaciones históricas del fixture',
    },
  });
  return { repo, s, cid, ids: d.members.map((m: any) => m.id), dates: d.result.cycles.map((c: any) => c.date) };
}
async function act(s: Service, cid: string, body: any) {
  await s.election().mutate(cid, { ...body, version: (await s.load(cid)).campaign.version });
  return s.view(cid);
}
const start = (ids: string[], extra: object = {}) => ({
  action: 'start',
  order: ids,
  source: 'Orden certificado para pruebas de recuperación',
  rulesConfirmed: true,
  allowDeferral: true,
  ...extra,
});
test('reconstrucción guiada modifica tercera elección y recupera preferencia de cuarta', async () => {
  const { s, cid, ids, dates } = await fixture();
  await act(s, cid, { action: 'preferences', memberId: ids[3], dates: [dates[4], dates[5]] });
  await act(s, cid, start(ids));
  for (let i = 0; i < 3; i++) await act(s, cid, { action: 'choose', memberId: ids[i], dates: [dates[i]] });
  await act(s, cid, { action: 'advance' });
  let v = await s.view(cid);
  const target = v.election.reconstruction.candidates.find(
    (entry: any) => entry.action === 'choose' && entry.memberIds.includes(ids[2]),
  );
  assert.ok(target);
  v = await act(s, cid, { action: 'reconstruction_start', historyId: target.id });
  assert.equal(v.awards.length, 2);
  assert.equal(v.election.state.automaticPaused, true);
  assert.equal(v.election.reconstruction.current.memberId, ids[2]);
  v = await act(s, cid, { action: 'reconstruction_step', kind: 'choose', mode: 'manual', dates: [dates[3]] });
  assert.equal(v.election.reconstruction.current.memberId, ids[3]);
  assert.deepEqual(v.election.reconstruction.current.historicalPreference, [dates[4]]);
  v = await act(s, cid, { action: 'reconstruction_step', kind: 'choose', mode: 'preference' });
  assert.equal(v.election.reconstruction.status, 'review');
  assert.equal(v.awards.length, 4);
  v = await act(s, cid, { action: 'reconstruction_finish' });
  assert.equal(v.election.state.automaticPaused, true);
  assert.equal(v.requests.length, 4);
  assert.equal(
    v.requests.find((r: any) => r.member_id === ids[2]).cycle_date,
    dates[2],
    'La solicitud original permanece aunque cambie la adjudicación',
  );
  assert.equal(v.awards.find((r: any) => r.member_id === ids[2]).cycle_date, dates[3]);
});
test('reconstrucción entre administradores permite deshacer y rehacer sin perder datos', async () => {
  const { repo, s, cid, ids, dates } = await fixture();
  const admin = new Service(repo, { id: 'chatgpt:delegate', role: 'team_admin', teams: ['C'] });
  await act(s, cid, start(ids));
  for (let i = 0; i < 4; i++) await act(s, cid, { action: 'choose', memberId: ids[i], dates: [dates[i]] });
  let v = await s.view(cid);
  const target = v.election.reconstruction.candidates.find(
    (e: any) => e.action === 'choose' && e.memberIds.includes(ids[1]),
  );
  v = await act(s, cid, { action: 'reconstruction_start', historyId: target.id });
  assert.equal(v.awards.length, 1);
  v = await act(admin, cid, { action: 'reconstruction_step', kind: 'choose', mode: 'original' });
  v = await act(s, cid, { action: 'reconstruction_step', kind: 'choose', mode: 'manual', dates: [dates[5]] });
  assert.equal(v.awards.length, 3);
  v = await act(admin, cid, { action: 'reconstruction_back' });
  assert.equal(v.awards.length, 2);
  assert.equal(v.election.turn.memberId, ids[2]);
  v = await act(s, cid, { action: 'reconstruction_forward' });
  assert.equal(v.awards.find((a: any) => a.member_id === ids[2]).cycle_date, dates[5]);
  v = await act(admin, cid, { action: 'reconstruction_back' });
  v = await act(admin, cid, { action: 'reconstruction_step', kind: 'choose', mode: 'original' });
  assert.equal(v.election.reconstruction.canForward, false);
  v = await act(s, cid, { action: 'reconstruction_step', kind: 'choose', mode: 'original' });
  assert.equal(v.election.reconstruction.status, 'review');
  v = await act(s, cid, { action: 'reconstruction_finish' });
  assert.equal(v.awards.length, 4);
  assert.equal(v.requests.length, 4);
  assert.equal(v.election.reconstruction.status, 'completed');
});
test('la reconstrucción protege atomicidad y bloqueo por versión ante dos administradores', async () => {
  const { repo, s, cid, ids, dates } = await fixture();
  const admin = new Service(repo, { id: 'chatgpt:delegate', role: 'team_admin', teams: ['C'] });
  await act(s, cid, start(ids));
  for (let i = 0; i < 4; i++) await act(s, cid, { action: 'choose', memberId: ids[i], dates: [dates[i]] });
  const original = await s.view(cid);
  const target = original.election.reconstruction.candidates.find(
    (e: any) => e.action === 'choose' && e.memberIds.includes(ids[1]),
  );
  let v = await act(s, cid, { action: 'reconstruction_start', historyId: target.id });
  await assert.rejects(act(s, cid, { action: 'reconstruction_finish' }), /Quedan turnos/);
  const saved = structuredClone(await s.load(cid));
  await assert.rejects(
    act(admin, cid, { action: 'reconstruction_step', kind: 'choose', mode: 'manual', dates: [dates[0], dates[2]] }),
    /corresponde|válida/i,
  );
  assert.deepEqual(JSON.parse(JSON.stringify(await s.load(cid))), saved);
  const version = v.campaign.version;
  v = await act(admin, cid, { action: 'reconstruction_step', kind: 'choose', mode: 'original' });
  await assert.rejects(
    s.election().mutate(cid, { action: 'reconstruction_back', version }),
    /modificó|Actualiza|cambió/i,
  );
  await assert.rejects(
    act(s, cid, { action: 'choose', memberId: ids[2], dates: [dates[6]] }),
    /congelada|reconstrucción/i,
  );
  v = await act(s, cid, { action: 'reconstruction_cancel' });
  assert.deepEqual(
    v.awards.map((a: any) => a.member_id + '|' + a.cycle_date).sort(),
    original.awards.map((a: any) => a.member_id + '|' + a.cycle_date).sort(),
  );
  assert.equal(v.election.reconstruction.active, false);
});
test('se reconstruyen turnos de dos rondas manteniendo el orden', async () => {
  const { s, cid, ids, dates } = await fixture();
  await act(s, cid, start(ids));
  for (let i = 0; i < 7; i++) await act(s, cid, { action: 'choose', memberId: ids[i % 4], dates: [dates[i]] });
  let v = await s.view(cid);
  const target = v.election.reconstruction.candidates.find(
    (e: any) => e.action === 'choose' && e.memberIds.includes(ids[3]) && e.round === 1,
  );
  v = await act(s, cid, { action: 'reconstruction_start', historyId: target.id });
  assert.equal(v.election.reconstruction.current.round, 1);
  for (let i = 3; i < 7; i++) {
    assert.equal(v.election.reconstruction.current.memberId, ids[i % 4]);
    v = await act(s, cid, { action: 'reconstruction_step', kind: 'choose', mode: 'original' });
  }
  assert.equal(v.election.reconstruction.status, 'review');
  assert.equal(v.election.turn.round, 2);
  v = await act(s, cid, { action: 'reconstruction_finish' });
  assert.equal(v.awards.length, 7);
  assert.equal(v.election.state.automaticPaused, true);
});
test('aplazamientos y elecciones conjuntas se reconstruyen como decisiones indivisibles', async () => {
  const { s, cid, ids, dates } = await fixture();
  await act(s, cid, start(ids));
  await act(s, cid, { action: 'register_joint', round: 1, members: [ids[1], ids[2]] });
  let v = await act(s, cid, { action: 'defer', memberId: ids[0] });
  v = await act(s, cid, {
    action: 'choose_joint',
    entries: [
      { member_id: ids[1], dates: [dates[1]] },
      { member_id: ids[2], dates: [dates[2]] },
    ],
  });
  v = await act(s, cid, { action: 'choose', memberId: ids[3], dates: [dates[3]] });
  const target = v.election.reconstruction.candidates.find((e: any) => e.action === 'defer');
  v = await act(s, cid, { action: 'reconstruction_start', historyId: target.id });
  assert.equal(v.election.reconstruction.current.originalAction, 'defer');
  v = await act(s, cid, { action: 'reconstruction_step', kind: 'defer', mode: 'original' });
  assert.equal(v.election.reconstruction.current.originalAction, 'choose_joint');
  v = await act(s, cid, { action: 'reconstruction_step', kind: 'choose_joint', mode: 'original' });
  assert.equal(v.awards.length, 2);
  v = await act(s, cid, { action: 'reconstruction_back' });
  assert.equal(v.awards.length, 0);
  assert.equal(v.election.reconstruction.current.originalAction, 'choose_joint');
  v = await act(s, cid, { action: 'reconstruction_forward' });
  assert.equal(v.awards.length, 2);
});
test('recupera rama abandonada tras undo y elección alternativa', async () => {
  const { s, cid, ids, dates } = await fixture();
  await act(s, cid, { action: 'preferences', memberId: ids[3], dates: [dates[4]] });
  await act(s, cid, start(ids));
  for (let i = 0; i < 3; i++) await act(s, cid, { action: 'choose', memberId: ids[i], dates: [dates[i]] });
  let v = await act(s, cid, { action: 'advance' });
  const target = v.election.reconstruction.candidates.find(
    (e: any) => e.action === 'choose' && e.memberIds.includes(ids[2]),
  );
  v = await act(s, cid, { action: 'election_undo', historyId: v.election.undo });
  v = await act(s, cid, { action: 'election_undo', historyId: v.election.undo });
  v = await act(s, cid, { action: 'choose', memberId: ids[2], dates: [dates[6]] });
  assert.equal(v.election.redo, null);
  const archived = v.election.reconstruction.candidates.find((e: any) => e.id === target.id);
  assert.equal(archived?.archived, true);
  const branchState = v.awards.map((a: any) => a.member_id + '|' + a.cycle_date).sort();
  v = await act(s, cid, { action: 'reconstruction_start', historyId: target.id });
  assert.equal(v.awards.length, 2);
  v = await act(s, cid, { action: 'reconstruction_step', kind: 'choose', mode: 'manual', dates: [dates[6]] });
  assert.equal(
    v.election.reconstruction.status,
    'active',
    'También debe recuperar la cuarta elección de la rama abandonada',
  );
  v = await act(s, cid, { action: 'reconstruction_step', kind: 'choose', mode: 'preference' });
  assert.equal(v.election.reconstruction.status, 'review');
  assert.equal(v.awards.length, 4);
  v = await act(s, cid, { action: 'reconstruction_cancel' });
  assert.deepEqual(v.awards.map((a: any) => a.member_id + '|' + a.cycle_date).sort(), branchState);
  assert.equal(v.election.reconstruction.active, false);
  assert.ok(v.election.undo);
});

test('reconstrucción guiada reproduce un acuerdo conjunto creado a mitad de ronda', async () => {
  const { s, cid, ids, dates } = await fixture();
  await act(s, cid, start(ids));
  await act(s, cid, { action: 'choose', memberId: ids[0], dates: [dates[0]] });
  await act(s, cid, { action: 'choose', memberId: ids[1], dates: [dates[1]] });
  await act(s, cid, { action: 'register_joint', round: 1, members: [ids[2], ids[3]] });
  await act(s, cid, {
    action: 'choose_joint',
    entries: [
      { member_id: ids[2], dates: [dates[2]] },
      { member_id: ids[3], dates: [dates[3]] },
    ],
  });
  let v = await s.view(cid);
  const target = v.election.reconstruction.candidates.find(
    (entry: any) => entry.action === 'choose' && entry.memberIds.includes(ids[0]),
  );
  assert.ok(target);
  v = await act(s, cid, { action: 'reconstruction_start', historyId: target.id });
  assert.equal(v.election.reconstruction.current.memberId, ids[0]);
  v = await act(s, cid, { action: 'reconstruction_step', kind: 'choose', mode: 'original' });
  v = await act(s, cid, { action: 'reconstruction_step', kind: 'choose', mode: 'original' });
  assert.deepEqual(v.election.reconstruction.current.participants, [ids[2], ids[3]]);
  v = await act(s, cid, { action: 'reconstruction_step', kind: 'choose_joint', mode: 'original' });
  assert.equal(v.election.reconstruction.status, 'review');
  v = await act(s, cid, { action: 'reconstruction_finish' });
  assert.deepEqual(v.election.state.jointAgreements[0].members, [ids[2], ids[3]]);
  assert.equal(v.awards.length, 4);
});
test('reconstruir y deshacer con más de 11 listas de preferencias respeta el límite de parámetros de D1', async () => {
  // Con 9 columnas por preferencia, 12 filas por INSERT daban 108 parámetros y D1 respondía 500.
  const repo = new SQLiteRepo(),
    s = new Service(repo, owner);
  await s.init();
  const cid = (await s.list()).campaigns.find((c) => c.team_id === 'C').id;
  const codes = Array.from({ length: 14 }, (_, i) => 'M' + String(i).padStart(2, '0'));
  let d = await s.view(cid);
  d = await s.mutate(cid, {
    action: 'import_roster',
    version: d.campaign.version,
    source: {
      format: 'vacaciones-roster-v1',
      team: 'C',
      year: 2026,
      copySelections: false,
      rows: codes.map((code) => ({ code, label: 'Ejemplo ' + code, seniority: '' })),
    },
  });
  d = await s.mutate(cid, {
    action: 'config',
    version: d.campaign.version,
    config: {
      ...d.config,
      previousScores: Object.fromEntries(codes.map((c, i) => [c, i * 10])),
      previousScoresSource: 'Puntuaciones históricas del fixture',
    },
  });
  const ids = d.members.map((m: any) => m.id),
    dates = d.result.cycles.map((c: any) => c.date);
  for (const [i, id] of ids.entries())
    await act(s, cid, { action: 'preferences', memberId: id, dates: [dates[(i + 2) % dates.length]] });
  await act(s, cid, start(ids, { automaticPaused: true }));
  await act(s, cid, { action: 'choose', memberId: ids[0], dates: [dates[0]] });
  let v = await s.view(cid);
  assert.ok((await repo.all('SELECT COUNT(*) n FROM preferences WHERE campaign_id=?', [cid]))[0].n >= 12);
  const target = v.election.reconstruction.candidates.find(
    (e: any) => e.action === 'choose' && e.memberIds.includes(ids[0]),
  );
  v = await act(s, cid, { action: 'reconstruction_start', historyId: target.id });
  assert.equal(v.awards.length, 0);
  v = await act(s, cid, { action: 'reconstruction_cancel' });
  assert.equal(v.awards.length, 1);
  v = await act(s, cid, { action: 'election_undo', historyId: v.election.undo });
  assert.equal(v.awards.length, 0);
});
test('la sesión de reconstrucción guarda solo lo necesario de cada decisión original', async () => {
  const { repo, s, cid, ids, dates } = await fixture();
  for (const [i, id] of ids.entries())
    await act(s, cid, { action: 'preferences', memberId: id, dates: [dates[i + 4]] });
  await act(s, cid, start(ids, { automaticPaused: true }));
  for (let i = 0; i < 3; i++) await act(s, cid, { action: 'choose', memberId: ids[i], dates: [dates[i]] });
  let v = await s.view(cid);
  const target = v.election.reconstruction.candidates.find(
    (e: any) => e.action === 'choose' && e.memberIds.includes(ids[0]),
  );
  v = await act(s, cid, { action: 'reconstruction_start', historyId: target.id });
  const session = JSON.parse(
    (await repo.all('SELECT json FROM reconstruction_sessions WHERE campaign_id=?', [cid]))[0].json,
  );
  assert.equal(session.originalEvents.length, 3);
  for (const event of session.originalEvents) {
    assert.equal(event.after.impact, undefined, 'El informe de impacto queda en la auditoría');
    assert.deepEqual(event.before.awards, []);
    assert.deepEqual(
      event.before.preferences.map((p: any) => p.member_id),
      event.participants,
    );
  }
  // The historical preference of the turn being rebuilt is still offered.
  assert.deepEqual(v.election.reconstruction.current.historicalPreference, [dates[4]]);
});

test('reconstrucción: congela la espera en estadísticas y el turno espera desde que termina', async () => {
  const { s, cid, ids, dates } = await fixture();
  await act(s, cid, start(ids));
  await act(s, cid, { action: 'choose', memberId: ids[0], dates: [dates[0]] });
  await act(s, cid, { action: 'choose', memberId: ids[1], dates: [dates[1]] });
  const target = (await s.view(cid)).election.reconstruction.candidates.find((e: { memberIds: string[] }) =>
    e.memberIds.includes(ids[1]),
  );
  await act(s, cid, { action: 'reconstruction_start', historyId: target.id });
  const frozen = await s.election().summary(cid);
  assert.equal(frozen.frozen, true);
  assert.equal(frozen.turn, null);
  assert.equal(frozen.timing?.waiting, null);
  const before = new Date().toISOString();
  await act(s, cid, { action: 'reconstruction_cancel' });
  const after = await s.election().summary(cid);
  assert.equal(after.frozen, false);
  assert.ok(after.timing?.waiting);
  assert.ok(after.timing.waiting.since >= before, 'la espera no incluye la reconstrucción');
});

test('un sorteo que bloqueaba el turno reinicia su reloj', async () => {
  const { s, cid, ids } = await fixture();
  let d = await s.view(cid);
  await s.mutate(cid, {
    action: 'config',
    version: d.campaign.version,
    config: { ...d.config, previousScores: { AA: 10, BB: 10, CC: 30, DD: 40 } },
  });
  d = await s.view(cid);
  await s.election().mutate(cid, { ...start(ids), version: d.campaign.version }, Date.parse('2026-07-01T08:00:00Z'));
  d = await s.view(cid);
  assert.ok(d.election.turn.pendingTie, 'el fixture debe empezar con un empate pendiente');
  const drawn = Date.parse('2026-07-01T15:00:00Z');
  await s
    .election()
    .mutate(
      cid,
      { action: 'resolve_tie', method: 'external', order: d.election.turn.pendingTie, version: d.campaign.version },
      drawn,
    );
  const state = (await s.election().read(cid)).state!;
  assert.equal(state.turnSince?.at, new Date(drawn).toISOString());
});

test('al finalizar una reconstrucción de varios turnos, el reloj marca el turno abierto desde ese momento', async () => {
  const { s, cid, ids, dates } = await fixture();
  await act(s, cid, start(ids));
  for (let i = 0; i < 3; i++) await act(s, cid, { action: 'choose', memberId: ids[i], dates: [dates[i]] });
  const target = (await s.view(cid)).election.reconstruction.candidates.find(
    (e: { action: string; memberIds: string[] }) => e.action === 'choose' && e.memberIds.includes(ids[0]),
  );
  await act(s, cid, { action: 'reconstruction_start', historyId: target.id });
  for (let i = 0; i < 3; i++)
    await act(s, cid, { action: 'reconstruction_step', kind: 'choose', mode: 'manual', dates: [dates[i + 4]] });
  const before = new Date().toISOString();
  await act(s, cid, { action: 'reconstruction_finish' });
  const d = await s.load(cid),
    state = (await s.election().read(cid)).state!;
  const { currentTurn } = await import('../domain/election.ts');
  const open = currentTurn(
    {
      year: d.campaign.year,
      team: d.campaign.team_id,
      config: d.config,
      members: d.members,
      awards: d.awards,
      requests: d.requests,
    },
    state,
  );
  assert.equal(open.memberId, ids[3]);
  assert.equal(state.turnSince?.cursor, open.state.cursor);
  assert.ok(state.turnSince!.at >= before);
});
