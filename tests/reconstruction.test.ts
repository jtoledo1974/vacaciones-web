import { test } from 'node:test';
import { importRoster } from './import-helper.ts';
import assert from 'node:assert/strict';
import { Service } from '../server/service.ts';
import { SQLiteRepo } from './sqlite-repo.ts';
import type { Award } from '../domain/vacations.ts';
import { appliedAudit, eventsFor } from '../server/audit-context.ts';
import { previewCleanup, applyCleanup } from '../server/cleanup.ts';
import { backupManifest, backupPage } from '../server/backup-v2.ts';
import { downloadBackup } from '../lib/backup-v2.mjs';
import { restoreArchive } from '../scripts/restore-backup-v2.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { decodePayload } from '../server/payload-codec.ts';
type HistoryCandidate = {
  kind?: string;
  archived?: boolean;
  id: string;
  cursor: number;
  memberIds: string[];
  choices: Pick<Award, 'member_id' | 'cycle_date'>[];
};
const owner = { id: 'chatgpt:owner', role: 'superadmin' as const, teams: [] };
async function fixture() {
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

async function anticipatedFixture() {
  const f = await fixture();
  const { s, cid, ids, dates } = f;
  await act(s, cid, start(ids));
  for (const index of [1, 2]) {
    await act(s, cid, { action: 'preferences', memberId: ids[index], dates: [dates[index]] });
    await act(s, cid, { action: 'advance' });
  }
  await act(s, cid, { action: 'choose', memberId: ids[0], dates: [dates[0]] });
  const v = await act(s, cid, { action: 'choose', memberId: ids[3], dates: [dates[3]] });
  const target = v.election.reconstruction.candidates.find((e: HistoryCandidate) =>
    e.choices.some((c: Pick<Award, 'member_id'>) => c.member_id === ids[2]),
  );
  return { ...f, original: v, target };
}

async function archivedAnticipatedFixture() {
  const f = await anticipatedFixture();
  const { s, cid, ids, dates, original } = f;
  const target = original.election.reconstruction.candidates.find((e: HistoryCandidate) =>
    e.memberIds.includes(ids[0]),
  );
  let v = await act(s, cid, { action: 'election_undo', historyId: original.election.undo });
  v = await act(s, cid, { action: 'election_undo', historyId: v.election.undo });
  for (let i = 0; i < ids.length; i++)
    v = await act(s, cid, { action: 'choose', memberId: ids[i], dates: [dates[i === 0 ? 4 : i === 1 ? 5 : i]] });
  return { ...f, target, branch: v };
}

test('compactar duplicados y restaurar v2 conserva reconstrucción activa, ida/vuelta, cancelación y undo/redo', async () => {
  const { repo, s, cid, ids, target, branch } = await archivedAnticipatedFixture();
  const dir = mkdtempSync(path.join(tmpdir(), 'vac-reconstruction-v2-'));
  let restored: SQLiteRepo | undefined;
  try {
    await act(s, cid, { action: 'reconstruction_start', historyId: target.id });
    const session = JSON.parse(
      (await repo.all('SELECT json FROM reconstruction_sessions WHERE campaign_id=?', [cid]))[0].json,
    );
    for (const event of session.originalEvents) {
      const [source] = await repo.all('SELECT before_json,after_json FROM audit WHERE id=?', [event.id]);
      const before = JSON.parse(decodePayload(source.before_json)),
        after = JSON.parse(decodePayload(source.after_json));
      Object.assign(event.before, {
        awards: before.awards,
        requests: before.requests,
        preferences: before.preferences,
      });
      if (after.impact) event.after.impact = after.impact;
    }
    await repo.batch([
      { sql: 'UPDATE reconstruction_sessions SET json=? WHERE campaign_id=?', args: [JSON.stringify(session), cid] },
    ]);
    // Compressed audit copies cannot be compared in SQL: compaction refuses, changing nothing.
    const refused = await previewCleanup(repo, owner, Date.now(), 'compact-reconstruction-events');
    assert.equal(refused.plan.categories[0].rows, 0);
    // The history conversion compacts while audit is still plain JSON (ADR 0001).
    for (const event of session.originalEvents) {
      const [source] = await repo.all('SELECT before_json,after_json FROM audit WHERE id=?', [event.id]);
      await repo.batch([
        {
          sql: 'UPDATE audit SET before_json=?,after_json=? WHERE id=?',
          args: [decodePayload(source.before_json), decodePayload(source.after_json), event.id],
        },
      ]);
    }
    const before = await s.view(cid);
    const preview = await previewCleanup(repo, owner, Date.now(), 'compact-reconstruction-events');
    assert.equal(preview.plan.categories[0].rows, 1);
    await applyCleanup(repo, owner, { mode: preview.plan.mode, cutoff: preview.plan.cutoff, token: preview.token });
    assert.deepEqual(await s.view(cid), before);
    const records: unknown[] = [];
    await downloadBackup(
      async (method: string, _route: string, body: unknown) =>
        method === 'GET' ? backupManifest(repo, owner) : backupPage(repo, owner, body),
      async (line: string) => {
        records.push(JSON.parse(line));
      },
    );
    const file = path.join(dir, 'restored.sqlite');
    await restoreArchive(
      (async function* () {
        yield* records;
      })(),
      file,
    );
    restored = new SQLiteRepo();
    restored.db.close();
    restored.db = new DatabaseSync(file);
    restored.db.exec('PRAGMA foreign_keys=ON');
    const recovered = new Service(restored, owner);
    assert.deepEqual(await recovered.view(cid), await s.view(cid));
    const currentMember = (view: Awaited<ReturnType<Service['view']>>) => {
      const reconstruction = view.election.reconstruction;
      assert.ok('current' in reconstruction);
      assert.ok(reconstruction.current);
      return reconstruction.current.memberId;
    };
    let v = await act(recovered, cid, { action: 'reconstruction_step', kind: 'choose', mode: 'original' });
    assert.equal(currentMember(v), ids[1]);
    v = await act(recovered, cid, { action: 'reconstruction_back' });
    assert.equal(currentMember(v), ids[0]);
    v = await act(recovered, cid, { action: 'reconstruction_forward' });
    assert.equal(currentMember(v), ids[1]);
    v = await act(recovered, cid, { action: 'reconstruction_cancel' });
    assert.deepEqual(v.awards, branch.awards);
    v = await act(recovered, cid, { action: 'election_undo', historyId: v.election.undo });
    v = await act(recovered, cid, { action: 'election_redo', historyId: v.election.redo });
    assert.deepEqual(v.awards, branch.awards);
  } finally {
    restored?.db.close();
    repo.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('una rama archivada revisa las anticipadas posteriores y no deja adjudicaciones sin historial', async () => {
  const { s, cid, ids, dates, target, branch } = await archivedAnticipatedFixture();
  let v = await act(s, cid, { action: 'reconstruction_start', historyId: target.id });
  assert.equal(v.awards.length, 0, 'retira también las anticipadas presentes en la instantánea archivada');
  for (let i = 0; i < ids.length; i++) {
    assert.equal(v.election.reconstruction.current.memberId, ids[i], 'no salta a nadie');
    v = await act(s, cid, {
      action: 'reconstruction_step',
      kind: 'choose',
      mode: i === 1 ? 'manual' : 'original',
      ...(i === 1 ? { dates: [dates[5]] } : {}),
    });
  }
  v = await act(s, cid, { action: 'reconstruction_finish' });
  assert.equal(v.election.timeline.filter((e: HistoryCandidate) => e.kind === 'legacy').length, 0);
  assert.equal(v.awards.find((a: Award) => a.member_id === ids[1]).cycle_date, dates[5]);
  assert.equal(v.awards.length, branch.awards.length);
  const next = v.election.reconstruction.candidates.find(
    (e: HistoryCandidate) => !e.archived && e.memberIds.includes(ids[0]),
  );
  v = await act(s, cid, { action: 'reconstruction_start', historyId: next.id });
  for (let i = 0; i < ids.length; i++) {
    assert.equal(v.election.reconstruction.current.memberId, ids[i]);
    v = await act(s, cid, { action: 'reconstruction_step', kind: 'choose', mode: 'original' });
  }
  v = await act(s, cid, { action: 'reconstruction_finish' });
  assert.equal(v.awards.find((a: Award) => a.member_id === ids[1]).cycle_date, dates[5]);
  assert.equal(
    v.election.timeline.some((e: HistoryCandidate) => e.kind === 'legacy'),
    false,
  );
});

test('cancelar la recuperación de una rama con anticipadas restaura IDs e historial exactos', async () => {
  const { s, cid, ids, target, branch } = await archivedAnticipatedFixture();
  const history = branch.election.timeline;
  let v = await act(s, cid, { action: 'reconstruction_start', historyId: target.id });
  v = await act(s, cid, { action: 'reconstruction_step', kind: 'choose', mode: 'original' });
  assert.equal(v.election.reconstruction.current.memberId, ids[1]);
  v = await act(s, cid, { action: 'reconstruction_back' });
  assert.equal(v.election.reconstruction.current.memberId, ids[0]);
  v = await act(s, cid, { action: 'reconstruction_forward' });
  assert.equal(v.election.reconstruction.current.memberId, ids[1]);
  v = await act(s, cid, { action: 'reconstruction_cancel' });
  assert.deepEqual(v.awards, branch.awards);
  assert.deepEqual(v.election.timeline, history);
  assert.equal(v.election.undo, branch.election.undo);
});

test('recuperar una anticipada archivada retira la elección distinta que hoy ocupa su turno', async () => {
  const { s, cid, ids, dates, original, branch } = await archivedAnticipatedFixture();
  const target = original.election.reconstruction.candidates.find((e: HistoryCandidate) =>
    e.memberIds.includes(ids[1]),
  );
  let v = await act(s, cid, { action: 'reconstruction_start', historyId: target.id });
  assert.equal(v.election.reconstruction.current.memberId, ids[1]);
  assert.deepEqual(v.election.reconstruction.current.originalChoice[0].dates, [dates[1]]);
  assert.equal(
    v.awards.some((a: Award) => a.member_id === ids[1]),
    false,
  );
  assert.deepEqual(
    v.awards.filter((a: Award) => a.member_id === ids[0]),
    branch.awards.filter((a: Award) => a.member_id === ids[0]),
  );
  v = await act(s, cid, { action: 'reconstruction_step', kind: 'choose', mode: 'original' });
  assert.equal(v.awards.find((a: Award) => a.member_id === ids[1]).cycle_date, dates[1]);
  v = await act(s, cid, { action: 'reconstruction_cancel' });
  assert.deepEqual(v.awards, branch.awards);
});

test('reconstruir un estado antiguo recupera los eventos de anticipadas vivas que habían quedado archivados', async () => {
  const { s, repo, cid, ids, original } = await anticipatedFixture();
  const rows = await eventsFor(repo, cid);
  const done = appliedAudit(rows).done;
  const removed = original.election.reconstruction.candidates
    .filter((e: HistoryCandidate) => [ids[1], ids[2]].some((id) => e.memberIds.includes(id)))
    .map((e: HistoryCandidate) => e.id);
  // Persist the inconsistency left by older versions: awards and state are live,
  // but the completed reconstruction removed their early decision events.
  await repo.batch([
    {
      sql: 'INSERT INTO audit(id,campaign_id,actor,action,before_json,after_json,created_at) VALUES(?,?,?,?,NULL,?,?)',
      args: [
        crypto.randomUUID(),
        cid,
        owner.id,
        'reconstruction_start',
        JSON.stringify({
          retainedIds: done.filter((e: HistoryCandidate) => !removed.includes(e.id)).map((e: HistoryCandidate) => e.id),
        }),
        new Date().toISOString(),
      ],
    },
  ]);
  let v = await s.view(cid);
  assert.equal(v.election.timeline.filter((e: HistoryCandidate) => e.kind === 'legacy').length, 2);
  const target = v.election.reconstruction.candidates.find(
    (e: HistoryCandidate) => !e.archived && e.memberIds.includes(ids[3]),
  );
  v = await act(s, cid, { action: 'reconstruction_start', historyId: target.id });
  assert.equal(v.election.reconstruction.current.memberId, ids[3]);
  v = await act(s, cid, { action: 'reconstruction_step', kind: 'choose', mode: 'original' });
  v = await act(s, cid, { action: 'reconstruction_finish' });
  assert.deepEqual(
    v.awards.map((a: Award) => [a.member_id, a.cycle_date]).sort(),
    original.awards.map((a: Award) => [a.member_id, a.cycle_date]).sort(),
  );
  assert.equal(
    v.election.timeline.some((e: HistoryCandidate) => e.kind === 'legacy'),
    false,
  );
});

test('reconstruir una anticipada ya confirmada empieza en su turno y conserva ambos predecesores', async () => {
  const { s, cid, ids, dates, original, target } = await anticipatedFixture();
  assert.deepEqual(target.memberIds, [ids[2]], 'el candidato nombra al adjudicatario, no al turno abierto');
  assert.equal(target.cursor, 2);
  let v = await act(s, cid, { action: 'reconstruction_start', historyId: target.id });
  assert.equal(v.election.reconstruction.current.memberId, ids[2]);
  assert.equal(v.election.state.cursor, 2);
  assert.deepEqual(
    v.awards.map((a: Award) => a.id).sort(),
    original.awards
      .filter((a: Award) => ids.slice(0, 2).includes(a.member_id))
      .map((a: Award) => a.id)
      .sort(),
  );
  assert.deepEqual(v.election.reconstruction.current.originalChoice[0].dates, [dates[2]]);
  v = await act(s, cid, { action: 'reconstruction_step', kind: 'choose', mode: 'manual', dates: [dates[5]] });
  assert.equal(v.election.reconstruction.current.memberId, ids[3]);
  v = await act(s, cid, { action: 'reconstruction_step', kind: 'choose', mode: 'original' });
  v = await act(s, cid, { action: 'reconstruction_finish' });
  assert.equal(v.awards.length, 4);
  assert.equal(v.awards.find((a: Award) => a.member_id === ids[2]).cycle_date, dates[5]);
  assert.deepEqual(
    v.requests.map((r: Pick<Award, 'member_id' | 'cycle_date'>) => [r.member_id, r.cycle_date]).sort(),
    v.awards.map((a: Award) => [a.member_id, a.cycle_date]).sort(),
    'las peticiones provisionales siguen la elección reconstruida',
  );
  assert.ok(v.election.timeline.some((e: HistoryCandidate) => e.choices.some((a: Award) => a.member_id === ids[0])));
  assert.ok(v.election.timeline.some((e: HistoryCandidate) => e.choices.some((a: Award) => a.member_id === ids[1])));
});

test('una anticipada sin evento recuperable bloquea el retroceso sin modificar datos', async () => {
  const { s, repo, cid, ids, original } = await anticipatedFixture();
  const target = original.election.reconstruction.candidates.find((e: HistoryCandidate) =>
    e.memberIds.includes(ids[3]),
  );
  const missing = original.election.reconstruction.candidates.find((e: HistoryCandidate) =>
    e.memberIds.includes(ids[1]),
  );
  // Simulate a damaged historical export whose early event lost its payload.
  await repo.batch([
    { sql: 'UPDATE audit SET after_json=? WHERE id=?', args: [JSON.stringify({ choices: [] }), missing.id] },
  ]);
  const before = await s.load(cid);
  const stateBefore = await repo.all('SELECT * FROM election_states WHERE campaign_id=?', [cid]);
  await assert.rejects(act(s, cid, { action: 'reconstruction_start', historyId: target.id }), /sin historial/);
  assert.deepEqual(await s.load(cid), before);
  assert.deepEqual(await repo.all('SELECT * FROM election_states WHERE campaign_id=?', [cid]), stateBefore);
  assert.deepEqual(await repo.all('SELECT * FROM reconstruction_sessions WHERE campaign_id=?', [cid]), []);
});

test('finalizar rechaza una sesión antigua que perdería la trazabilidad y permite cancelarla', async () => {
  const { s, repo, cid, ids, original } = await anticipatedFixture();
  const target = original.election.reconstruction.candidates.find((e: HistoryCandidate) =>
    e.memberIds.includes(ids[3]),
  );
  const missing = original.election.reconstruction.candidates.find((e: HistoryCandidate) =>
    e.memberIds.includes(ids[1]),
  );
  await act(s, cid, { action: 'reconstruction_start', historyId: target.id });
  await act(s, cid, { action: 'reconstruction_step', kind: 'choose', mode: 'original' });
  // An old session may already have an inconsistent retained prefix.
  const rows = await eventsFor(repo, cid);
  const effective = appliedAudit(rows).done;
  await repo.batch([
    {
      sql: 'INSERT INTO audit(id,campaign_id,actor,action,before_json,after_json,created_at) VALUES(?,?,?,?,NULL,?,?)',
      args: [
        crypto.randomUUID(),
        cid,
        owner.id,
        'reconstruction_start',
        JSON.stringify({
          retainedIds: effective.filter((e: { id: string }) => e.id !== missing.id).map((e: { id: string }) => e.id),
        }),
        new Date().toISOString(),
      ],
    },
  ]);
  const before = await s.load(cid);
  const session = await repo.all('SELECT * FROM reconstruction_sessions WHERE campaign_id=?', [cid]);
  await assert.rejects(act(s, cid, { action: 'reconstruction_finish' }), /sin historial/);
  assert.deepEqual(await s.load(cid), before);
  assert.deepEqual(await repo.all('SELECT * FROM reconstruction_sessions WHERE campaign_id=?', [cid]), session);
  const cancelled = await act(s, cid, { action: 'reconstruction_cancel' });
  assert.equal(cancelled.election.reconstruction.active, false);
  assert.deepEqual(cancelled.awards, original.awards);
});

test('cancelar una reconstrucción lógica restaura adjudicaciones, auditoría vigente y undo/redo', async () => {
  const { s, cid, ids, dates, original, target } = await anticipatedFixture();
  await act(s, cid, { action: 'reconstruction_start', historyId: target.id });
  await act(s, cid, { action: 'reconstruction_step', kind: 'choose', mode: 'manual', dates: [dates[6]] });
  const v = await act(s, cid, { action: 'reconstruction_cancel' });
  assert.deepEqual(v.awards, original.awards);
  assert.deepEqual(v.requests, original.requests);
  assert.deepEqual(v.election.timeline, original.election.timeline);
  assert.equal(v.election.undo, original.election.undo);
  const undone = await act(s, cid, { action: 'election_undo', historyId: v.election.undo });
  assert.equal(undone.election.turn.memberId, ids[3]);
  const redone = await act(s, cid, { action: 'election_redo', historyId: undone.election.redo });
  assert.deepEqual(redone.awards, original.awards);
});

test('undo y redo de un predecesor conservado no resucitan la anticipada que se corrigió después', async () => {
  const { s, cid, ids, dates, target } = await anticipatedFixture();
  await act(s, cid, { action: 'reconstruction_start', historyId: target.id });
  await act(s, cid, { action: 'reconstruction_step', kind: 'choose', mode: 'manual', dates: [dates[5]] });
  await act(s, cid, { action: 'reconstruction_step', kind: 'choose', mode: 'original' });
  let v = await act(s, cid, { action: 'reconstruction_finish' });
  const corrected = v.awards;
  const predecessor = v.election.reconstruction.candidates.find((entry: HistoryCandidate) =>
    entry.memberIds.includes(ids[0]),
  );
  await act(s, cid, { action: 'reconstruction_start', historyId: predecessor.id });
  v = await act(s, cid, { action: 'reconstruction_cancel' });
  for (let i = 0; i < 3; i++) v = await act(s, cid, { action: 'election_undo', historyId: v.election.undo });
  assert.equal(
    (await s.load(cid)).awards.some((a: Award) => a.member_id === ids[2]),
    false,
  );
  for (let i = 0; i < 3; i++) v = await act(s, cid, { action: 'election_redo', historyId: v.election.redo });
  assert.deepEqual(v.awards, corrected);
});

test('reconstruir de nuevo desde un predecesor no resucita la antigua anticipada', async () => {
  const { s, cid, ids, dates, target } = await anticipatedFixture();
  await act(s, cid, { action: 'reconstruction_start', historyId: target.id });
  await act(s, cid, { action: 'reconstruction_step', kind: 'choose', mode: 'manual', dates: [dates[5]] });
  await act(s, cid, { action: 'reconstruction_step', kind: 'choose', mode: 'original' });
  let v = await act(s, cid, { action: 'reconstruction_finish' });
  const predecessor = v.election.reconstruction.candidates.find((e: HistoryCandidate) => e.memberIds.includes(ids[0]));
  v = await act(s, cid, { action: 'reconstruction_start', historyId: predecessor.id });
  assert.equal(v.awards.length, 0);
  for (let i = 0; i < 4; i++) {
    assert.equal(v.election.reconstruction.current.memberId, ids[i]);
    v = await act(s, cid, { action: 'reconstruction_step', kind: 'choose', mode: 'original' });
  }
  v = await act(s, cid, { action: 'reconstruction_finish' });
  assert.equal(v.awards.length, 4);
  assert.equal(v.awards.find((a: Award) => a.member_id === ids[2]).cycle_date, dates[5]);
});
test('las anticipadas parciales se reconstruyen en un turno completo con todos sus créditos aplazados', async () => {
  const { s, cid, ids, dates } = await fixture();
  await act(s, cid, start(ids));
  await act(s, cid, { action: 'choose', memberId: ids[0], dates: [dates[0]] });
  for (const index of [1, 2]) await act(s, cid, { action: 'defer', memberId: ids[index] });
  await act(s, cid, { action: 'choose', memberId: ids[3], dates: [dates[3]] });
  for (const [index, choices] of [
    [1, [dates[4], dates[5]]],
    [2, [dates[7], dates[8]]],
  ] as [number, string[]][]) {
    await act(s, cid, { action: 'preferences', memberId: ids[index], dates: choices });
    await act(s, cid, { action: 'advance' });
    await act(s, cid, { action: 'advance' });
  }
  await act(s, cid, { action: 'choose', memberId: ids[0], dates: [dates[6]] });
  let v = await act(s, cid, { action: 'choose', memberId: ids[3], dates: [dates[9]] });
  const target = v.election.reconstruction.candidates.find((e: HistoryCandidate) => e.cursor === 5);
  v = await act(s, cid, { action: 'reconstruction_start', historyId: target.id });
  assert.equal(v.election.reconstruction.current.memberId, ids[1]);
  assert.equal(v.election.reconstruction.current.needed, 2);
  assert.deepEqual(v.election.reconstruction.current.originalChoice[0].dates, [dates[4], dates[5]]);
  v = await act(s, cid, { action: 'reconstruction_step', kind: 'choose', mode: 'original' });
  assert.equal(v.election.reconstruction.current.memberId, ids[2]);
  assert.equal(v.election.reconstruction.current.needed, 2);
  v = await act(s, cid, { action: 'reconstruction_step', kind: 'choose', mode: 'original' });
  v = await act(s, cid, { action: 'reconstruction_step', kind: 'choose', mode: 'original' });
  assert.equal(v.election.reconstruction.status, 'review');
  assert.equal(v.awards.length, 8);
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
    dates[3],
    'La petición provisional cambia con la adjudicación antes del cierre',
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
  d = await importRoster(s, cid, {
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
