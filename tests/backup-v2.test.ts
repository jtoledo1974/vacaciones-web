import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SQLiteRepo } from './sqlite-repo.ts';
import { backupManifest, backupPage, backupColumns } from '../server/backup-v2.ts';
import { downloadBackup, ArchiveVerifier, firstCursor, hash } from '../lib/backup-v2.mjs';
import { restoreArchive } from '../scripts/restore-backup-v2.mjs';
import { previewCleanup, applyCleanup } from '../server/cleanup.ts';
import { compactSessionSQL } from '../server/reconstruction-compaction.ts';
import type { Principal } from '../server/permissions.ts';
import type { Repository } from '../server/repository.ts';
import { decodePayload } from '../server/payload-codec.ts';
import { compressPayloadsBatch } from '../server/audit-context.ts';
import { randomBytes } from 'node:crypto';
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
    { id: 'va', role: 'team_admin', teams: ['va'] },
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
    assert.deepEqual(
      JSON.parse(decodePayload((await repo.all('SELECT after_json FROM audit'))[0].after_json)),
      event.after,
    );
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

test('compress-audit-payloads convierte el historial antiguo por lotes sin cambiar su contenido', async () => {
  const repo = new SQLiteRepo();
  const now = Date.now();
  const big = (i: number) =>
    JSON.stringify({
      format: 'election-undo-v1',
      awards: Array.from({ length: 150 }, (_, k) => ({ id: 'a' + i + '-' + k })),
    });
  const insert = repo.db.prepare(
    "INSERT INTO audit(id,actor,action,before_json,after_json,created_at) VALUES(?,'synthetic','advance',?,?,'2026-01-01')",
  );
  repo.db.exec('BEGIN');
  for (let i = 0; i < 101; i++) insert.run('legacy-' + i, big(i), '{"small":true}');
  insert.run('tiny', '{"a":1}', null);
  repo.db.exec('COMMIT');
  const original = repo.db.prepare('SELECT id,before_json,after_json FROM audit ORDER BY rowid').all();
  let preview = await previewCleanup(repo, actor, now, 'compress-audit-payloads');
  assert.equal(preview.plan.categories[0].rows, 100);
  assert.ok(preview.plan.categories[0].bytes > 0);
  assert.ok(!JSON.stringify(preview).includes('a0-0'), 'la vista previa no expone payloads');
  await applyCleanup(repo, actor, { cutoff: now, mode: preview.plan.mode, token: preview.token });
  preview = await previewCleanup(repo, actor, now, 'compress-audit-payloads');
  assert.equal(preview.plan.categories[0].rows, 1);
  await applyCleanup(repo, actor, { cutoff: now, mode: preview.plan.mode, token: preview.token });
  assert.equal((await previewCleanup(repo, actor, now, 'compress-audit-payloads')).plan.categories[0].rows, 0);
  const stored = new Map(
    repo.db
      .prepare('SELECT id,before_json,after_json FROM audit')
      .all()
      .map((r) => [r.id as string, r]),
  );
  for (const row of original as { id: string; before_json: string | null; after_json: string | null }[]) {
    const now = stored.get(row.id) as typeof row;
    assert.equal(now.before_json && decodePayload(now.before_json), row.before_json);
    assert.equal(now.after_json && decodePayload(now.after_json), row.after_json);
  }
  assert.ok((stored.get('legacy-0') as { before_json: string }).before_json.startsWith('gz1:'));
  assert.equal((stored.get('tiny') as { before_json: string }).before_json, '{"a":1}', 'lo pequeño no se toca');
});

test('compress-audit-payloads termina con payloads que no se comprimen y limita cada lote por bytes', async () => {
  const repo = new SQLiteRepo();
  const now = Date.now();
  const insert = repo.db.prepare(
    "INSERT INTO audit(id,actor,action,before_json,after_json,created_at) VALUES(?,'synthetic','advance',?,?,'2026-01-01')",
  );
  const opaque = JSON.stringify({ opaque: randomBytes(2000).toString('base64') });
  const emoji = JSON.stringify({ label: '🏖️'.repeat(800) });
  insert.run('opaque', opaque, '{}');
  insert.run('emoji', emoji, '{}');
  for (let i = 0; i < 3; i++) insert.run('big-' + i, JSON.stringify({ n: i, pad: 'x'.repeat(3000) }), '{}');
  // A tight budget still takes at least one row, and never more than fit.
  assert.equal((await compressPayloadsBatch(repo, 100, 1)).updates.length, 1);
  assert.equal((await compressPayloadsBatch(repo, 100, 2 * 3100)).updates.length, 2);
  let batches = 0;
  for (; batches < 10; batches++) {
    const preview = await previewCleanup(repo, actor, now, 'compress-audit-payloads');
    if (!preview.plan.categories[0].rows) break;
    await applyCleanup(repo, actor, { cutoff: now, mode: preview.plan.mode, token: preview.token });
  }
  assert.ok(batches < 10, 'la conversión termina');
  const rows = repo.db.prepare("SELECT id,before_json FROM audit WHERE action='advance'").all() as {
    id: string;
    before_json: string;
  }[];
  assert.ok(rows.every((r) => r.before_json.startsWith('gz1:')));
  const byId = new Map(rows.map((r) => [r.id, decodePayload(r.before_json)]));
  assert.equal(byId.get('opaque'), opaque);
  assert.equal(byId.get('emoji'), emoji);
});

