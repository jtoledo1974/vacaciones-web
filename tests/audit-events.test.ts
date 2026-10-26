import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  ADMIN_ACTIONS,
  CAMPAIGN_ACTIONS,
  ELECTION_ACTIONS,
  RECONSTRUCTION_ACTIONS,
  VACATION_UNDO_ACTIONS,
  decodeEvent,
  encodeEvent,
  isAuditAction,
} from '../domain/events.ts';
import { append, eventsFor } from '../server/audit-context.ts';
import { SQLiteRepo } from './sqlite-repo.ts';

const root = path.resolve(import.meta.dirname, '..');
const all = [
  ...ELECTION_ACTIONS,
  ...RECONSTRUCTION_ACTIONS,
  ...VACATION_UNDO_ACTIONS,
  ...CAMPAIGN_ACTIONS,
  ...ADMIN_ACTIONS,
];

test('cada tipo de evento hace ida y vuelta sin cambiar su forma almacenada', () => {
  for (const action of all) {
    const before = action === 'reconstruction_step' ? { format: 'election-undo-v1', awards: [] } : null,
      after = { version: 3, choices: [], memberId: 'A' };
    const stored = encodeEvent({ action, before, after } as any);
    assert.equal(stored.before_json, before === null ? null : JSON.stringify(before));
    assert.equal(stored.after_json, JSON.stringify(after));
    const event = decodeEvent({ id: 'e', created_at: 't', ...stored });
    assert.ok(isAuditAction(event.action));
    assert.deepEqual(event.before, before);
    assert.deepEqual(event.after, after);
    assert.deepEqual(encodeEvent(event), stored);
  }
});

test('los eventos antiguos sin format se leen como versión 1', () => {
  const old = decodeEvent({
    id: 'o',
    action: 'advance',
    created_at: 't',
    before_json: null,
    after_json: '{"choices":[]}',
  });
  assert.equal(old.format, 'advance-v1');
  const undo = decodeEvent({
    id: 'u',
    action: 'award',
    created_at: 't',
    before_json: '{"format":"vacations-undo-v1","awards":[]}',
    after_json: '{}',
  });
  assert.equal(undo.format, 'vacations-undo-v1');
  // Rows of retired actions (old backups) still decode.
  assert.equal(
    decodeEvent({ id: 'x', action: 'local_admin_session', created_at: 't', before_json: null, after_json: null }).after,
    null,
  );
});

test('append escribe filas que eventsFor lee en orden de inserción', async () => {
  const repo = new SQLiteRepo();
  await repo.batch([
    append({ id: 'b', actor: 'u', action: 'choose', campaignId: 'c', before: null, after: { n: 1 }, createdAt: '2' }),
    append({ id: 'a', actor: 'u', action: 'advance', campaignId: 'c', before: null, after: { n: 2 }, createdAt: '1' }),
  ]);
  const rows = await eventsFor(repo, 'c');
  assert.deepEqual(
    rows.map((r) => [r.id, r.action, r.after_json]),
    [
      ['b', 'choose', '{"n":1}'],
      ['a', 'advance', '{"n":2}'],
    ],
  );
});

test('solo server/audit-context.ts consulta o escribe la tabla audit', () => {
  const files = execFileSync('git', ['ls-files', '-z', '--', 'server', 'domain', 'app', 'worker'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\0')
    .filter((f) => /\.tsx?$/.test(f) && f !== 'server/audit-context.ts');
  const offenders = files.filter((f) =>
    /\b(?:FROM|INTO|UPDATE)\s+audit\b/i.test(readFileSync(path.join(root, f), 'utf8')),
  );
  assert.deepEqual(offenders, []);
});
