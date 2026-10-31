import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SQLiteRepo } from './sqlite-repo.ts';
import { backupManifest, backupPage, backupColumns } from '../server/backup-v2.ts';
import { downloadBackup, ArchiveVerifier, firstCursor } from '../lib/backup-v2.mjs';
import { restoreArchive } from '../scripts/restore-backup-v2.mjs';
import { previewCleanup, applyCleanup } from '../server/cleanup.ts';
import { compactSessionSQL } from '../server/reconstruction-compaction.ts';
import type { Principal } from '../server/permissions.ts';
import type { Repository } from '../server/repository.ts';
type ArchiveRecord = { kind: string; payload: Record<string, unknown>; sha256: string; chain: string; pages: number };
const actor: Principal = { id: 'test:super', role: 'superadmin', teams: [] };
const requestFor = (repo: SQLiteRepo) => async (method: string, _route: string, body?: unknown) =>
  method === 'GET' ? backupManifest(repo, actor) : backupPage(repo, actor, body);
async function* values(records: unknown[]) {
  yield* records;
}

test('v2 covers all persistent tables, and clocks every table; excludes only documented technical state', async () => {
  const repo = new SQLiteRepo();
  try {
    const tables = await repo.all("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'");
    const excluded = [
      'backup_clock',
      'cleanup_clock',
      'transaction_assertions',
      'va_integrity_assertions',
      'local_admin_sessions',
      'local_admin_attempts',
      'cli_sessions',
      'cli_attempts',
    ];
    assert.deepEqual(
      tables
        .map((t) => t.name)
        .filter((n) => !excluded.includes(n))
        .sort(),
      Object.keys(backupColumns).sort(),
    );
    for (const { name } of tables.filter((t) => Object.hasOwn(backupColumns, t.name))) {
      for (const op of ['insert', 'update', 'delete'])
        assert.equal(
          (
            await repo.all("SELECT name FROM sqlite_schema WHERE type='trigger' AND name=?", [
              `backup_clock_${name}_${op}`,
            ])
          ).length,
          1,
          `${name}/${op}`,
        );
    }
    for (const [name, columns] of Object.entries(backupColumns))
      assert.deepEqual(
        (await repo.all(`PRAGMA table_info(${name})`)).map((c) => c.name).sort(),
        [...columns].sort(),
        name,
      );
  } finally {
    repo.db.close();
  }
});

