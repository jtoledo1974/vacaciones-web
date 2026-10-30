import { test } from 'node:test';
import assert from 'node:assert/strict';
import { databaseDiagnostics, databaseFailure, logServerFailure } from '../server/database-diagnostics.ts';
import { D1Repository, type Repository } from '../server/repository.ts';

const admin = { id: 'test-admin', role: 'superadmin' as const, teams: [] };
const context = { requestId: 'test-request', route: '/api/diagnostics', method: 'GET' };

test('diagnóstico prohíbe anónimos y administradores de equipo antes de consultar D1', async () => {
  const repo = {
    all: async () => assert.fail('No debe consultar'),
    batch: async () => assert.fail('No debe escribir'),
  };
  for (const actor of [
    { id: null, role: 'viewer' as const, teams: [] },
    { id: 'team-admin', role: 'team_admin' as const, teams: ['A'] },
  ]) {
    await assert.rejects(databaseDiagnostics(repo, actor, context), { status: 403 });
  }
});

test('diagnóstico realiza únicamente dos SELECT fijos y no devuelve datos reales', async () => {
  const queries: string[] = [];
  const repo = {
    all: async (sql: string) => {
      queries.push(sql);
      return sql.startsWith('SELECT 1') ? [{ ok: 1 }] : [{ revision: 2185 }];
    },
    batch: async () => assert.fail('No debe escribir'),
  } as Repository;
  const result = await databaseDiagnostics(repo, admin, context);
  assert.equal(result.ok, true);
  assert.deepEqual(queries, ['SELECT 1 AS ok', "SELECT revision FROM app_state WHERE id='main'"]);
  assert.equal(JSON.stringify(result).includes('2185'), false);
  assert.equal(result.requestId, context.requestId);
});

test('un fallo de conexión no impide medir la segunda consulta; conserva categoría sin filtrar datos', async (t) => {
  const log = t.mock.method(console, 'error', () => {});
  const repo = {
    all: async (sql: string) => {
      if (sql.startsWith('SELECT 1'))
        throw new Error('wrapped', { cause: new Error('D1_ERROR: network failure secret@example.com') });
      return [{ revision: 7 }];
    },
    batch: async () => assert.fail('No debe escribir'),
  } as Repository;
  const result = await databaseDiagnostics(repo, admin, context);
  assert.equal(result.ok, false);
  assert.equal(result.checks[0].category, 'connection_error');
  assert.equal(result.checks[1].ok, true);
  assert.equal(JSON.stringify(result).includes('secret@example.com'), false);
  assert.equal(log.mock.calls.length, 1);
  assert.equal(JSON.stringify(log.mock.calls).includes('secret@example.com'), false);
});

test('una tabla o fila ausente se distingue de una conexión correcta', async (t) => {
  t.mock.method(console, 'error', () => {});
  for (const missingTable of [true, false]) {
    const repo = {
      all: async (sql: string) => {
        if (sql.startsWith('SELECT 1')) return [{ ok: 1 }];
        if (missingTable) throw new Error('D1_ERROR: no such table: app_state');
        return [];
      },
      batch: async () => [],
    } as Repository;
    const result = await databaseDiagnostics(repo, admin, context);
    assert.equal(result.ok, false);
    assert.equal(result.checks[0].ok, true);
    assert.equal(result.checks[1].category, missingTable ? 'schema_error' : 'unexpected_result');
  }
});

test('clasifica cuotas, almacenamiento, reinicio y errores SQL a través de causas cíclicas', () => {
  for (const [message, category] of [
    ["Your account has exceeded D1's free tier daily row read limit", 'd1_read_limit'],
    ["Your account has exceeded D1's free tier daily row write limit", 'd1_write_limit'],
    ['Exceeded maximum DB size.', 'd1_storage_limit'],
    ['D1 DB reset because its code was updated.', 'd1_reset'],
    ['SQLITE_CONSTRAINT: UNIQUE constraint failed', 'constraint_error'],
    ['syntax error', 'query_error'],
    ['D1_ERROR: network failure', 'connection_error'],
    ['D1_ERROR: connection reset', 'connection_error'],
    ['D1_EXEC_ERROR: fetch failed', 'connection_error'],
    ['D1_ERROR: internal failure', 'd1_error'],
    ['D1_ERROR: response size limit exceeded', 'd1_result_limit'],
    ['D1_ERROR: SQLITE_TOOBIG', 'd1_row_limit'],
    ['D1_ERROR: too many SQL variables', 'd1_query_limit'],
  ])
    assert.equal(databaseFailure(new Error('wrapper', { cause: new Error(message) })), category);
  const cyclic = new Error('private unexpected message');
  cyclic.cause = cyclic;
  assert.equal(databaseFailure(cyclic), 'unclassified');
});

