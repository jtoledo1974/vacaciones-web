import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { PushConfig } from '../server/web-push.ts';
import { drizzle } from 'drizzle-orm/sqlite-proxy';
import { migrate } from 'drizzle-orm/sqlite-proxy/migrator';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import {
  approveCli,
  cleanupCliSessions,
  cliIdentity,
  cliPairingStatus,
  cliTokenHash,
  joinCli,
  pairCli,
  revokeCli,
  CLI_SESSION_MS,
} from '../server/cli-auth.ts';
import { principal, Service } from '../server/service.ts';
import { dispatchNotifications } from '../server/notifications.ts';
import { SQLiteRepo } from './sqlite-repo.ts';

const identity = { provider: 'chatgpt', subject: 'owner', email: 'owner@example.test', emailVerified: true };
const actor = { id: 'chatgpt:owner', role: 'superadmin' as const, teams: [] };
const other = { ...actor, id: 'chatgpt:other' };
const origin = 'https://vacaciones.example.test';
const browser = () => new Request(origin + '/api/cli-auth/approve', { method: 'POST', headers: { Origin: origin } });
const terminal = (token: string, ip = '203.0.113.1') =>
  new Request(origin + '/api/cli-auth/join', {
    method: 'POST',
    headers: { Origin: origin, 'X-Vacaciones-CLI-Token': token, 'cf-connecting-ip': ip },
  });
const call = (token: string, method = 'GET', path = '/api/session', body?: string) =>
  new Request(origin + path, { method, headers: { 'X-Vacaciones-CLI-Token': token }, body });
const newCode = () => randomBytes(8).toString('hex').toUpperCase();
const newToken = () => randomBytes(32).toString('hex');
const read = { method: 'GET', path: '/api/campaign/x' };

/** Full happy path up to the browser approval; returns what both sides hold. */
async function authorize(repo: SQLiteRepo, operation: object = read) {
  const code = newCode(),
    token = newToken();
  const { pairing } = await pairCli(browser(), repo, identity, actor, code.match(/.{4}/g)!.join('-').toLowerCase());
  assert.deepEqual(await joinCli(terminal(token), repo, code, operation), { status: 'joined' });
  await approveCli(browser(), repo, identity, actor, pairing);
  return { code, token, pairing };
}

test('pairing, join and approval delegate the browser identity; secrets are stored only as hashes', async () => {
  const repo = new SQLiteRepo();
  const code = newCode(),
    token = newToken();
  // The terminal may join before the browser pairs: it just keeps waiting.
  assert.deepEqual(await joinCli(terminal(token), repo, code, read), { status: 'waiting' });
  const { pairing } = await pairCli(browser(), repo, identity, actor, code);
  assert.deepEqual(await cliPairingStatus(browser(), repo, identity, actor, pairing), {
    status: 'waiting',
    operation: null,
  });
  await assert.rejects(cliIdentity(call(token), repo), /pendiente/);
  await joinCli(terminal(token), repo, code, read);
  assert.deepEqual(await cliPairingStatus(browser(), repo, identity, actor, pairing), {
    status: 'joined',
    operation: { ...read, backup: false },
  });
  await assert.rejects(cliIdentity(call(token), repo), /pendiente/);
  await approveCli(browser(), repo, identity, actor, pairing);
  assert.deepEqual(await joinCli(terminal(token), repo, code, read), { status: 'approved' });
  assert.deepEqual(await cliIdentity(call(token), repo), identity);
  assert.deepEqual(await cliIdentity(call(token, 'GET', '/api/campaign/x'), repo), identity);
  const rows = await repo.all('SELECT * FROM cli_sessions');
  assert.equal(rows[0].token_hash, await cliTokenHash(token));
  assert.ok(!JSON.stringify(rows).includes(token) && !JSON.stringify(rows).includes(code));
  assert.ok(rows[0].expires_at <= Date.now() + CLI_SESSION_MS);
  const audit = await repo.all("SELECT action,actor FROM audit WHERE action LIKE 'cli_%'");
  assert.deepEqual(
    audit.map((row) => ({ ...row })),
    [{ action: 'cli_authorized', actor: actor.id }],
  );
  repo.db.close();
});

test('rejects anonymous, non-superadmin, cross-origin, local-admin and recursive pairing', async () => {
  const repo = new SQLiteRepo(),
    code = newCode();
  await assert.rejects(pairCli(browser(), repo, null, actor, code), /navegador/);
  await assert.rejects(
    pairCli(browser(), repo, identity, { ...actor, role: 'team_admin' }, code),
    /superadministrador/,
  );
  await assert.rejects(
    pairCli(new Request(origin, { headers: { Origin: 'https://evil.test' } }), repo, identity, actor, code),
    /Origen/,
  );
  await assert.rejects(pairCli(browser(), repo, { ...identity, provider: 'local_admin' }, actor, code), /navegador/);
  await assert.rejects(
    pairCli(
      new Request(origin, { headers: { Origin: origin, 'X-Vacaciones-CLI-Token': newToken() } }),
      repo,
      identity,
      actor,
      code,
    ),
    /navegador/,
  );
  await assert.rejects(pairCli(browser(), repo, identity, actor, 'ABCD'), /16 caracteres/);
  assert.equal((await repo.all('SELECT * FROM cli_sessions')).length, 0);
  repo.db.close();
});

