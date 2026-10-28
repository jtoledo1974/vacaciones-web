import type { Identity, Principal } from './permissions.ts';
import type { Repository } from './repository.ts';
import { ApiError } from './errors.ts';
import { append, appendIfChanged } from './audit-context.ts';
import { cliHash, normalizeCliCode, CLI_TOKEN_HEADER, CLI_SESSION_MS, CLI_PAIRING_MS } from '../lib/cli-protocol.mjs';
export { cliHash as cliTokenHash, CLI_TOKEN_HEADER, CLI_SESSION_MS } from '../lib/cli-protocol.mjs';

type Session = {
  pairing_hash: string;
  token_hash: string | null;
  owner_key: string | null;
  identity_json: string | null;
  status: string;
  expires_at: number;
};
const digestPattern = /^[a-f0-9]{64}$/;
/** Independent of the session lifetime: five pairings per administrator every 15 minutes. */
export const CLI_PAIR_RATE_WINDOW_MS = 15 * 60 * 1000;

/** Called on CLI traffic AND by the existing periodic notifications dispatcher. */
export async function cleanupCliSessions(repo: Repository, now = Date.now()) {
  await repo.batch([
    { sql: 'DELETE FROM cli_sessions WHERE expires_at<=?', args: [now] },
    { sql: 'DELETE FROM cli_attempts WHERE expires_at<=?', args: [now] },
  ]);
}
async function limit(repo: Repository, key: string, max: number, duration: number) {
  const now = Date.now();
  const result = await repo.batch([
    {
      sql: `INSERT INTO cli_attempts(attempt_key,attempts,expires_at) VALUES(?,1,?)
      ON CONFLICT(attempt_key) DO UPDATE SET
      attempts=CASE WHEN expires_at<=? THEN 1 ELSE attempts+1 END,
      expires_at=CASE WHEN expires_at<=? THEN excluded.expires_at ELSE expires_at END RETURNING attempts`,
      args: [await cliHash(key), now + duration, now, now],
    },
  ]);
  if (result[0].results[0].attempts > max)
    throw new ApiError('Demasiados intentos CLI. Espera antes de reintentar.', 429);
}
function origin(request: Request) {
  if (request.headers.get('origin') !== new URL(request.url).origin)
    throw new ApiError('Origen de la operación no válido', 403);
}
function browser(request: Request, identity: Identity, actor: Principal) {
  if (request.headers.has(CLI_TOKEN_HEADER) || !identity || !['chatgpt', 'firebase'].includes(identity.provider))
    throw new ApiError('Autoriza desde tu sesión del navegador', 403);
  if (!actor.id || actor.role !== 'superadmin') throw new ApiError('Esta operación requiere superadministrador', 403);
}
function token(request: Request) {
  const value = request.headers.get(CLI_TOKEN_HEADER);
  if (!value || !digestPattern.test(value)) throw new ApiError('Sesión CLI no válida', 401);
  return value;
}
function audit(actor: Principal, action: 'cli_authorization_rejected', after: object) {
  return append({
    id: crypto.randomUUID(),
    actor: actor.id,
    action,
    before: null,
    after,
    createdAt: new Date().toISOString(),
  });
}

/** Pending requests can only be created by the signed-in administrator typing the terminal code. */
export async function pairCli(request: Request, repo: Repository, identity: Identity, actor: Principal, code: unknown) {
  origin(request);
  browser(request, identity, actor);
  await cleanupCliSessions(repo);
  await limit(repo, 'pair:' + actor.id, 5, CLI_PAIR_RATE_WINDOW_MS);
  const normalized = normalizeCliCode(code);
  if (!normalized) throw new ApiError('Introduce los 16 caracteres del código de tu terminal', 400);
  const pairing = await cliHash(normalized);
  const result = await repo.batch([
    {
      sql: `INSERT INTO cli_sessions(pairing_hash,owner_key,status,expires_at) VALUES(?,?,'waiting',?)
      ON CONFLICT(pairing_hash) DO NOTHING RETURNING pairing_hash`,
      args: [pairing, actor.id, Date.now() + CLI_PAIRING_MS],
    },
  ]);
  if (!result[0].results.length)
    throw new ApiError('Ese código ya se ha usado o cancelado. Inicia una orden nueva.', 409);
  return { pairing, status: 'waiting' };
}

