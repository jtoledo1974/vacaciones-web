import { createHash } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteRepo } from './sqlite-repo.ts';
import { Service } from '../server/service.ts';
import { backupColumns } from '../server/backup-v2.ts';
import { tableColumns } from '../server/repository.ts';
import { compactableSessionSQL } from '../server/reconstruction-compaction.ts';
import { checkedConfig } from '../server/service-commands.ts';
import { previewCleanup } from '../server/cleanup.ts';
import { assertAnnualScoringConfig } from '../domain/scoring.ts';
import { defaultConfig } from '../domain/defaults.ts';
import { compressPayload, decodePayload } from '../server/payload-codec.ts';
import type { Principal } from '../server/permissions.ts';

type Row = Record<string, string | null>;
type Copy = { payload: { tables: Record<string, Row[]> } };

const superuser: Principal = { id: 'chatgpt:owner', role: 'superadmin', teams: [] };

async function setup() {
  const repo = new SQLiteRepo(),
    s = new Service(repo, superuser);
  await s.init();
  const cid = (await s.list()).campaigns.find((c: { team_id: string; id: string }) => c.team_id === 'C').id;
  return { repo, s, cid };
}

// The v1 copy must survive the JSON round trip the web form and the CLI
// give it, with the history compressed (ADR 0001), and leave undo working afterwards.
test('la copia v1 con historial comprimido se restaura tal cual, también en otra base, y el deshacer sigue funcionando', async () => {
  const { repo, s, cid } = await setup();
  let d = await s.view(cid);
  await s.mutate(cid, {
    action: 'request',
    version: d.campaign.version,
    memberId: d.members[0].id,
    slot: 1,
    date: d.result.cycles[0].date,
  });
  d = await s.view(cid);
  await s.mutate(cid, { action: 'reset_vacations', version: d.campaign.version, confirmation: `C-${d.campaign.year}` });
  for (const row of repo.db.prepare('SELECT id,before_json,after_json FROM audit').all() as Row[])
    repo.db
      .prepare('UPDATE audit SET before_json=?, after_json=? WHERE id=?')
      .run(
        row.before_json && compressPayload(decodePayload(row.before_json)),
        row.after_json && compressPayload(decodePayload(row.after_json)),
        row.id,
      );
  const compressed = (await s.backup()).payload.tables.audit.filter((r) => r.before_json?.startsWith('gz1:'));
  assert.ok(compressed.length > 0, 'la copia v1 lleva el historial comprimido');

  // What reaches the server is what the browser or the CLI parsed from a file.
  const file = JSON.parse(JSON.stringify(await s.backup()));

  // Another empty database, as when recovering from a copy.
  const other = new SQLiteRepo(),
    restored = new Service(other, superuser);
  await restored.init();
  await restored.restore(file, (await restored.admin()).revision);
  // Restoring leaves its own audit entry; everything else must come back identical.
  const plain = (b: Copy, name: string) =>
    JSON.parse(JSON.stringify(b.payload.tables[name])).filter((r: Row) => name !== 'audit' || r.action !== 'restore');
  const again = await restored.backup();
  for (const name of Object.keys(file.payload.tables).filter((n) => n !== 'sessions'))
    assert.deepEqual(plain(again, name), plain(file, name), name);

  // The restored history is readable and the pending undo still applies.
  const view = await restored.view(cid);
  assert.equal(view.undo.action, 'reset_vacations');
  const undone = await restored.mutate(cid, {
    action: 'undo_vacations',
    version: view.campaign.version,
    undoId: view.undo.id,
  });
  assert.equal(undone.requests.length, 1);

  // And over the same database that produced the copy.
  await s.restore(file, (await s.admin()).revision);
  assert.deepEqual(plain(await s.backup(), 'audit'), plain(file, 'audit'));
});

