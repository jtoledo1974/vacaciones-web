import type { Repository } from './repository.ts';
import { tableColumns } from './repository.ts';
import { requireSuper, type Principal } from './permissions.ts';
import { ApiError } from './errors.ts';
import { hash, firstCursor } from '../lib/backup-v2.mjs';

// Includes the v1 election backup, plus private drafts, templates and device preferences.
export const backupColumns = {
  ...tableColumns,
  app_state: ['id', 'revision'],
  hr_templates: ['year', 'kind', 'data', 'sha256', 'uploaded_by', 'uploaded_at'],
  personal_simulations: ['owner_key', 'campaign_id', 'member_id', 'json', 'updated_at'],
  push_subscriptions: ['endpoint', 'owner_key', 'p256dh', 'auth', 'created_at'],
  turn_notifications: ['id', 'owner_key', 'campaign_id', 'member_id', 'round', 'created_at', 'push_status'],
  push_deliveries: ['event_id', 'endpoint', 'status', 'lease_token', 'lease_expires_at', 'attempts'],
};
export const CHUNK = 8192;
// A page reads at most PAGE_CHARS characters, from up to PAGE_ROWS rows, in 8 KB
// fragments: about 256 KB per request, with Worker memory still bounded.
const PAGE_CHARS = 32 * CHUNK,
  PAGE_ROWS = 32;
const revisionSQL = "SELECT revision FROM backup_clock WHERE id='main'";
const schemaSQL =
  "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY type,name";
export async function backupManifest(repo: Repository, actor: Principal) {
  requireSuper(actor);
  const names = Object.keys(backupColumns);
  const r = await repo.batch([
    { sql: revisionSQL },
    { sql: schemaSQL },
    ...names.map((name) => ({
      sql: `SELECT count(*) AS rows, min(rowid) AS first, max(rowid) AS last FROM "${name}"`,
    })),
  ]);
  if (!r[0].results[0]) throw new ApiError('Falta la migración del reloj de backup', 503);
  const excluded = new Set([
    'backup_clock',
    'cleanup_clock',
    'transaction_assertions',
    'va_integrity_assertions',
    'local_admin_sessions',
    'local_admin_attempts',
    'cli_sessions',
    'cli_attempts',
    'd1_migrations',
    '__drizzle_migrations',
    '__appgarden_migrations',
  ]);
  const actual = r[1].results
    .filter((row) => row.type === 'table' && !excluded.has(row.name))
    .map((row) => row.name)
    .sort();
  if (JSON.stringify(actual) !== JSON.stringify([...names].sort()))
    throw new ApiError(
      'Esquema incompatible: hay tablas sin clasificar; no se puede garantizar una copia completa',
      409,
    );
  for (const name of names)
    for (const op of ['insert', 'update', 'delete']) {
      if (
        !r[1].results.some(
          (row) => row.type === 'trigger' && row.tbl_name === name && row.name === `backup_clock_${name}_${op}`,
        )
      )
        throw new ApiError('Faltan triggers de coherencia; no se inicia una copia sin garantías', 503);
    }
  const inventory = names.map((name, i) => ({ table: name, ...r[i + 2].results[0] }));
  if (
    inventory.some(
      (row) =>
        !Number.isSafeInteger(row.rows) ||
        (row.rows > 0 &&
          (!Number.isSafeInteger(row.first) ||
            row.first < 1 ||
            !Number.isSafeInteger(row.last) ||
            row.last >= Number.MAX_SAFE_INTEGER)),
    )
  )
    throw new ApiError('Identificadores rowid no compatibles con este formato; no se inicia una copia parcial', 409);
  const payload = {
    format: 'vacaciones-backup-v2',
    schemaVersion: 'vacaciones-schema-0026',
    inventory,
    revision: r[0].results[0].revision,
    createdAt: new Date().toISOString(),
    tables: backupColumns,
    schema: r[1].results,
    exclusions: [
      'Sesiones e intentos de autenticación (credenciales no portables)',
      'Aserciones transitorias, relojes técnicos y metadatos del motor/migraciones',
    ],
  };
  return { payload, sha256: await hash(payload) };
}
type Cursor = { table: number; row: number; offset: number };
export async function backupPage(repo: Repository, actor: Principal, input: unknown) {
  requireSuper(actor);
  const { revision, cursor } = (input ?? {}) as { revision: number; cursor: Cursor };
  const names = Object.keys(backupColumns);
  if (
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    !cursor ||
    !Number.isSafeInteger(cursor.table) ||
    cursor.table < 0 ||
    cursor.table > names.length ||
    !Number.isSafeInteger(cursor.row) ||
    cursor.row < 0 ||
    !Number.isSafeInteger(cursor.offset) ||
    cursor.offset < 1
  )
    throw new ApiError('Cursor no válido');
  const table = names[cursor.table];
  const columns = table ? backupColumns[table as keyof typeof backupColumns] : [];
  const json = `json_object(${columns.map((c) => `'${c}',"${c}"`).join(',')})`;
  const r = await repo.batch([
    { sql: revisionSQL },
    ...(table
      ? [
          {
            // Never return a whole large row. SQLite handles slicing; Worker memory is bounded.
            // Each row gets what is left of the page's budget after the rows before it.
            sql: `WITH t AS (SELECT rowid AS row, length(${json}) AS size,
                    CASE WHEN rowid=?1 THEN ?2 ELSE 1 END AS start FROM "${table}" WHERE rowid>=?1 ORDER BY rowid LIMIT ${PAGE_ROWS}),
                  b AS (SELECT row, size, start, coalesce(sum(size-start+1) OVER (ORDER BY row ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) AS before FROM t)
                  SELECT b.row, b.size, substr(${json}, b.start, ${PAGE_CHARS}-b.before) AS data
                  FROM b JOIN "${table}" ON "${table}".rowid=b.row WHERE b.before<${PAGE_CHARS} ORDER BY b.row`,
            args: [cursor.row, cursor.offset],
          },
        ]
      : [{ sql: schemaSQL }]),
  ]);
  if (r[0].results[0]?.revision !== revision)
    throw new ApiError('La base cambió durante la copia; descarta el parcial y vuelve a empezar', 409);
  const chunks: { row: number; offset: number; data: string; complete: boolean }[] = [];
  let next: Cursor | null = null;
  if (table) {
    next = { table: cursor.table + 1, row: 0, offset: 1 };
    for (const row of r[1].results) {
      let offset = row.row === cursor.row ? cursor.offset : 1;
      if (offset > row.size || !row.data) throw new ApiError('Cursor fuera de la fila');
      // SQLite counts characters as code points: split the slice the same way.
      const chars = [...(row.data as string)];
      for (let i = 0; i < chars.length; i += CHUNK) {
        // Only whole fragments before the row's end: the budget may cut one short.
        if (i + CHUNK > chars.length && offset + chars.length - i <= row.size) break;
        const data = chars.slice(i, i + CHUNK).join('');
        const complete = offset + CHUNK > row.size;
        chunks.push({ row: row.row, offset, data, complete });
        next = complete
          ? { table: cursor.table, row: row.row + 1, offset: 1 }
          : { table: cursor.table, row: row.row, offset: offset + CHUNK };
        offset += CHUNK;
      }
      // The slice ended inside the row: the next page reads on from there.
      if (offset <= row.size) break;
    }
  }
  const payload = { revision, cursor, chunks, next, ...(table ? {} : { schemaSha256: await hash(r[1].results) }) };
  return { payload, sha256: await hash(payload) };
}
export { firstCursor };