for (const version of [20, 21])
  test(`una copia v2 de esquema 00${version} se restaura aplicando después las migraciones posteriores`, async () => {
    // The source database as a 00${version} server had it: only the migrations up to that version.
    const repo = Object.create(SQLiteRepo.prototype) as SQLiteRepo,
      dir = mkdtempSync(path.join(tmpdir(), 'vac-v2-old-'));
    repo.db = new DatabaseSync(':memory:');
    for (const file of readdirSync('drizzle')
      .filter((f) => f.endsWith('.sql') && Number(f.slice(0, 4)) <= version)
      .sort())
      repo.db.exec(readFileSync('drizzle/' + file, 'utf8'));
    const insertTeam = repo.db.prepare('INSERT INTO teams(id,name) VALUES(?,?)');
    for (const t of 'ABCDEFGH') insertTeam.run(t, 'Equipo ' + t);
    repo.db.exec(`INSERT INTO users(id,provider,subject,role,va_admin) VALUES
      ('u-va','chatgpt','email:va@x.test','viewer',1), ('u-a','chatgpt','email:a@x.test','team_admin',0);
      INSERT INTO grants(id,user_id,team_id) VALUES('g-a','u-a','A');
      INSERT INTO va_external_people(id,code,label,seniority,controller_number,category)
        VALUES('va-external:900','EXT','Externa','2001-02-03',900,'otro');
      INSERT INTO va_external_accounts(person_id,principal_key) VALUES('va-external:900','chatgpt-email:ext@x.test');
      INSERT INTO hr_templates(year,data,sha256,uploaded_by,uploaded_at) VALUES(2026,'eA==','00','u-a','2026-01-01');`);
    const current = Object.fromEntries(Object.entries(backupColumns).map(([t, c]) => [t, [...c]]));
    try {
      // Tables dropped by later migrations were still part of the old copy.
      for (const table of [...Object.keys(backupColumns), 'va_external_people', 'va_external_accounts'])
        (backupColumns as Record<string, string[]>)[table] = repo.db
          .prepare(`SELECT name FROM pragma_table_info('${table}')`)
          .all()
          .map((r) => r.name as string);
      const records: ArchiveRecord[] = [];
      await downloadBackup(requestFor(repo), async (line: string) => {
        records.push(JSON.parse(line));
      });
      const manifest = records[0] as ArchiveRecord & { payload: { schemaVersion: string } };
      manifest.payload.schemaVersion = 'vacaciones-schema-00' + version;
      manifest.sha256 = await hash(manifest.payload);
      let chain = manifest.sha256;
      for (const page of records.slice(1, -1)) chain = await hash([chain, page.sha256]);
      records[records.length - 1].chain = chain;

      const dest = path.join(dir, 'restored.sqlite');
      await restoreArchive(values(records), dest);
      const restored = new DatabaseSync(dest);
      const rows = (sql: string) =>
        restored
          .prepare(sql)
          .all()
          .map((r) => ({ ...r }));
      try {
        assert.deepEqual(rows("SELECT id FROM teams WHERE kind='ordinary' ORDER BY id").length, 8);
        // Migration 0022 turned the VA administrator into an administrator of team va.
        assert.deepEqual(rows('SELECT id,role FROM users ORDER BY id'), [
          { id: 'u-a', role: 'team_admin' },
          { id: 'u-va', role: 'team_admin' },
        ]);
        assert.deepEqual(rows('SELECT user_id,team_id FROM grants ORDER BY user_id'), [
          { user_id: 'u-a', team_id: 'A' },
          { user_id: 'u-va', team_id: 'va' },
        ]);
        assert.deepEqual(rows("SELECT kind FROM teams WHERE id='va'"), [{ kind: 'va' }]);
        // Migration 0025 keyed RRHH workbooks by year and kind: the old one is ordinary.
        assert.deepEqual(rows('SELECT year,kind FROM hr_templates'), [{ year: 2026, kind: 'ordinary' }]);
        // Migration 0023 moved the external person and their account to the common tables.
        assert.deepEqual(rows("SELECT id,team_id,code,controller_number FROM people WHERE team_id='va'"), [
          { id: 'va-external:900', team_id: 'va', code: 'EXT', controller_number: 900 },
        ]);
        assert.deepEqual(rows('SELECT person_id,principal_key FROM controller_accounts'), [
          { person_id: 'va-external:900', principal_key: 'chatgpt-email:ext@x.test' },
        ]);
      } finally {
        restored.close();
      }
    } finally {
      for (const table of Object.keys(backupColumns))
        if (!(table in current)) delete (backupColumns as Record<string, string[]>)[table];
      Object.assign(backupColumns, current);
      repo.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
