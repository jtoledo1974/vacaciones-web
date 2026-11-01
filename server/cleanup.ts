import type { Repository, Statement } from './repository.ts';
import { requireSuper, type Principal } from './permissions.ts';
import { ApiError } from './errors.ts';
import { hash } from '../lib/backup-v2.mjs';
import { compressPayloadsBatch, maintenanceCleanupEvent } from './audit-context.ts';
import { compactSessionSQL, compactableSessionSQL } from './reconstruction-compaction.ts';
const compacted = compactSessionSQL('reconstruction_sessions.json');
const compactSelection = `SELECT rowid FROM reconstruction_sessions WHERE ${compactableSessionSQL('reconstruction_sessions.json')}
  AND length(CAST(${compacted} AS BLOB)) < length(CAST(json AS BLOB)) ORDER BY rowid LIMIT 1`;

// No audit retention policy: old events may still be needed on an abandoned branch.
const categories = [
  {
    table: 'local_admin_sessions',
    columns: ['id', 'actor', 'created_at', 'expires_at', 'revoked_at'],
    where: 'expires_at<?',
    cutoff: (t: number) => Math.floor(t / 1000),
  },
  {
    table: 'local_admin_attempts',
    columns: ['id', 'attempt_key', 'created_at'],
    where: 'created_at<?',
    cutoff: (t: number) => new Date(t - 15 * 60_000).toISOString(),
  },
  {
    table: 'cli_sessions',
    columns: ['pairing_hash', 'token_hash', 'owner_key', 'identity_json', 'scope_json', 'status', 'expires_at'],
    where: 'expires_at<=?',
    cutoff: (t: number) => t,
  },
  {
    table: 'cli_attempts',
    columns: ['attempt_key', 'attempts', 'expires_at'],
    where: 'expires_at<=?',
    cutoff: (t: number) => t,
  },
];
const limit = 500;
// History conversion (ADR 0001), in batches the CLI repeats until empty.
const COMPRESS_BATCH = 100;
const selection = (c: (typeof categories)[number]) =>
  `SELECT rowid FROM ${c.table} WHERE ${c.where} ORDER BY rowid LIMIT ${limit}`;
