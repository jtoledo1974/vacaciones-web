import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  localAdminEnabled,
  localAdminIdentity,
  localAdminLogin,
  localAdminLogout,
  type LocalAdminConfig,
} from '../server/local-admin.ts';
import { principal } from '../server/service.ts';
import { SQLiteRepo } from './sqlite-repo.ts';

const config: LocalAdminConfig = {
  LOCAL_ADMIN_USERNAME: 'qa-superadmin',
  LOCAL_ADMIN_PASSWORD: 'A-long-independent-demo-passphrase-53',
  LOCAL_ADMIN_SESSION_SECRET: 'local-test-session-key-with-at-least-32-characters',
};
const url = 'https://vacaciones.example.test/api/local-admin/login';
function loginRequest(username: string, password: string, ip = '203.0.113.10'): Request {
  return new Request(url, {
    method: 'POST',
    headers: {
      Origin: 'https://vacaciones.example.test',
      'Content-Type': 'application/json',
      'CF-Connecting-IP': ip,
    },
    body: JSON.stringify({ username, password }),
  });
}
test('local password bootstrap is disabled unless all strong deployment secrets are present', () => {
  assert.equal(localAdminEnabled({}), false);
  assert.equal(localAdminEnabled({ ...config, LOCAL_ADMIN_PASSWORD: 'short' }), false);
  assert.equal(localAdminEnabled({ ...config, LOCAL_ADMIN_SESSION_SECRET: 'short' }), false);
  assert.equal(localAdminEnabled(config), true);
});
test('local password login returns a signed HttpOnly session with superadmin permissions', async () => {
  const repo = new SQLiteRepo();
  const login = await localAdminLogin(loginRequest('qa-superadmin', config.LOCAL_ADMIN_PASSWORD!), config, repo);
  assert.equal(login.status, 200);
  const header = login.headers.get('set-cookie') ?? '';
  assert.match(header, /^__Host-vacaciones-local-admin=v2\./);
  for (const attribute of ['Secure', 'HttpOnly', 'SameSite=Strict', 'Path=/']) assert.ok(header.includes(attribute));
  assert.ok(!header.includes(config.LOCAL_ADMIN_PASSWORD!));
  const cookie = header.split(';')[0];
  const request = new Request('https://vacaciones.example.test/api/session', { headers: { Cookie: cookie } });
  const identity = await localAdminIdentity(request, config, repo);
  assert.deepEqual(identity, { provider: 'local_admin', subject: 'qa-superadmin', email: '', emailVerified: false });
  const role = await principal(repo, identity, '');
  assert.equal(role.role, 'superadmin');
  assert.equal(role.id, 'local_admin:qa-superadmin');
  assert.equal(
    await localAdminIdentity(
      request,
      { ...config, LOCAL_ADMIN_SESSION_SECRET: 'different-signing-secret-with-more-than-32-characters' },
      repo,
    ),
    null,
  );
  const forged = new Request('https://vacaciones.example.test/api/session', {
    headers: { Cookie: cookie.replace('v2.', 'v2.9') },
  });
  assert.equal(await localAdminIdentity(forged, config, repo), null);
  const signedPart = cookie.split('.');
  const tampered = new Request('https://vacaciones.example.test/api/session', {
    headers: {
      Cookie: [
        signedPart[0],
        signedPart[1],
        signedPart[2],
        (signedPart[3][0] === 'A' ? 'B' : 'A') + signedPart[3].slice(1),
      ].join('.'),
    },
  });
  assert.equal(await localAdminIdentity(tampered, config, repo), null);
  const logout = await localAdminLogout(
    new Request(url, { method: 'POST', headers: { Origin: 'https://vacaciones.example.test', Cookie: cookie } }),
    config,
    repo,
  );
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie') ?? '', /Max-Age=0/);
});
test('local password login enforces origin, valid JSON, invalid credentials and per-IP throttling', async () => {
  const repo = new SQLiteRepo();
  assert.equal(
    (
      await localAdminLogin(
        new Request(url, {
          method: 'POST',
          headers: { Origin: 'https://outside.invalid', 'Content-Type': 'application/json' },
          body: '{}',
        }),
        config,
        repo,
      )
    ).status,
    403,
  );
  assert.equal((await localAdminLogin(loginRequest('wrong', config.LOCAL_ADMIN_PASSWORD!), {}, repo)).status, 404);
  for (let i = 0; i < 5; i++) {
    const response = await localAdminLogin(loginRequest('qa-superadmin', 'wrong password'), config, repo);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('set-cookie'), null);
  }
  assert.equal(
    (await localAdminLogin(loginRequest('qa-superadmin', config.LOCAL_ADMIN_PASSWORD!), config, repo)).status,
    429,
  );
  assert.equal(
    (await localAdminLogin(loginRequest('qa-superadmin', config.LOCAL_ADMIN_PASSWORD!, '203.0.113.11'), config, repo))
      .status,
    200,
  );
  const attempts = await repo.all<{ attempt_key: string }>('SELECT attempt_key FROM local_admin_attempts');
  assert.equal(attempts.length, 6);
  assert.ok(attempts.every((x) => !x.attempt_key.includes('203.0.113.10')));
  const events = await repo.all<{ action: string; after_json: string }>(
    "SELECT action,after_json FROM audit WHERE action LIKE 'local_admin%'",
  );
  assert.deepEqual(
    events.map((x) => ({ ...x })),
    [{ action: 'local_admin_login', after_json: '{}' }],
  );
});

