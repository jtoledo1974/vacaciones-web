import { test } from 'node:test';
import assert from 'node:assert/strict';
import { storageDiagnostics, backupTableDiagnostics } from '../server/storage-diagnostics.ts';
import type { Repository } from '../server/repository.ts';

const context = { requestId: 'storage-test', route: '/api/diagnostics', method: 'GET' };
const admin = { id: 'admin', role: 'superadmin' as const, teams: [] };

test('backup probe validates table allowlist and discards row contents on success and failure', async () => {
  let queries = 0;
  const repo = {
    all: async (sql: string) => {
      queries++;
      if (sql.includes('"audit"')) throw new Error('D1_ERROR: response size limit exceeded private@example.com');
      return [{ id: 'secret-row' }];
    },
    batch: async () => assert.fail('Must not write'),
  } as Repository;
  await assert.rejects(backupTableDiagnostics(repo, { id: null, role: 'viewer', teams: [] }, context, 'audit'), {
    status: 403,
  });
  for (const table of ['audit; DROP TABLE audit', 'toString', '__proto__'])
    await assert.rejects(backupTableDiagnostics(repo, admin, context, table), { status: 400 });
  assert.equal(queries, 0);
  const ok = await backupTableDiagnostics(repo, admin, context, 'people');
  const failure = await backupTableDiagnostics(repo, admin, context, 'audit');
  assert.equal(ok.ok, true);
  assert.equal(ok.rows, 1);
  assert.equal(failure.category, 'd1_result_limit');
  assert.equal(JSON.stringify([ok, failure]).includes('secret-row'), false);
  assert.equal(JSON.stringify([ok, failure]).includes('private@example.com'), false);
});

test('storage diagnostics authorizes before reading schema', async () => {
  const repo = { all: async () => assert.fail('Must not read'), batch: async () => assert.fail('Must not write') };
  await assert.rejects(storageDiagnostics(repo, { id: null, role: 'viewer', teams: [] }, context), { status: 403 });
  await assert.rejects(storageDiagnostics(repo, { id: 'a', role: 'team_admin', teams: ['A'] }, context), {
    status: 403,
  });
});

test('storage diagnostics counts UTF-8 bytes and returns aggregates without row contents', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE audit(id TEXT, before_json TEXT); CREATE TABLE "odd""name"(value TEXT)');
    db.prepare('INSERT INTO audit VALUES (?,?)').run('a', 'ñ');
    const queries: string[] = [];
    const repo = {
      all: async (sql: string) => {
        queries.push(sql);
        return db.prepare(sql).all();
      },
      batch: async () => assert.fail('Must not write'),
    } as Repository;
    const result = await storageDiagnostics(repo, admin, context);
    assert.equal(result.ok, true);
    assert.equal(result.totalBytes, 3);
    assert.equal(result.tables[0].rows, 1);
    assert.equal(result.tables[0].largestRowBytes, 3);
    assert.deepEqual(result.tables[0].columns, [
      { name: 'id', bytes: 1 },
      { name: 'before_json', bytes: 2 },
    ]);
    assert.equal(result.tables[1].bytes, 0);
    assert.equal(JSON.stringify(result).includes('ñ'), false);
    assert.ok(queries.every((q) => q.startsWith('SELECT') || q.startsWith('PRAGMA table_info')));
  } finally {
    db.close();
  }
});

test('one failed table does not prevent inspecting the rest or expose its exception', async () => {
  const repo = {
    all: async (sql: string) => {
      if (sql.includes('sqlite_schema')) return [{ name: 'bad' }, { name: 'good' }];
      if (sql.includes('"bad"')) throw new Error('D1_ERROR: private@example.com');
      if (sql.startsWith('PRAGMA')) return [{ name: 'id' }];
      return [{ rows: 2, bytes: 8, largestRowBytes: 4, c0: 8 }];
    },
    batch: async () => assert.fail('Must not write'),
  } as Repository;
  const result = await storageDiagnostics(repo, admin, context);
  assert.equal(result.ok, false);
  assert.equal(result.tables[0].category, 'd1_error');
  assert.equal(result.tables[1].ok, true);
  assert.equal(result.totalBytes, 8);
  assert.equal(JSON.stringify(result).includes('private@example.com'), false);
});