async function planCleanup(repo: Repository, actor: Principal, cutoff = Date.now(), mode = 'expired-auth-only') {
  requireSuper(actor);
  if (!['expired-auth-only', 'compact-reconstruction-events', 'compress-audit-payloads'].includes(mode))
    throw new ApiError('Modalidad de limpieza desconocida');
  if (!Number.isSafeInteger(cutoff) || cutoff > Date.now() || cutoff < Date.now() - 15 * 60_000)
    throw new ApiError('Previsualización caducada', 409);
  let compression: Awaited<ReturnType<typeof compressPayloadsBatch>> | null = null;
  if (mode === 'compress-audit-payloads') {
    // Compaction compares audit copies in SQL, which compressed payloads defeat: it goes first.
    const [pending] = await repo.all<{ n: number }>(
      `SELECT count(*) AS n FROM reconstruction_sessions WHERE rowid IN (${compactSelection})`,
    );
    if (pending.n)
      throw new ApiError('Compacta antes las sesiones de reconstrucción (compact-reconstruction-events)', 409);
    compression = await compressPayloadsBatch(repo, COMPRESS_BATCH);
  }
  const r = await repo.batch([
    {
      sql: "SELECT b.revision, c.revision AS authRevision FROM backup_clock b CROSS JOIN cleanup_clock c WHERE b.id='main' AND c.id='main'",
    },
    ...(mode === 'compact-reconstruction-events'
      ? [
          {
            sql: `SELECT count(*) AS rows, coalesce(sum(length(CAST(json AS BLOB))-length(CAST(${compacted} AS BLOB))),0) AS bytes FROM reconstruction_sessions WHERE rowid IN (${compactSelection})`,
          },
        ]
      : categories.map((c) => ({
          sql: `SELECT count(*) AS rows, coalesce(sum(${c.columns.map((k) => `coalesce(length(CAST(${k} AS BLOB)),0)`).join('+')}),0) AS bytes FROM ${c.table} WHERE rowid IN (${selection(c)})`,
          args: [c.cutoff(cutoff)],
        }))),
  ]);
  const plan = {
    mode,
    cutoff,
    revision: r[0].results[0].revision,
    authRevision: mode === 'expired-auth-only' ? r[0].results[0].authRevision : null,
    limitPerCategory: mode === 'expired-auth-only' ? limit : mode === 'compress-audit-payloads' ? COMPRESS_BATCH : 1,
    categories: compression
      ? [
          {
            category: 'audit.payloads',
            ...compression.category,
            dependencies: 'Cada payload se descomprime exactamente al texto original antes de escribirlo',
            effect:
              'Comprime before_json/after_json de registros antiguos con el formato de las escrituras nuevas. No cambia su contenido lógico ni su orden.',
          },
        ]
      : mode === 'compact-reconstruction-events'
        ? [
            {
              category: 'reconstruction_sessions.originalEvents',
              ...r[1].results[0],
              dependencies:
                'Exige que audit conserve exactamente los premios, solicitudes, preferencias e informe que se eliminan de la copia de sesión',
              effect:
                'Compacta una sesión mediante la misma proyección que las sesiones nuevas; conserva listas de participantes y estados de repetición. No elimina sesiones ni modifica audit.',
            },
          ]
        : categories.map((c, i) => ({
            category: c.table,
            ...r[i + 1].results[0],
            dependencies: 'Solo autenticación caducada; sin referencias desde datos de negocio',
            effect: 'Elimina credenciales o límites de intentos ya caducados; no revoca accesos vigentes',
          })),
    preserved: [
      'audit completo y orden de inserción',
      'undo/redo y ramas históricas',
      'reconstrucciones activas y completadas',
      'simulaciones y borradores',
      'identidades, permisos, preferencias y datos de negocio vigentes',
      'historial de notificaciones',
    ],
    lost:
      mode === 'expired-auth-only'
        ? ['Filas técnicas caducadas de autenticación seleccionadas; no son registros de auditoría de decisiones']
        : mode === 'compress-audit-payloads'
          ? ['Nada: cambia la representación física, no el contenido']
          : [
              'Solo copias redundantes dentro de originalEvents; los originales completos siguen en audit. No se pierde ninguna capacidad histórica.',
            ],
    protectedHistoryBytesReclaimed: 0,
  };
  return { plan, token: await hash(plan), updates: compression?.updates ?? [] };
}
/** The plan and its token only: the rows a batch rewrites never leave the server. */
export async function previewCleanup(
  repo: Repository,
  actor: Principal,
  cutoff = Date.now(),
  mode = 'expired-auth-only',
) {
  const { plan, token } = await planCleanup(repo, actor, cutoff, mode);
  return { plan, token };
}
export async function applyCleanup(repo: Repository, actor: Principal, value: unknown) {
  requireSuper(actor);
  const input = value as { cutoff?: number; mode?: string; token?: string } | null;
  const preview = await planCleanup(repo, actor, input?.cutoff, input?.mode);
  if (!input?.token || input.token !== preview.token)
    throw new ApiError('El plan cambió; solicita y confirma otra previsualización', 409);
  const assertion = crypto.randomUUID();
  const ops: Statement[] = [
    {
      sql: "UPDATE backup_clock SET revision=revision+1 WHERE id='main' AND revision=? AND (? IS NULL OR ?=(SELECT revision FROM cleanup_clock WHERE id='main'))",
      args: [preview.plan.revision, preview.plan.authRevision, preview.plan.authRevision],
    },
    {
      sql: 'INSERT INTO transaction_assertions(id) VALUES(CASE WHEN changes()=1 THEN ? ELSE NULL END)',
      args: [assertion],
    },
    { sql: 'DELETE FROM transaction_assertions WHERE id=?', args: [assertion] },
    ...(preview.plan.mode === 'compress-audit-payloads'
      ? preview.updates
      : preview.plan.mode === 'compact-reconstruction-events'
        ? [{ sql: `UPDATE reconstruction_sessions SET json=${compacted} WHERE rowid IN (${compactSelection})` }]
        : categories.map((c) => ({
            sql: `DELETE FROM ${c.table} WHERE rowid IN (${selection(c)})`,
            args: [c.cutoff(preview.plan.cutoff)],
          }))),
    { sql: "UPDATE app_state SET revision=revision+1 WHERE id='main'" },
    maintenanceCleanupEvent(actor.id, preview.plan, preview.token),
  ];
  try {
    await repo.batch(ops);
  } catch (e) {
    if (String(e).includes('transaction_assertions'))
      throw new ApiError('Escritura concurrente; solicita otra previsualización', 409);
    throw e;
  }
  return {
    ok: true,
    applied: preview.plan,
    token: preview.token,
    next: 'Solicita otra previsualización para el siguiente lote; nunca reutilices este token',
  };
}