test('fallos del repositorio se registran con correlación y se relanzan sin reintentar ni alterar su identidad', async (t) => {
  const log = t.mock.method(console, 'error', () => {});
  const original = new Error('D1_ERROR: no such column: private_column');
  const batchError = new Error('D1_ERROR: no such column: private_column');
  let attempts = 0;
  const db = {
    prepare: () => ({
      bind: () => ({
        all: async () => {
          attempts++;
          throw original;
        },
      }),
    }),
    batch: async () => {
      attempts++;
      throw batchError;
    },
  } as unknown as D1Database;
  const repo = new D1Repository(db, context);
  await assert.rejects(repo.all('SELECT private'), (error) => error === original);
  await assert.rejects(repo.batch([]), (error) => error === batchError);
  assert.equal(attempts, 2);
  const logs = log.mock.calls.map((call) => JSON.parse(call.arguments[0]));
  assert.deepEqual(
    logs.map((entry) => entry.phase),
    ['database_read', 'database_batch'],
  );
  assert.ok(logs.every((entry) => entry.requestId === context.requestId && entry.category === 'schema_error'));
  assert.equal(JSON.stringify(logs).includes('private_column'), false);
  logServerFailure(new Error('password=private_token'), context, 'handler', 5);
  assert.equal(log.mock.calls[2].arguments[0].includes('private_token'), false);
});

test('D1Repository y diagnóstico registran una sola vez cada fallo y conservan fase y requestId originales', async (t) => {
  const log = t.mock.method(console, 'error', () => {});
  const requestContext = { ...context, requestId: 'diagnostic-integration' };
  let calls = 0;
  const db = {
    prepare: () => ({
      bind: () => ({
        all: async () => {
          calls++;
          throw new Error('D1_ERROR: network failure');
        },
      }),
    }),
  } as unknown as D1Database;
  const result = await databaseDiagnostics(new D1Repository(db, requestContext), admin, requestContext);
  assert.equal(calls, 2);
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.checks.map((check) => check.category),
    ['connection_error', 'connection_error'],
  );
  assert.equal(log.mock.calls.length, 2);
  for (const call of log.mock.calls) {
    const entry = JSON.parse(call.arguments[0]);
    assert.equal(entry.phase, 'database_read');
    assert.equal(entry.requestId, requestContext.requestId);
    assert.equal(entry.category, 'connection_error');
  }
});

test('D1Repository y el registro del manejador HTTP no duplican la excepción; otra petición sí se registra', async (t) => {
  const log = t.mock.method(console, 'error', () => {});
  const original = Object.freeze(new Error('D1_ERROR: fetch failed'));
  const db = {
    prepare: () => ({
      bind: () => ({
        all: async () => {
          throw original;
        },
      }),
    }),
    batch: async () => {
      throw original;
    },
  } as unknown as D1Database;
  for (const operation of ['all', 'batch'] as const) {
    const requestContext = { ...context, requestId: 'http-' + operation };
    const repo = new D1Repository(db, requestContext);
    try {
      if (operation === 'all') await repo.all('SELECT 1');
      else await repo.batch([]);
      assert.fail('Debe fallar');
    } catch (error) {
      assert.equal(error, original);
      logServerFailure(error, requestContext, 'handler', 999);
    }
  }
  assert.equal(log.mock.calls.length, 2);
  const entries = log.mock.calls.map((call) => JSON.parse(call.arguments[0]));
  assert.deepEqual(
    entries.map((entry) => [entry.requestId, entry.phase]),
    [
      ['http-all', 'database_read'],
      ['http-batch', 'database_batch'],
    ],
  );
  assert.ok(entries.every((entry) => entry.elapsedMs !== 999 && entry.category === 'connection_error'));
});
