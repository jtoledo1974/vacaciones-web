import type { Repository } from './repository.ts';
import { requireSuper, type Principal } from './permissions.ts';

/** Only fixed labels leave the exception: messages may contain SQL, credentials or personal data. */
export function databaseFailure(error: unknown): string {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current = error;
  for (let i = 0; i < 5 && current && typeof current === 'object' && !seen.has(current); i++) {
    seen.add(current);
    const value = current as { message?: unknown; cause?: unknown };
    if (typeof value.message === 'string') messages.push(value.message);
    current = value.cause;
  }
  const message = messages.join(' ');
  if (/daily row read limit/i.test(message)) return 'd1_read_limit';
  if (/daily row write limit/i.test(message)) return 'd1_write_limit';
  if (/maximum.*storage|maximum DB size|SQLITE_FULL/i.test(message)) return 'd1_storage_limit';
  if (/no such table|no such column|SQLITE_SCHEMA/i.test(message)) return 'schema_error';
  if (/SQLITE_CONSTRAINT|constraint failed/i.test(message)) return 'constraint_error';
  if (/syntax error|SQLITE_ERROR/i.test(message)) return 'query_error';
  if (/timed? out|timeout/i.test(message)) return 'timeout';
  if (/D1 DB reset|code was updated/i.test(message)) return 'd1_reset';
  if (/overloaded|SQLITE_BUSY|database is locked/i.test(message)) return 'database_busy';
  if (/network|connection|fetch failed/i.test(message)) return 'connection_error';
  if (/D1_ERROR|D1_EXEC_ERROR|D1_TYPE_ERROR/i.test(message)) return 'd1_error';
  return 'unclassified';
}

export type DiagnosticContext = { requestId: string; route: string; method: string };

// Every layer of one request shares its context. Keep the first phase and timing
// without mutating thrown values or retaining completed requests in the Worker.
const loggedFailures = new WeakMap<DiagnosticContext, Set<unknown>>();

export function logServerFailure(error: unknown, context: DiagnosticContext, phase: string, elapsedMs: number) {
  let logged = loggedFailures.get(context);
  if (!logged) {
    logged = new Set();
    loggedFailures.set(context, logged);
  }
  if (logged.has(error)) return;
  logged.add(error);
  console.error(
    JSON.stringify({
      event: 'server_failure',
      timestamp: new Date().toISOString(),
      ...context,
      phase,
      elapsedMs: Math.round(elapsedMs),
      category: databaseFailure(error),
    }),
  );
}

/** Exactly two fixed SELECTs; no user SQL, business logic, writes, retries or background polling. */
export async function databaseDiagnostics(repo: Repository, actor: Principal, context: DiagnosticContext) {
  requireSuper(actor);
  const checks: { name: string; ok: boolean; elapsedMs: number; category?: string }[] = [];
  for (const [name, sql, valid] of [
    ['connection', 'SELECT 1 AS ok', (rows: Record<string, unknown>[]) => rows.length === 1 && rows[0].ok === 1],
    [
      'app_state',
      "SELECT revision FROM app_state WHERE id='main'",
      (rows: Record<string, unknown>[]) =>
        rows.length === 1 &&
        typeof rows[0].revision === 'number' &&
        Number.isSafeInteger(rows[0].revision) &&
        rows[0].revision >= 0,
    ],
  ] as const) {
    const started = performance.now();
    try {
      const rows = await repo.all(sql);
      const ok = valid(rows);
      checks.push({
        name,
        ok,
        elapsedMs: Math.round(performance.now() - started),
        ...(!ok ? { category: 'unexpected_result' } : {}),
      });
    } catch (error) {
      const elapsedMs = Math.round(performance.now() - started);
      logServerFailure(error, context, 'diagnostic_' + name, elapsedMs);
      checks.push({ name, ok: false, elapsedMs, category: databaseFailure(error) });
    }
  }
  return {
    ok: checks.every((check) => check.ok),
    timestamp: new Date().toISOString(),
    requestId: context.requestId,
    checks,
  };
}