test('sessions expire, rotate, revoke independently, and cannot be replayed after logout', async () => {
  const repo = new SQLiteRepo();
  const session = async () => {
    const r = await localAdminLogin(loginRequest('qa-superadmin', config.LOCAL_ADMIN_PASSWORD!), config, repo);
    return new Request(url, {
      method: 'POST',
      headers: { Origin: new URL(url).origin, Cookie: r.headers.get('set-cookie')!.split(';')[0] },
    });
  };
  const a = await session(),
    b = await session();
  assert.notEqual(a.headers.get('cookie'), b.headers.get('cookie'));
  assert.ok(await localAdminIdentity(a, config, repo));
  assert.equal(
    await localAdminIdentity(
      a,
      { ...config, LOCAL_ADMIN_PASSWORD: 'a-different-and-long-password-for-rotation' },
      repo,
    ),
    null,
  );
  const clock = Date.now;
  try {
    Date.now = () => clock() + 8 * 3600 * 1000 + 1000;
    assert.equal(await localAdminIdentity(a, config, repo), null);
  } finally {
    Date.now = clock;
  }
  assert.equal((await localAdminLogout(a, config, repo)).status, 200);
  assert.equal(await localAdminIdentity(a, config, repo), null);
  assert.ok(await localAdminIdentity(b, config, repo));
  assert.equal(
    (
      await localAdminLogout(
        new Request(url, {
          method: 'POST',
          headers: { Origin: 'https://evil.test', Cookie: b.headers.get('cookie')! },
        }),
        config,
        repo,
      )
    ).status,
    403,
  );
  assert.ok(await localAdminIdentity(b, config, repo));
});
test('atomic throttle admits only five concurrent attempts and recovers after window', async () => {
  const repo = new SQLiteRepo();
  const results = await Promise.all(
    Array.from({ length: 20 }, () => localAdminLogin(loginRequest('qa-superadmin', 'wrong'), config, repo)),
  );
  assert.equal(results.filter((r) => r.status === 401).length, 5);
  assert.equal(results.filter((r) => r.status === 429).length, 15);
  const clock = Date.now;
  try {
    Date.now = () => clock() + 901000;
    assert.equal(
      (await localAdminLogin(loginRequest('qa-superadmin', config.LOCAL_ADMIN_PASSWORD!), config, repo)).status,
      200,
    );
  } finally {
    Date.now = clock;
  }
});
test('malformed bodies, content types, missing origin and oversized streams fail closed', async () => {
  const repo = new SQLiteRepo();
  for (const [body, status] of [
    ['null', 401],
    ['[]', 401],
    ['{', 400],
    ['x'.repeat(2049), 413],
  ] as const) {
    const request = new Request(url, {
      method: 'POST',
      headers: { Origin: new URL(url).origin, 'Content-Type': 'application/json' },
      body,
    });
    assert.equal((await localAdminLogin(request, config, repo)).status, status);
  }
  assert.equal((await localAdminLogin(new Request(url, { method: 'POST', body: '{}' }), config, repo)).status, 403);
  assert.equal(
    (
      await localAdminLogin(
        new Request(url, {
          method: 'POST',
          headers: { Origin: new URL(url).origin, 'Content-Type': 'application/jsonp' },
          body: '{}',
        }),
        config,
        repo,
      )
    ).status,
    415,
  );
});

