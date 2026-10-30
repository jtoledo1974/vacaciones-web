import { tableColumns, type Repository } from './repository.ts';
import { requireSuper, type Principal } from './permissions.ts';
import { databaseFailure, type DiagnosticContext } from './database-diagnostics.ts';
import { ApiError } from './errors.ts';

// Identifiers come from SQLite's schema, never from request parameters. Quoting
// also handles unusual names without interpreting them as SQL.
const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';

/** Reproduce one fixed backup SELECT, discarding all business data from the response. */
export async function backupTableDiagnostics(
  repo: Repository,
  actor: Principal,
  context: DiagnosticContext,
  table: string,
) {
  requireSuper(actor);
  if (!Object.hasOwn(tableColumns, table)) throw new ApiError('Tabla de copia no válida');
  const started = performance.now();
  try {
    const rows = await repo.all(
      `SELECT * FROM ${quote(table)} ORDER BY ${table === 'audit' ? 'rowid' : quote(tableColumns[table][0])}`,
    );
    return {
      ok: true,
      table,
      rows: rows.length,
      elapsedMs: Math.round(performance.now() - started),
      requestId: context.requestId,
    };
  } catch (error) {
    return {
      ok: false,
      table,
      category: databaseFailure(error),
      elapsedMs: Math.round(performance.now() - started),
      requestId: context.requestId,
    };
  }
}

/** Manual aggregate-only inspection. No row contents, SQL input, writes or retries. */
export async function storageDiagnostics(repo: Repository, actor: Principal, context: DiagnosticContext, offset = 0) {
  requireSuper(actor);
  if (!Number.isInteger(offset) || offset < 0 || offset > 1000) throw new ApiError('Desplazamiento no válido');
  const tables = await repo.all<{ name: string }>(
    "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
  );
  const measurements = [];
  // At most 21 reads per invocation, including schema discovery. Continue
  // explicitly, rather than exceeding the provider's per-request query budget.
  for (const { name } of tables.slice(offset, offset + 10)) {
    const started = performance.now();
    try {
      const columns = await repo.all<{ name: string }>(`PRAGMA table_info(${quote(name)})`);
      const sizes = columns.map((c) => `COALESCE(length(CAST(${quote(c.name)} AS BLOB)),0)`);
      const rowSize = sizes.join('+') || '0';
      const [stats] = await repo.all<{ rows: number; bytes: number; largestRowBytes: number; [key: string]: number }>(
        `SELECT COUNT(*) AS rows, COALESCE(SUM(${rowSize}),0) AS bytes, COALESCE(MAX(${rowSize}),0) AS largestRowBytes` +
          sizes.map((size, i) => `,COALESCE(SUM(${size}),0) AS c${i}`).join('') +
          ` FROM ${quote(name)}`,
      );
      measurements.push({
        table: name,
        ok: true,
        rows: stats.rows,
        bytes: stats.bytes,
        largestRowBytes: stats.largestRowBytes,
        columns: columns.map((c, i) => ({ name: c.name, bytes: stats['c' + i] })),
        elapsedMs: Math.round(performance.now() - started),
      });
    } catch (error) {
      measurements.push({
        table: name,
        ok: false,
        category: databaseFailure(error),
        elapsedMs: Math.round(performance.now() - started),
      });
    }
  }
  return {
    ok: measurements.every((m) => m.ok),
    timestamp: new Date().toISOString(),
    requestId: context.requestId,
    // Logical bytes omit indexes, page overhead and reusable pages, and are not a
    // transactionally consistent snapshot while other sessions are writing.
    measurement: 'logical-cell-bytes',
    tables: measurements,
    nextOffset: offset + 10 < tables.length ? offset + 10 : null,
    totalBytes: measurements.reduce((sum, m) => sum + (m.bytes ?? 0), 0),
  };
}