test(
  'v2 volume > production, giant cells, Unicode, bounded pages, complete SQLite round trip',
  { timeout: 120000 },
  async () => {
    const repo = new SQLiteRepo(),
      dir = mkdtempSync(path.join(tmpdir(), 'vac-v2-'));
    let maxBytes = 0;
    try {
      // 72 MB of logical text, without retaining the whole backup or whole database in JS.
      const text = 'ñ🦉'.repeat(60_000);
      const insert = repo.db.prepare(
        "INSERT INTO audit(id,actor,action,before_json,after_json,created_at) VALUES(?,'synthetic','test',?,?,'2026-01-01')",
      );
      repo.db.exec('BEGIN');
      for (let i = 0; i < 200; i++) insert.run('event-' + i, text, '{}');
      // One cell larger than a normal D1 response, sliced entirely in SQL.
      insert.run('giant', 'x'.repeat(2_000_000), '{}');
      repo.db.exec('COMMIT');
      const dest = path.join(dir, 'restored.sqlite');
      // Couple download directly to restore through an async bounded queue (one page).
      let next: (() => void) | undefined,
        consumed: (() => void) | undefined,
        slot: unknown,
        done = false,
        error: unknown;
      async function* channel() {
        while (true) {
          if (slot === undefined && !done)
            await new Promise<void>((r) => {
              next = r;
            });
          if (slot !== undefined) {
            const record = slot;
            slot = undefined;
            yield record;
            consumed?.();
          }
          if (done) {
            if (error) throw error;
            return;
          }
        }
      }
      const restore = restoreArchive(channel(), dest);
      const download = downloadBackup(requestFor(repo), async (line: string) => {
        maxBytes = Math.max(maxBytes, Buffer.byteLength(line));
        slot = JSON.parse(line);
        await new Promise<void>((r) => {
          consumed = r;
          next?.();
        });
      })
        .catch((e) => {
          error = e;
        })
        .finally(() => {
          done = true;
          next?.();
        });
      await Promise.all([download, restore]);
      if (error) throw error;
      assert.ok(maxBytes < 800_000, 'page serialization is bounded independently of database size');
      const restored = new DatabaseSync(dest);
      try {
        assert.deepEqual(
          restored.prepare('SELECT id,length(CAST(before_json AS BLOB)) AS bytes FROM audit ORDER BY rowid').all(),
          repo.db.prepare('SELECT id,length(CAST(before_json AS BLOB)) AS bytes FROM audit ORDER BY rowid').all(),
        );
        assert.equal(restored.prepare("SELECT before_json FROM audit WHERE id='event-0'").get()!.before_json, text);
        assert.equal(
          restored.prepare("SELECT before_json FROM audit WHERE id='giant'").get()!.before_json,
          'x'.repeat(2_000_000),
        );
      } finally {
        restored.close();
      }
    } finally {
      repo.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test('v2 rejects inter-page writes, late writes and schema changes; interruptions and tampering never restore', async () => {
  const repo = new SQLiteRepo(),
    dir = mkdtempSync(path.join(tmpdir(), 'vac-v2-bad-'));
  try {
    const manifest = await backupManifest(repo, actor);
    repo.db.exec("INSERT INTO teams(id,name) VALUES('synthetic','Synthetic')");
    await assert.rejects(backupPage(repo, actor, { revision: manifest.payload.revision, cursor: firstCursor() }), {
      status: 409,
    });
    const records: ArchiveRecord[] = [];
    await downloadBackup(requestFor(repo), async (line: string) => {
      records.push(JSON.parse(line));
    });
    for (const bad of [
      records.slice(0, -1),
      records.slice(0, -2),
      [...records.slice(0, -1), { ...records.at(-1), chain: 'bad' }],
      [records[0], { ...records[1], sha256: 'bad' }, ...records.slice(2)],
    ]) {
      const dest = path.join(dir, 'bad.sqlite');
      await assert.rejects(restoreArchive(values(bad), dest));
      assert.equal(existsSync(dest), false);
      assert.equal(existsSync(dest + '.partial'), false);
    }
    const verify = new ArchiveVerifier();
    for (const record of records) await verify.accept(record);
    verify.finish();
    await assert.rejects(verify.accept(records.at(-1)));
    const late = await backupManifest(repo, actor);
    repo.db.exec("UPDATE teams SET name='changed'");
    await assert.rejects(
      backupPage(repo, actor, {
        revision: late.payload.revision,
        cursor: { table: Object.keys(backupColumns).length, row: 0, offset: 1 },
      }),
      { status: 409 },
    );
    let changed = false;
    await assert.rejects(
      downloadBackup(
        async (method: string, route: string, body: { cursor?: { table?: number } }) => {
          if (body?.cursor?.table === Object.keys(backupColumns).length && !changed) {
            repo.db.exec('CREATE TABLE schema_change(id TEXT)');
            changed = true;
          }
          return requestFor(repo)(method, route, body);
        },
        async () => {},
      ),
      /esquema cambió/,
    );
  } finally {
    repo.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('v2 fails closed for unknown tables, missing coherence triggers and unsupported rowids', async () => {
  for (const sql of [
    'CREATE TABLE unknown_data(value TEXT)',
    'DROP TRIGGER backup_clock_teams_update',
    "INSERT INTO teams(rowid,id,name) VALUES(0,'zero','Synthetic')",
  ]) {
    const repo = new SQLiteRepo();
    try {
      repo.db.exec(sql);
      await assert.rejects(backupManifest(repo, actor));
    } finally {
      repo.db.close();
    }
  }
});

test('backup and cleanup require superadmin before any database access', async () => {
  const repo: Repository = {
    all: async () => assert.fail('database access'),
    batch: async () => assert.fail('database access'),
  };
  for (const denied of [
    { id: null, role: 'viewer', teams: [] },
    { id: 't', role: 'team_admin', teams: ['C'] },
    { id: 'va', role: 'viewer', teams: [], vaAdmin: true },
  ] as Principal[]) {
    for (const action of [
      () => backupManifest(repo, denied),
      () => backupPage(repo, denied, {}),
      () => previewCleanup(repo, denied),
      () => applyCleanup(repo, denied, {}),
    ])
      await assert.rejects(action(), { status: 403 });
  }
});

test('cleanup is preview-only until exact confirmation; batches expired auth and preserves active access', async () => {
  const repo = new SQLiteRepo();
  try {
    const now = Date.now();
    repo.db.exec('BEGIN');
    const insert = repo.db.prepare('INSERT INTO local_admin_sessions(id,actor,created_at,expires_at) VALUES(?,?,?,?)');
    for (let i = 0; i < 501; i++) insert.run('old-' + i, 'synthetic', '2026-01-01', Math.floor(now / 1000) - 100);
    insert.run('active', 'synthetic', '2026-01-01', Math.floor(now / 1000) + 3600);
    repo.db.exec('COMMIT');
    const preview = await previewCleanup(repo, actor, now);
    assert.equal(preview.plan.categories[0].rows, 500);
    assert.ok(preview.plan.categories[0].bytes > 0);
    assert.equal((await repo.all('SELECT count(*) AS n FROM local_admin_sessions'))[0].n, 502);
    await assert.rejects(applyCleanup(repo, actor, { cutoff: now, token: 'bad' }), { status: 409 });
    await applyCleanup(repo, actor, { cutoff: now, token: preview.token });
    assert.equal((await repo.all('SELECT count(*) AS n FROM local_admin_sessions'))[0].n, 2);
    await assert.rejects(applyCleanup(repo, actor, { cutoff: now, token: preview.token }), { status: 409 });
    const next = await previewCleanup(repo, actor, now);
    assert.equal(next.plan.categories[0].rows, 1);
    repo.db.exec("UPDATE local_admin_sessions SET actor='concurrent' WHERE id='old-500'");
    await assert.rejects(applyCleanup(repo, actor, { cutoff: now, token: next.token }), { status: 409 });
    assert.equal((await repo.all("SELECT count(*) AS n FROM local_admin_sessions WHERE id='active'"))[0].n, 1);
  } finally {
    repo.db.close();
  }
});

test('concurrent write between recomputed cleanup preview and batch rolls back all effects', async () => {
  const repo = new SQLiteRepo();
  try {
    const preview = await previewCleanup(repo, actor);
    const original = repo.batch.bind(repo);
    let batches = 0;
    repo.batch = async (statements) => {
      if (++batches === 2) repo.db.exec("INSERT INTO teams(id,name) VALUES('concurrent','Concurrent')");
      return original(statements);
    };
    await assert.rejects(applyCleanup(repo, actor, { cutoff: preview.plan.cutoff, token: preview.token }), {
      status: 409,
    });
    assert.equal((await repo.all('SELECT count(*) AS n FROM transaction_assertions'))[0].n, 0);
  } finally {
    repo.db.close();
  }
});

test('legacy session compaction equals new-session projection, preserves source audit and every other checkpoint', async () => {
  const repo = new SQLiteRepo();
  try {
    repo.db.exec(
      "INSERT INTO teams(id,name) VALUES('S','Synthetic'); INSERT INTO campaigns(id,year,team_id,version,created_at) VALUES('c',2026,'S',1,'2026-01-01')",
    );
    const event = {
      id: 'event',
      participants: ['p'],
      before: {
        format: 'vacations-undo-v1',
        state: { cursor: 2 },
        awards: [{ id: 'a' }],
        requests: [{ id: 'r' }],
        preferences: [
          { member_id: 'p', dates: ['2026-01-01'] },
          { member_id: 'other', dates: [] },
        ],
      },
      after: { kind: 'choose', impact: { huge: 'x'.repeat(200000) }, choices: [] },
    };
    const session = {
      status: 'active',
      originalEvents: [event],
      origin: event.before,
      applied: [{ before: event.before, beforeAvailability: { state: 'keep' } }],
      undone: [{ before: event.before }],
      impact: [{ keep: true }],
    };
    repo.db
      .prepare(
        "INSERT INTO audit(id,actor,action,before_json,after_json,created_at) VALUES('event','synthetic','choose',?,?,'2026-01-01')",
      )
      .run(JSON.stringify(event.before), JSON.stringify(event.after));
    repo.db
      .prepare('INSERT INTO reconstruction_sessions(campaign_id,json) VALUES(?,?)')
      .run('c', JSON.stringify(session));
    const expected = JSON.parse(JSON.stringify(session));
    delete expected.originalEvents[0].after.impact;
    expected.originalEvents[0].before.awards = [];
    expected.originalEvents[0].before.requests = [];
    expected.originalEvents[0].before.preferences = expected.originalEvents[0].before.preferences.filter(
      (p: { member_id: string }) => p.member_id === 'p',
    );
    assert.deepEqual(
      JSON.parse(
        (
          await repo.all(
            `SELECT ${compactSessionSQL('reconstruction_sessions.json')} AS compact FROM reconstruction_sessions`,
          )
        )[0].compact,
      ),
      expected,
    );
    const preview = await previewCleanup(repo, actor, Date.now(), 'compact-reconstruction-events');
    assert.equal(preview.plan.categories[0].rows, 1);
    assert.ok(preview.plan.categories[0].bytes > 200000);
    await applyCleanup(repo, actor, { mode: preview.plan.mode, cutoff: preview.plan.cutoff, token: preview.token });
    assert.deepEqual(JSON.parse((await repo.all('SELECT json FROM reconstruction_sessions'))[0].json), expected);
    assert.deepEqual(JSON.parse((await repo.all('SELECT after_json FROM audit'))[0].after_json), event.after);
    const again = await previewCleanup(repo, actor, Date.now(), 'compact-reconstruction-events');
    assert.equal(again.plan.categories[0].rows, 0);
    repo.db.prepare('UPDATE reconstruction_sessions SET json=?').run(JSON.stringify(session));
    repo.db.exec("DELETE FROM audit WHERE id='event'");
    assert.equal(
      (await previewCleanup(repo, actor, Date.now(), 'compact-reconstruction-events')).plan.categories[0].rows,
      0,
      'never discard the only remaining copy',
    );
  } finally {
    repo.db.close();
  }
});