test('a wrong code, another terminal or an invalid operation cannot take over a pairing', async () => {
  const repo = new SQLiteRepo(),
    code = newCode(),
    token = newToken();
  await pairCli(browser(), repo, identity, actor, code);
  await assert.rejects(joinCli(terminal(token), repo, 'nope', read), /Código/);
  assert.deepEqual(await joinCli(terminal(token), repo, newCode(), read), { status: 'waiting' });
  for (const operation of [
    { method: 'DELETE', path: '/api/x' },
    { method: 'GET', path: 'https://evil.test/api/x' },
    { method: 'GET', path: '/api/cli-auth/approve' },
    { method: 'GET', path: '/api/../x' },
    { method: 'POST', path: '/api/x' },
    null,
  ])
    await assert.rejects(joinCli(terminal(token), repo, code, operation), /no válida/);
  await joinCli(terminal(token), repo, code, read);
  await assert.rejects(joinCli(terminal(newToken()), repo, code, read), /otra terminal/);
  await assert.rejects(joinCli(terminal(token), repo, code, { ...read, path: '/api/admin' }), /otra terminal/);
  await assert.rejects(pairCli(browser(), repo, identity, actor, code), /ya se ha usado/);
  repo.db.close();
});

test('approval is single-use, bound to its administrator and audited when refused', async () => {
  const repo = new SQLiteRepo(),
    code = newCode(),
    token = newToken();
  const { pairing } = await pairCli(browser(), repo, identity, actor, code);
  await assert.rejects(approveCli(browser(), repo, identity, actor, pairing), /ya fue autorizada/);
  await joinCli(terminal(token), repo, code, read);
  await assert.rejects(cliPairingStatus(browser(), repo, identity, other, pairing), /no pertenece/);
  await assert.rejects(approveCli(browser(), repo, identity, other, pairing), /otra cuenta/);
  await approveCli(browser(), repo, identity, actor, pairing);
  const [before] = await repo.all('SELECT * FROM cli_sessions');
  await assert.rejects(
    approveCli(browser(), repo, { ...identity, subject: 'other' }, actor, pairing),
    /ya fue autorizada/,
  );
  assert.deepEqual(await repo.all('SELECT * FROM cli_sessions'), [before]);
  await assert.rejects(approveCli(browser(), repo, identity, actor, 'invalid'), /no válido/);
  const audit = await repo.all("SELECT action FROM audit WHERE action LIKE 'cli_%' ORDER BY created_at");
  assert.equal(audit.filter((a) => a.action === 'cli_authorized').length, 1);
  assert.equal(audit.filter((a) => a.action === 'cli_authorization_rejected').length, 3);
  repo.db.close();
});

test('the delegated session is limited to the approved method, path and body', async () => {
  const repo = new SQLiteRepo();
  const body = JSON.stringify({ a: 1 });
  const write = { method: 'POST', path: '/api/campaign/x?y=1', bodyHash: await cliTokenHash(body), backup: true };
  const { token } = await authorize(repo, write);
  assert.deepEqual(await cliIdentity(call(token, 'GET', '/api/backup'), repo), identity);
  await assert.rejects(cliIdentity(call(token, 'POST', '/api/campaign/x?y=1', '{"a":2}'), repo), /difiere/);
  await assert.rejects(cliIdentity(call(token, 'POST', '/api/campaign/z', body), repo), /fuera/);
  await assert.rejects(cliIdentity(call(token, 'GET', '/api/admin'), repo), /fuera/);
  // Rejected attempts do not consume it; the authorized write runs exactly once.
  assert.deepEqual(await cliIdentity(call(token, 'POST', '/api/campaign/x?y=1', body), repo), identity);
  const replays = await Promise.allSettled([
    cliIdentity(call(token, 'POST', '/api/campaign/x?y=1', body), repo),
    cliIdentity(call(token, 'POST', '/api/campaign/x?y=1', body), repo),
  ]);
  for (const replay of replays) assert.match(String((replay as PromiseRejectedResult).reason), /ya se envió/);
  await assert.rejects(cliIdentity(call(token, 'GET', '/api/backup'), repo), /ya se envió/);
  await assert.rejects(cliIdentity(call(token), repo), /ya se envió/);
  const [consumed] = await repo.all('SELECT status,identity_json FROM cli_sessions WHERE token_hash=?', [
    await cliTokenHash(token),
  ]);
  assert.deepEqual({ ...consumed }, { status: 'consumed', identity_json: null });
  const { token: reader } = await authorize(repo);
  await assert.rejects(cliIdentity(call(reader, 'GET', '/api/backup'), repo), /fuera/);
  // Reads are idempotent and may be repeated within the authorization.
  await cliIdentity(call(reader, 'GET', '/api/campaign/x'), repo);
  await cliIdentity(call(reader, 'GET', '/api/campaign/x'), repo);
  const delegated = await cliIdentity(call(reader), repo);
  assert.equal((await principal(repo, delegated, identity.email)).role, 'superadmin');
  assert.equal((await principal(repo, delegated, '')).role, 'viewer');
  repo.db.close();
});