/** A code proves possession of the terminal. The browser still has to approve it. */
export async function joinCli(request: Request, repo: Repository, code: unknown) {
  origin(request);
  await cleanupCliSessions(repo);
  await limit(repo, 'join:' + (request.headers.get('cf-connecting-ip') ?? 'local'), 120, 60_000);
  const normalized = normalizeCliCode(code),
    hash = await cliHash(token(request));
  if (!normalized) throw new ApiError('Código CLI no válido', 400);
  const pairing = await cliHash(normalized);
  await repo.batch([
    {
      sql: `UPDATE cli_sessions SET token_hash=?,status='joined'
      WHERE pairing_hash=? AND status='waiting' AND expires_at>?`,
      args: [hash, pairing, Date.now()],
    },
  ]);
  const [row] = await repo.all<Session>('SELECT * FROM cli_sessions WHERE pairing_hash=? AND expires_at>?', [
    pairing,
    Date.now(),
  ]);
  if (!row) return { status: 'waiting' };
  if (row.status === 'revoked') throw new ApiError('La autorización se canceló', 409);
  if (row.token_hash !== hash) throw new ApiError('El código ya está emparejado con otra terminal', 409);
  return { status: row.status };
}

export async function cliPairingStatus(
  request: Request,
  repo: Repository,
  identity: Identity,
  actor: Principal,
  pairing: string,
) {
  browser(request, identity, actor);
  if (!digestPattern.test(pairing)) throw new ApiError('Emparejamiento CLI no válido', 400);
  await cleanupCliSessions(repo);
  const [row] = await repo.all<Session>('SELECT * FROM cli_sessions WHERE pairing_hash=? AND owner_key=?', [
    pairing,
    actor.id,
  ]);
  if (!row) throw new ApiError('El emparejamiento ha caducado o no pertenece a esta cuenta', 404);
  return { status: row.status };
}

export async function approveCli(
  request: Request,
  repo: Repository,
  identity: Identity,
  actor: Principal,
  pairing: unknown,
) {
  origin(request);
  browser(request, identity, actor);
  await cleanupCliSessions(repo);
  await limit(repo, 'approve:' + actor.id, 5, 60_000);
  if (typeof pairing !== 'string' || !digestPattern.test(pairing))
    throw new ApiError('Emparejamiento CLI no válido', 400);
  const now = Date.now();
  const approved = await repo.batch([
    {
      sql: `UPDATE cli_sessions SET status='approved',identity_json=?,expires_at=?
        WHERE pairing_hash=? AND owner_key=? AND status='joined' AND expires_at>? RETURNING pairing_hash`,
      args: [JSON.stringify(identity), now + CLI_SESSION_MS, pairing, actor.id, now],
    },
    appendIfChanged({
      id: crypto.randomUUID(),
      actor: actor.id,
      action: 'cli_authorized',
      before: null,
      after: { pairing },
      createdAt: new Date(now).toISOString(),
    }),
  ]);
  if (!approved[0].results.length) {
    await repo.batch([audit(actor, 'cli_authorization_rejected', { pairing })]);
    throw new ApiError('La terminal ya fue autorizada, cancelada, ha caducado o pertenece a otra cuenta', 409);
  }
  return { ok: true, durationDays: CLI_SESSION_MS / 86_400_000 };
}

/** Full API access for the token's lifetime. No role is cached: the ordinary principal
 * resolver rechecks rights on every request, so a demoted administrator loses it. */
export async function cliIdentity(request: Request, repo: Repository): Promise<Identity> {
  if (!request.headers.has(CLI_TOKEN_HEADER)) return null;
  await cleanupCliSessions(repo);
  const hash = await cliHash(token(request));
  const [row] = await repo.all<Session>('SELECT * FROM cli_sessions WHERE token_hash=? AND expires_at>?', [
    hash,
    Date.now(),
  ]);
  if (row?.status !== 'approved' || !row.identity_json)
    throw new ApiError('Sesión CLI pendiente, caducada o revocada', 401);
  return JSON.parse(row.identity_json) as Identity;
}

/** Idempotent BEFORE authentication: cancellation also fences late join/approval requests. */
export async function revokeCli(request: Request, repo: Repository, code: unknown) {
  origin(request);
  await cleanupCliSessions(repo);
  await limit(repo, 'revoke:' + (request.headers.get('cf-connecting-ip') ?? 'local'), 30, 60_000);
  const normalized = normalizeCliCode(code),
    hash = await cliHash(token(request));
  if (!normalized) throw new ApiError('Código CLI no válido', 400);
  await repo.batch([
    {
      sql: `INSERT INTO cli_sessions(pairing_hash,token_hash,status,expires_at) VALUES(?,?,'revoked',?)
      ON CONFLICT(pairing_hash) DO UPDATE SET status='revoked',identity_json=NULL,owner_key=NULL,
        expires_at=MAX(cli_sessions.expires_at,excluded.expires_at)
      WHERE cli_sessions.token_hash IS NULL OR cli_sessions.token_hash=excluded.token_hash`,
      args: [await cliHash(normalized), hash, Date.now() + CLI_SESSION_MS + CLI_PAIRING_MS],
    },
  ]);
  return { ok: true };
}