// v2 stays the main copy because of this gap: v1 neither saves these tables nor rolls them back.
test('la copia v1 no cubre las tablas exclusivas de la v2 y restaurarla no las recupera ni las revierte', async () => {
  const { repo, s, cid } = await setup();
  const omitted = Object.keys(backupColumns).filter((name) => !Object.hasOwn(tableColumns, name));
  assert.deepEqual(omitted.sort(), [
    'app_state',
    'hr_templates',
    'personal_simulations',
    'push_deliveries',
    'push_subscriptions',
    'turn_notifications',
  ]);
  const count = (db: SQLiteRepo) =>
    (db.db.prepare('SELECT count(*) AS n FROM personal_simulations').get() as { n: number }).n;
  const draft = (owner: string) =>
    repo.db
      .prepare('INSERT INTO personal_simulations(owner_key,campaign_id,member_id,json,updated_at) VALUES(?,?,?,?,?)')
      .run(owner, cid, 'member', '{}', '2026-11-05');
  draft('owner');

  const file = JSON.parse(JSON.stringify(await s.backup()));
  for (const name of omitted) assert.equal(file.payload.tables[name], undefined, name);

  // Not recovered on a new database.
  const other = new SQLiteRepo(),
    restored = new Service(other, superuser);
  await restored.init();
  await restored.restore(file, (await restored.admin()).revision);
  assert.equal(count(other), 0);

  // Not rolled back on the original one: a row added after the copy stays.
  draft('later');
  await s.restore(file, (await s.admin()).revision);
  assert.equal(count(repo), 2);
});

// Production holds 2027 parameters saved before the annual scoring became read-only.
test('la copia v1 con un baremo 2027 anterior se restaura tal cual, pero no se puede volver a guardar', async () => {
  const { repo, s, cid } = await setup();
  const year = 2027;
  repo.db.prepare('UPDATE campaigns SET year=? WHERE id=?').run(year, cid);

  const stale = { ...defaultConfig(year), holidays: [] };
  const staleJson = JSON.stringify(stale);
  repo.db.prepare('UPDATE parameters SET json=? WHERE campaign_id=?').run(staleJson, cid);
  assert.throws(() => assertAnnualScoringConfig(year, stale), /solo lectura/);

  const file = JSON.parse(JSON.stringify(await s.backup()));
  await s.restore(file, (await s.admin()).revision);
  const restored = repo.db.prepare('SELECT json FROM parameters WHERE campaign_id=?').get(cid) as { json: string };
  assert.equal(restored.json, staleJson);
  assert.throws(() => checkedConfig(stale, { year, team: 'C' }), /solo lectura/);
});

test('restaurar sigue rechazando parámetros que no son válidos', async () => {
  const { s, cid } = await setup();
  const file = JSON.parse(JSON.stringify(await s.backup()));
  const parameter = file.payload.tables.parameters.find((p: { campaign_id: string }) => p.campaign_id === cid);
  parameter.json = JSON.stringify({ ...JSON.parse(parameter.json), cycleLength: -1 });
  file.sha256 = createHash('sha256').update(JSON.stringify(file.payload)).digest('hex');
  await assert.rejects(s.restore(file, (await s.admin()).revision));
});

// A session of several MB is over D1's row limit as plain JSON, and existing copies hold it that way.
test('la sesión de reconstrucción se restaura comprimida y se sigue leyendo; la limpieza la ignora', async () => {
  const { repo, s, cid } = await setup();
  const session = { status: 'completed', originalEvents: [], applied: 'x'.repeat(3_000_000) };
  const plain = JSON.stringify(session);
  const stored = () =>
    (repo.db.prepare('SELECT json FROM reconstruction_sessions WHERE campaign_id=?').get(cid) as { json: string }).json;
  repo.db.prepare('INSERT INTO reconstruction_sessions(campaign_id,json) VALUES(?,?)').run(cid, plain);

  const file = JSON.parse(JSON.stringify(await s.backup()));
  await s.restore(file, (await s.admin()).revision);
  assert.ok(stored().startsWith('gz1:'));
  assert.ok(stored().length < 2_000_000);
  assert.equal(decodePayload(stored()), plain);

  // A copy that already holds it compressed is not compressed twice.
  const again = JSON.parse(JSON.stringify(await s.backup()));
  await s.restore(again, (await s.admin()).revision);
  assert.equal(decodePayload(stored()), plain);

  // Compaction reads this column with SQL JSON functions: a compressed row must simply not qualify.
  const { rows } = (
    await repo.all(
      `SELECT count(*) AS rows FROM reconstruction_sessions WHERE ${compactableSessionSQL('reconstruction_sessions.json')}`,
    )
  )[0];
  assert.equal(rows, 0);
  assert.equal(
    (await previewCleanup(repo, superuser, Date.now(), 'compact-reconstruction-events')).plan.categories[0].rows,
    0,
  );
});