test('local superadmin authorizes administration and isolated mutations; anonymous and other users cannot', async () => {
  const { Service } = await import('../server/service.ts');
  const repo = new SQLiteRepo();
  const login = await localAdminLogin(loginRequest('qa-superadmin', config.LOCAL_ADMIN_PASSWORD!), config, repo);
  const request = new Request(url, { headers: { Cookie: login.headers.get('set-cookie')!.split(';')[0] } });
  const actor = await principal(repo, await localAdminIdentity(request, config, repo), '');
  const admin = new Service(repo, actor);
  await admin.init();
  const index = await admin.list(),
    live = index.campaigns[0];
  const before = await admin.view(live.id);
  const simulation = await admin.createSimulation(live.id, {
    version: live.version,
    name: 'Isolated authentication QA',
  });
  assert.ok((await admin.admin()).audit.length);
  const copy = await admin.view(simulation.id);
  assert.equal(copy.editable, true);
  const anonymous = new Service(repo, await principal(repo, null, ''));
  const other = new Service(
    repo,
    await principal(repo, { provider: 'firebase', subject: 'other-user', email: '', emailVerified: false }, ''),
  );
  for (const service of [anonymous, other]) {
    await assert.rejects(() => service.admin(), { status: 403 });
    await assert.rejects(() => service.view(simulation.id), { status: 403 });
    await assert.rejects(() => service.mutate(live.id, { action: 'close', version: live.version }), { status: 403 });
  }
  assert.deepEqual(await admin.view(live.id), before);
  const backup = await admin.backup();
  await admin.restore(backup, backup.payload.revision);
  assert.equal(await localAdminIdentity(request, config, repo), null);
});

test('sessions and attempts live in their own tables; audit only gains login and logout events', async () => {
  const repo = new SQLiteRepo();
  const login = await localAdminLogin(loginRequest('qa-superadmin', config.LOCAL_ADMIN_PASSWORD!), config, repo);
  const cookie = login.headers.get('set-cookie')!.split(';')[0],
    nonce = cookie.split('.')[2];
  const request = new Request(url, { method: 'POST', headers: { Origin: new URL(url).origin, Cookie: cookie } });
  const [row] = await repo.all<{ id: string; actor: string; revoked_at: string | null }>(
    'SELECT id,actor,revoked_at FROM local_admin_sessions',
  );
  assert.deepEqual({ ...row }, { id: nonce, actor: 'local_admin:qa-superadmin', revoked_at: null });
  // A row that expired server-side no longer authenticates, even with a valid signature.
  await repo.batch([{ sql: 'UPDATE local_admin_sessions SET expires_at=expires_at-1' }]);
  assert.equal(await localAdminIdentity(request, config, repo), null);
  await repo.batch([{ sql: 'UPDATE local_admin_sessions SET expires_at=expires_at+1' }]);
  assert.ok(await localAdminIdentity(request, config, repo));
  await localAdminLogout(request, config, repo);
  assert.ok(
    (await repo.all<{ revoked_at: string | null }>('SELECT revoked_at FROM local_admin_sessions'))[0].revoked_at,
  );
  const audit = await repo.all<{ id: string; action: string; after_json: string }>(
    "SELECT id,action,after_json FROM audit WHERE action LIKE 'local_admin%' ORDER BY rowid",
  );
  assert.deepEqual(
    audit.map((x) => [x.action, x.after_json]),
    [
      ['local_admin_login', '{}'],
      ['local_admin_logout', '{}'],
    ],
  );
  assert.ok(audit.every((x) => x.id !== nonce));
});
test('backups leave sessions out, restoring invalidates them, and old backups with session rows in audit still restore', async () => {
  const { Service } = await import('../server/service.ts');
  const repo = new SQLiteRepo();
  const login = await localAdminLogin(loginRequest('qa-superadmin', config.LOCAL_ADMIN_PASSWORD!), config, repo);
  const request = new Request(url, { headers: { Cookie: login.headers.get('set-cookie')!.split(';')[0] } });
  const admin = new Service(repo, await principal(repo, await localAdminIdentity(request, config, repo), ''));
  await admin.init();
  const backup = await admin.backup();
  assert.ok(!('local_admin_sessions' in backup.payload.tables) && !('local_admin_attempts' in backup.payload.tables));
  // Shape of a backup taken before the sessions left audit.
  const at = new Date().toISOString(),
    legacy = ['local_admin_session', 'local_admin_session_revoked', 'local_admin_login_attempt'].map((action, i) => ({
      id: 'legacy-' + i,
      actor: 'local_admin:qa-superadmin',
      action,
      team_id: null,
      campaign_id: null,
      before_json: null,
      after_json: '{}',
      created_at: at,
    }));
  const payload = {
    ...backup.payload,
    tables: { ...backup.payload.tables, audit: [...backup.payload.tables.audit, ...legacy] },
  };
  const { createHash } = await import('node:crypto');
  const old = { payload, sha256: createHash('sha256').update(JSON.stringify(payload)).digest('hex') };
  await admin.restore(old, payload.revision);
  assert.equal(await localAdminIdentity(request, config, repo), null);
  assert.equal((await repo.all('SELECT id FROM local_admin_sessions')).length, 0);
  assert.equal((await repo.all("SELECT id FROM audit WHERE id LIKE 'legacy-%'")).length, 0);
});