test('revocation works before and after approval and fences late joins and approvals', async () => {
  const repo = new SQLiteRepo();
  const revoke = (token: string, code: string) => revokeCli(terminal(token), repo, code);
  // Cancelled before the browser even paired: the code can no longer be used.
  const early = newCode(),
    earlyToken = newToken();
  assert.deepEqual(await revoke(earlyToken, early), { ok: true });
  await assert.rejects(pairCli(browser(), repo, identity, actor, early), /ya se ha usado/);
  // Cancelled after join but before approval: the approval loses the race.
  const code = newCode(),
    token = newToken();
  const { pairing } = await pairCli(browser(), repo, identity, actor, code);
  await joinCli(terminal(token), repo, code, read);
  await revoke(token, code);
  await revoke(token, code);
  await assert.rejects(approveCli(browser(), repo, identity, actor, pairing), /cancelada/);
  await assert.rejects(joinCli(terminal(token), repo, code, read), /canceló/);
  assert.equal(await cliPairingStatus(browser(), repo, identity, actor, pairing).catch(() => null), null);
  // After approval: the token stops working; another token cannot revoke it.
  const approved = await authorize(repo);
  await revoke(newToken(), approved.code);
  assert.deepEqual(await cliIdentity(call(approved.token), repo), identity);
  await revoke(approved.token, approved.code);
  await assert.rejects(cliIdentity(call(approved.token), repo), /revocada/);
  await assert.rejects(revokeCli(terminal(token), repo, 'x'), /no válido/);
  repo.db.close();
});

test('expiry, persistent limits and the periodic dispatcher clean ephemeral rows', async () => {
  const repo = new SQLiteRepo();
  const { token } = await authorize(repo);
  await repo.batch([{ sql: 'UPDATE cli_sessions SET expires_at=1' }]);
  await assert.rejects(cliIdentity(call(token), repo), /caducada/);
  for (let i = 0; i < 4; i++) await pairCli(browser(), repo, identity, actor, newCode());
  await assert.rejects(pairCli(browser(), repo, identity, actor, newCode()), /Demasiados/);
  // Another administrator has their own budget.
  await pairCli(browser(), repo, identity, other, newCode());
  for (let i = 0; i < 30; i++) await revokeCli(terminal(newToken(), '198.51.100.9'), repo, newCode());
  await assert.rejects(revokeCli(terminal(newToken(), '198.51.100.9'), repo, newCode()), /Demasiados/);
  assert.ok((await repo.all('SELECT * FROM cli_attempts')).length > 0);
  await dispatchNotifications(
    repo,
    {} as PushConfig,
    undefined,
    async () => ({ ok: true }) as never,
    Date.now() + 2 * CLI_SESSION_MS,
  );
  assert.deepEqual(await repo.all('SELECT * FROM cli_sessions'), []);
  assert.deepEqual(await repo.all('SELECT * FROM cli_attempts'), []);
  await cleanupCliSessions(repo);
  assert.equal(await cliIdentity(new Request(origin), repo), null);
  await assert.rejects(cliIdentity(call('invalid'), repo), /no válida/);
  repo.db.close();
});

test('backups never export delegated sessions or attempts', async () => {
  const repo = new SQLiteRepo();
  const { token } = await authorize(repo);
  const backup = await new Service(repo, actor).backup();
  const text = JSON.stringify(backup);
  assert.ok(!text.includes(await cliTokenHash(token)));
  assert.ok(!('cli_sessions' in backup.payload.tables) && !('cli_attempts' in backup.payload.tables));
  repo.db.close();
});

test('the real drizzle migrator applies 0013 to a database that already recorded 0012', async () => {
  const db = new DatabaseSync(':memory:');
  const proxy = drizzle(async (sql, params, method) => {
    const query = db.prepare(sql);
    if (method === 'run') return (query.run(...(params as SQLInputValue[])), { rows: [] });
    const rows = query.all(...(params as SQLInputValue[])).map((row) => Object.values(row as object));
    return { rows: method === 'get' ? rows[0] : rows };
  });
  const run = (queries: string[]) => {
    for (const q of queries) db.exec(q);
    return Promise.resolve();
  };
  await migrate(proxy, async (queries) => run(queries), { migrationsFolder: 'drizzle' });
  // Simulate production before this change: 0012 applied and recorded, 0013 not.
  db.exec('DROP TABLE cli_sessions; DROP TABLE cli_attempts');
  const cli = readMigrationFiles({ migrationsFolder: 'drizzle' }).find((m) => m.sql.join('').includes('cli_sessions'))!;
  db.prepare('DELETE FROM __drizzle_migrations WHERE created_at=?').run(cli.folderMillis);
  await migrate(proxy, async (queries) => run(queries), { migrationsFolder: 'drizzle' });
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'cli_%' AND type='table'").all();
  assert.deepEqual(tables.map((t) => t.name).sort(), ['cli_attempts', 'cli_sessions']);
  db.close();
});
