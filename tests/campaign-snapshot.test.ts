import { test } from 'node:test';
import { importRoster } from './import-helper.ts';
import assert from 'node:assert/strict';
import { Service } from '../server/service.ts';
import { cas } from '../server/repository.ts';
import { capture, captureVacations, restoreStatements, validateSnapshot } from '../server/campaign-snapshot.ts';
import { ELECTION_UNDO_FORMAT, VACATIONS_UNDO_FORMAT } from '../domain/events.ts';
import { SQLiteRepo } from './sqlite-repo.ts';
const owner = { id: 'chatgpt:owner', role: 'superadmin' as const, teams: [] };
async function setup() {
  const repo = new SQLiteRepo(),
    s = new Service(repo, owner);
  await s.init();
  const cid = (await s.list()).campaigns.find((c) => c.team_id === 'C').id;
  let d = await s.view(cid);
  d = await importRoster(s, cid, {
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
  return { repo, s, cid, d };
}
const act = async (s: Service, cid: string, body: Record<string, unknown>) =>
  s.election().mutate(cid, { ...body, version: (await s.load(cid)).campaign.version });
// Every restorable row, ordered, as stored.
async function rows(repo: SQLiteRepo, cid: string) {
  return {
    awards: await repo.all('SELECT * FROM awards WHERE campaign_id=? ORDER BY id', [cid]),
    requests: await repo.all('SELECT * FROM requests WHERE campaign_id=? ORDER BY id', [cid]),
    preferences: await repo.all('SELECT * FROM preferences WHERE campaign_id=? ORDER BY member_id', [cid]),
    state: await repo.all('SELECT json FROM election_states WHERE campaign_id=?', [cid]),
  };
}
async function chosen() {
  const ctx = await setup(),
    { s, cid, d } = ctx,
    [a, b] = d.members,
    dates = d.result.cycles.map((c: { date: string }) => c.date);
  await act(s, cid, { action: 'preferences', memberId: b.id, dates: [dates[1]] });
  await act(s, cid, {
    action: 'start',
    order: d.members.map((m: { id: string }) => m.id),
    source: 'Orden de ensayo',
    rulesConfirmed: true,
    allowDeferral: true,
  });
  await act(s, cid, { action: 'choose', memberId: a.id, dates: [dates[0]] });
  return { ...ctx, dates };
}

test('capturar y restaurar deja el mismo estado', async () => {
  const { repo, s, cid } = await chosen(),
    before = await rows(repo, cid),
    snapshot = capture(await s.load(cid), await s.election().read(cid));
  assert.equal(snapshot.format, ELECTION_UNDO_FORMAT);
  await repo.batch(restoreStatements(cid, { awards: [], requests: [], preferences: [], state: null }));
  assert.equal((await rows(repo, cid)).awards.length, 0);
  await repo.batch(restoreStatements(cid, validateSnapshot(JSON.parse(JSON.stringify(snapshot)))!));
  assert.deepEqual(await rows(repo, cid), before);
});

test('restaurar la copia del deshacer coincide con el deshacer de la elección', async () => {
  const { repo, s, cid } = await chosen(),
    view = await s.view(cid),
    [entry] = await repo.all('SELECT before_json FROM audit WHERE id=?', [view.election.undo]);
  await act(s, cid, { action: 'election_undo', historyId: view.election.undo });
  const undone = await rows(repo, cid),
    prior = validateSnapshot(JSON.parse(entry.before_json))!;
  assert.deepEqual(
    undone.awards.map((a: { id: string }) => a.id).sort(),
    prior.awards.map((a: { id: string }) => a.id).sort(),
  );
  assert.deepEqual(
    undone.requests.map((r: { id: string }) => r.id).sort(),
    prior.requests!.map((r: { id: string }) => r.id).sort(),
  );
  // Undo restores the snapshot's state, paused for the recovered turn.
  assert.deepEqual(JSON.parse(undone.state[0].json), { ...prior.state, automaticPaused: true });
});

test('las instantáneas antiguas siguen restaurándose', async () => {
  const { repo, s, cid } = await chosen(),
    d = await s.load(cid),
    election = await s.election().read(cid),
    before = await rows(repo, cid);
  // An election snapshot written before requests existed leaves requests as they are.
  const { requests: _requests, ...legacy } = capture(d, election);
  void _requests;
  const old = validateSnapshot(legacy, ELECTION_UNDO_FORMAT)!;
  assert.equal(old.requests, undefined);
  await repo.batch(restoreStatements(cid, old));
  assert.deepEqual(await rows(repo, cid), before);
  // A vacations snapshot with its election, and an older one without format or election.
  const vacations = JSON.parse(JSON.stringify(captureVacations(d, election)));
  assert.equal(vacations.format, VACATIONS_UNDO_FORMAT);
  await repo.batch(restoreStatements(cid, { awards: [], requests: [], preferences: [], state: null }));
  await repo.batch(restoreStatements(cid, validateSnapshot(vacations)!));
  assert.deepEqual(await rows(repo, cid), before);
  const bare = validateSnapshot({ awards: d.awards, requests: d.requests }, VACATIONS_UNDO_FORMAT)!;
  assert.equal(bare.preferences, undefined);
  assert.equal(bare.state, undefined);
  await repo.batch(restoreStatements(cid, { awards: [], requests: [] }));
  await repo.batch(restoreStatements(cid, bare));
  assert.deepEqual(await rows(repo, cid), before);
  assert.equal(validateSnapshot({ awards: 'x' }, VACATIONS_UNDO_FORMAT), null);
  assert.equal(validateSnapshot({ awards: [] }, VACATIONS_UNDO_FORMAT), null);
  assert.equal(validateSnapshot({ awards: [], requests: [] }, 'unknown-v1'), null);
});

test('un conflicto de CAS deja todo intacto', async () => {
  const { repo, s, cid } = await chosen(),
    before = await rows(repo, cid),
    version = (await s.load(cid)).campaign.version;
  await assert.rejects(
    repo.batch([
      ...cas(cid, version - 1),
      ...restoreStatements(cid, { awards: [], requests: [], preferences: [], state: null }),
    ]),
  );
  assert.deepEqual(await rows(repo, cid), before);
  assert.equal((await s.load(cid)).campaign.version, version);
});

test('las copias malformadas no se restauran', () => {
  const award = { id: 'a1', member_id: 'm1', cycle_date: '2026-01-01', version: 1 },
    request = { ...award, id: 'r1', slot: 1 },
    preference = { member_id: 'm1', dates: [] };
  const election = (patch: object) =>
    validateSnapshot(
      { awards: [award], requests: [request], preferences: [preference], state: null, ...patch },
      ELECTION_UNDO_FORMAT,
    );
  assert.ok(election({}));
  assert.equal(election({ awards: [{ ...award, id: undefined }] }), null);
  assert.equal(election({ awards: [{ ...award, version: '1' }] }), null);
  assert.equal(election({ requests: [{ ...request, slot: null }] }), null);
  assert.equal(election({ preferences: [{ member_id: 'm1' }] }), null);
  assert.equal(election({ state: 'activo' }), null);
  const vacations = (patch: object) =>
    validateSnapshot({ awards: [award], requests: [request], ...patch }, VACATIONS_UNDO_FORMAT);
  assert.ok(vacations({ election: { state: null, preferences: [preference] } }));
  assert.equal(vacations({ requests: [null] }), null);
  assert.equal(vacations({ election: { state: null, preferences: [{ dates: [] }] } }), null);
  assert.equal(vacations({ election: { state: 7, preferences: [] } }), null);
});

test('deshacer y rehacer vacaciones restauran filas, preferencias y estado de la elección', async () => {
  const { repo, s, cid } = await chosen();
  await act(s, cid, { action: 'pause' });
  const before = await rows(repo, cid);
  assert.ok(before.awards.length && before.preferences.length && before.state.length);
  let v = await s.view(cid);
  v = await s.mutate(cid, { action: 'delete_award', id: v.awards[0].id, version: v.campaign.version });
  const after = await rows(repo, cid);
  assert.notDeepEqual(after.awards, before.awards);
  v = await s.mutate(cid, { action: 'undo_vacations', version: v.campaign.version, undoId: v.undo.id });
  assert.deepEqual(await rows(repo, cid), before);
  await s.mutate(cid, { action: 'redo_vacations', version: v.campaign.version, undoId: v.redo.id });
  assert.deepEqual(await rows(repo, cid), after);
});

test('la reconstrucción restaura con el módulo al empezar, retroceder y cancelar', async () => {
  const { repo, s, cid, dates } = await chosen();
  // The second member's list may already have chosen; the next turn chooses by hand.
  const turn = (await s.view(cid)).election.turn.memberId;
  await act(s, cid, { action: 'choose', memberId: turn, dates: [dates[2]] });
  const original = await rows(repo, cid),
    target = (await s.view(cid)).election.reconstruction.candidates.find(
      (e: { action: string; memberIds: string[] }) => e.action === 'choose' && e.memberIds.includes(turn),
    );
  assert.ok(target);
  await act(s, cid, { action: 'reconstruction_start', historyId: target.id });
  const started = await rows(repo, cid);
  assert.ok(started.awards.length < original.awards.length);
  await act(s, cid, { action: 'reconstruction_step', kind: 'choose', mode: 'manual', dates: [dates[3]] });
  await act(s, cid, { action: 'reconstruction_back' });
  assert.deepEqual(await rows(repo, cid), started);
  const cancelledAt = new Date().toISOString();
  await act(s, cid, { action: 'reconstruction_cancel' });
  // Everything comes back as it was, except that the open turn waits from the cancellation.
  const restored = await rows(repo, cid);
  const clock = (r: typeof restored) => r.state.map((row: { json: string }) => JSON.parse(row.json).turnSince);
  assert.ok(clock(restored).every((since: { at: string } | undefined) => !since || since.at >= cancelledAt));
  const strip = (r: typeof restored) => ({
    ...r,
    state: r.state.map((row: { json: string }) => ({ ...JSON.parse(row.json), turnSince: undefined })),
  });
  assert.deepEqual(strip(restored), strip(original));
});

test('restaurar desde instantánea migra versión y descarta elecciones anticipadas huérfanas', async () => {
  const { repo, s, cid } = await chosen();
  const snapshot = capture(await s.load(cid), await s.election().read(cid));
  const validId = snapshot.awards[0].id;
  const state = {
    ...snapshot.state!,
    format: undefined,
    earlyChoices: [
      {
        memberId: snapshot.awards[0].member_id,
        round: 1,
        cursor: 0,
        awardId: validId,
        at: '2026-01-01T00:00:00Z',
      },
      {
        memberId: snapshot.awards[0].member_id,
        round: 1,
        cursor: 1,
        awardId: 'eliminada',
        at: '2026-01-01T00:00:00Z',
      },
    ],
  };
  const before = { ...snapshot, state };
  const restored = validateSnapshot(before)!;
  assert.equal(restored.state?.format, 1);
  assert.deepEqual(
    restored.state?.earlyChoices?.map((choice) => choice.awardId),
    [validId],
  );
  await repo.batch(restoreStatements(cid, { ...before, state }));
  const stored = await s.election().read(cid);
  assert.equal(stored.state?.format, 1);
  assert.deepEqual(
    stored.state?.earlyChoices?.map((choice) => choice.awardId),
    [validId],
  );
});
