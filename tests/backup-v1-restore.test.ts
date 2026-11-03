import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteRepo } from './sqlite-repo.ts';
import { Service } from '../server/service.ts';
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

// The v1 copy is the usual one: it must survive the JSON round trip the web form and the CLI
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
