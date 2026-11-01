import type { Repository, Statement } from './repository.ts';
import { backupColumns } from './backup-v2.ts';
import { diagnosticAuditSelect } from './audit-context.ts';
import { requireSuper, type Principal } from './permissions.ts';
import { ApiError } from './errors.ts';
import {
  DIAGNOSTIC_FORMAT,
  DIAGNOSTIC_SCHEMA,
  DIAGNOSTIC_MAX_BYTES,
  diagnosticTables,
  diagnosticScope,
  diagnosticByteLength,
  diagnosticHash,
  assertDiagnosticShape,
} from '../lib/campaign-diagnostic.mjs';

const columns = Object.fromEntries(
  diagnosticTables.map((name: string) => [name, backupColumns[name as keyof typeof backupColumns]]),
);
const scope = diagnosticScope() as Record<string, string>;
const bind = (sql: string, cid: string): Statement => ({ sql, args: Array((sql.match(/\?/g) ?? []).length).fill(cid) });
const select = (name: string, projection: string) =>
  name === 'audit'
    ? diagnosticAuditSelect(projection, `(${scope[name]})`)
    : `SELECT ${projection} FROM "${name}" WHERE (${scope[name]})`;
const rowExpression = (name: string) =>
  `json_object('_rowid',rowid,${columns[name].map((c: string) => `'${c}',"${c}"`).join(',')})`;
const stats = (name: string) =>
  select(name, `count(*) AS rows,coalesce(sum(length(CAST(${rowExpression(name)} AS BLOB))+1),0) AS bytes`);

/** Two read batches: a boundedness preflight, then ONE transactional capture of all rows.
 * Every capture SELECT enforces its preflight byte budget in SQL before returning data.
 * Writes between batches are allowed; growth beyond a budget aborts, never yields a partial copy.
 */
export async function exportCampaignDiagnostic(repo: Repository, actor: Principal, cid: string) {
  requireSuper(actor);
  if (!cid || cid.length > 200) throw new ApiError('Identificador de campaña inválido', 400);
  const before = await repo.batch(diagnosticTables.map((name: string) => bind(stats(name), cid)));
  if (!before[diagnosticTables.indexOf('campaigns')].results[0].rows)
    throw new ApiError('Campaña real no encontrada; no se exportan simulaciones', 404);
  if (before[diagnosticTables.indexOf('app_state')].results[0].rows !== 1)
    throw new ApiError('Falta la revisión de aplicación', 503);
  const budgets = before.map((r) => Number(r.results[0].bytes));
  // Reserve room for column lists, table names, scope and checksum.
  if (
    budgets.some((n) => !Number.isSafeInteger(n) || n < 0) ||
    budgets.reduce((a, b) => a + b, 0) > DIAGNOSTIC_MAX_BYTES - 64_000
  )
    throw new ApiError('La campaña supera el límite de diagnóstico de 24 MB; utiliza una copia v2 completa', 413);
  const statements: Statement[] = [];
  for (const [i, name] of diagnosticTables.entries()) {
    statements.push({ sql: `PRAGMA table_info("${name}")` }, bind(stats(name), cid));
    statements.push(
      bind(
        `${select(name, `rowid AS _rowid,${columns[name].map((c: string) => `"${c}"`).join(',')}`)} AND (${select(name, `coalesce(sum(length(CAST(${rowExpression(name)} AS BLOB))+1),0)`)})<=${budgets[i]} ORDER BY rowid`,
        cid,
      ),
    );
  }
  const captured = await repo.batch(statements);
  const tables: Record<string, Record<string, string | number | null>[]> = {};
  for (const [i, name] of diagnosticTables.entries()) {
    const [schema, inventory, rows] = captured.slice(i * 3, i * 3 + 3);
    if (JSON.stringify(schema.results.map((r) => r.name).sort()) !== JSON.stringify([...columns[name]].sort()))
      throw new ApiError('Esquema incompatible con el diagnóstico', 409);
    if (inventory.results[0].bytes > budgets[i] || rows.results.length !== inventory.results[0].rows)
      throw new ApiError('La campaña creció durante la preparación; vuelve a descargar el diagnóstico', 409);
    tables[name] = rows.results;
  }
  const campaign = tables.campaigns[0] as { id: string; team_id: string; year: number; scope_key: string } | undefined;
  if (!campaign || campaign.id !== cid || campaign.scope_key !== 'live')
    throw new ApiError('La campaña real dejó de estar disponible', 409);
  const payload = {
    format: DIAGNOSTIC_FORMAT,
    schemaVersion: DIAGNOSTIC_SCHEMA,
    campaignId: cid,
    team: campaign.team_id,
    year: campaign.year,
    createdAt: new Date().toISOString(),
    columns,
    tables,
    scope: 'Una campaña real con historial y contexto compartido; no es un backup global',
    exclusions: [
      'Otras campañas y simulaciones',
      'Sesiones, credenciales y colas push',
      'Auditoría global sin equipo; historial y operaciones globales VA',
    ],
  };
  try {
    assertDiagnosticShape({ payload });
  } catch {
    throw new ApiError('Datos incompatibles con el diagnóstico de campaña', 409);
  }
  if (diagnosticByteLength(payload) > DIAGNOSTIC_MAX_BYTES - 100)
    throw new ApiError('El diagnóstico codificado supera 24 MB; utiliza una copia v2 completa', 413);
  return { payload, sha256: await diagnosticHash(payload) };
}
