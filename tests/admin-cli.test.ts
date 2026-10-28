import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const COOKIE = '__Host-vacaciones-local-admin=v2.prueba';

interface Fake {
  browser?: boolean;
  /** Successive answers to cli-auth/join: a status, an HTTP error code or 'drop'. */
  joins?: (string | number)[];
  logouts?: number[];
  slow?: string;
  slowMs?: number;
  postDrops?: boolean;
  loginStatus?: number;
  role?: string;
  backup?: unknown;
  postStatus?: number;
  logoutDrops?: boolean;
  /** Status of GET /api/session for a saved browser access. */
  sessionStatus?: number;
}

function validBackup() {
  const payload = { format: 'vacaciones-backup-v1', revision: 7, tables: { teams: [{ id: 'D' }] } };
  return { payload, sha256: createHash('sha256').update(JSON.stringify(payload)).digest('hex') };
}

/** Minimal stand-in for the API: records every request the CLI makes. */
async function withServer(
  fake: Fake,
  run: (origin: string, calls: string[], bodies: Record<string, unknown[]>) => Promise<void>,
) {
  const calls: string[] = [];
  const bodies: Record<string, unknown[]> = {};
  const joins = [...(fake.joins ?? ['waiting', 'approved'])];
  const logouts = [...(fake.logouts ?? [])];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const route = req.method + ' ' + req.url;
    calls.push(route);
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    let text = '';
    for await (const chunk of req) text += chunk;
    if (text) (bodies[route] ??= []).push(JSON.parse(text));
    if (fake.slow === route) await new Promise((resolve) => setTimeout(resolve, fake.slowMs ?? 1500));
    if (fake.browser) {
      const token = req.headers['x-vacaciones-cli-token'];
      assert.equal(req.headers.cookie, undefined);
      assert.ok(typeof token === 'string' && /^[a-f0-9]{64}$/.test(token));
      if (route === 'POST /api/cli-auth/join') {
        const next = joins.length > 1 ? joins.shift()! : joins[0];
        if (next === 'drop') return req.socket.destroy();
        return typeof next === 'number' ? json(next, { error: 'Fallo ' + next }) : json(200, { status: next });
      }
      if (route === 'POST /api/cli-auth/logout') return json(logouts.shift() ?? 200, {});
      if (route === 'GET /api/session')
        return (fake.sessionStatus ?? 200) === 200
          ? json(200, { principal: { role: fake.role ?? 'superadmin' } })
          : json(fake.sessionStatus!, { error: 'Sesión CLI pendiente, caducada o revocada' });
      if (route === 'GET /api/backup') return json(200, validBackup());
      if (req.method === 'POST' && fake.postDrops) return req.socket.destroy();
      if (req.method === 'POST') return json(fake.postStatus ?? 200, { ok: true, applied: req.url });
      return json(200, { ok: true });
    }
    if (route === 'POST /api/local-admin/login')
      return (fake.loginStatus ?? 200) === 200
        ? json(200, { ok: true }, { 'set-cookie': COOKIE + '; Path=/; HttpOnly' })
        : json(fake.loginStatus!, { error: 'Credenciales no válidas' });
    if (req.headers.cookie !== COOKIE) return json(401, { error: 'Sin sesión' });
    if (route === 'POST /api/local-admin/logout') return fake.logoutDrops ? req.socket.destroy() : json(200, {});
    if (route === 'GET /api/session') return json(200, { principal: { role: fake.role ?? 'superadmin' } });
    if (route === 'GET /api/backup') return json(200, fake.backup ?? validBackup());
    if (req.method === 'POST') return json(fake.postStatus ?? 200, { ok: true, applied: req.url });
    return json(200, { ok: true });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run('http://127.0.0.1:' + (server.address() as AddressInfo).port, calls, bodies);
  } finally {
    server.close();
  }
}

// Windows cannot deliver SIGINT to a child: there the CLI emits it to itself once it
// declares the access it requests, which runs the same handler a real Ctrl+C would.
const windowsInterrupt =
  'data:text/javascript,' +
  encodeURIComponent(`const write = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, ...rest) => {
  if (String(chunk).includes('Acceso solicitado')) setTimeout(() => process.emit('SIGINT'), 300);
  return write(chunk, ...rest);
};`);

const scratch = () => mkdtempSync(path.join(tmpdir(), 'admin-cli-'));
/** Never the real home directory: each test gets its own saved-access file unless it shares one. */
const tokenFile = () => path.join(scratch(), 'acceso.json');

function cli(origin: string, args: string[], input = '{}', interruptWhen?: RegExp, savedAccess = tokenFile()) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    let seen = '';
    const child = execFile(
      process.execPath,
      [
        ...(interruptWhen && process.platform === 'win32' ? ['--import', windowsInterrupt] : []),
        'scripts/admin-cli.mjs',
        ...args,
      ],
      {
        env: {
          ...process.env,
          VACACIONES_URL: origin,
          VACACIONES_ADMIN_USER: 'cli',
          VACACIONES_ADMIN_PASSWORD: 'secreto',
          VACACIONES_CLI_TOKEN_FILE: savedAccess,
        },
      },
      (error, stdout, stderr) =>
        resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, stderr }),
    );
    child.stdin!.end(input);
    if (interruptWhen && process.platform !== 'win32')
      child.stderr!.on('data', (chunk) => {
        seen += chunk;
        if (interruptWhen && interruptWhen.test(seen)) {
          interruptWhen = undefined;
          // Lets the request reach the (slow) fake server before interrupting.
          setTimeout(() => child.kill('SIGINT'), 300);
        }
      });
  });
}

test('CLI rejects an import without explicit order before login, including dry-run', async () => {
  await withServer({}, async (origin, calls) => {
    const input = JSON.stringify({
      action: 'import_roster',
      source: { rows: [{ code: 'AA', dates: ['2027-01-03'] }] },
    });
    for (const extra of [[], ['--dry-run']]) {
      const r = await cli(origin, ['post', 'campaign/x', '-', ...extra], input);
      assert.equal(r.code, 1);
      assert.match(r.stderr, /selectionOrder/);
    }
    assert.deepEqual(calls, []);
  });
});

test('CLI turns an unconfirmed ordered import into a preview, never a write', async () => {
  const source = {
    rows: [{ code: 'AA', dates: ['2027-01-03'] }],
    selectionOrder: [{ round: 1, code: 'AA', date: '2027-01-03' }],
  };
  const r = await cli(
    'http://127.0.0.1',
    ['post', 'campaign/x', '-', '--dry-run'],
    JSON.stringify({ action: 'import_roster', source }),
  );
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.stdout).body.action, 'preview_import_roster');
  const confirmed = await cli(
    'http://127.0.0.1',
    ['post', 'campaign/x', '-', '--dry-run', '--review-token', 'reviewed', '--accept-violations'],
    JSON.stringify({ action: 'import_roster', source }),
  );
  assert.equal(confirmed.code, 0);
  assert.equal(JSON.parse(confirmed.stdout).body.reviewToken, 'reviewed');
  assert.equal(JSON.parse(confirmed.stdout).body.acceptViolations, true);
  await withServer({}, async (origin, calls) => {
    const preview = await cli(origin, ['post', 'campaign/x', '-'], JSON.stringify({ action: 'import_roster', source }));
    assert.equal(preview.code, 0);
    assert.deepEqual(calls, [
      'POST /api/local-admin/login',
      'GET /api/session',
      'POST /api/campaign/x',
      'POST /api/local-admin/logout',
    ]);
  });
});

test('browser authorization pairs once by code, saves the access privately and keeps it', async () => {
  await withServer({ browser: true, joins: ['waiting', 'joined', 'approved'] }, async (origin, calls, bodies) => {
    const dir = scratch();
    const saved = tokenFile();
    const args = ['post', 'campaign/x?y=1', '-', '--browser', '--no-open', '--backup-dir', dir];
    const r = await cli(origin, args, '{"a": 1}', undefined, saved);
    assert.equal(r.code, 0, r.stderr);
    const code = r.stderr.match(/Código de la terminal: ([A-F0-9]{4}(?:-[A-F0-9]{4}){3})/)![1].replaceAll('-', '');
    assert.ok(r.stderr.includes('Introdúcelo en: ' + origin + '/cli\n'));
    assert.match(r.stderr, /Acceso solicitado: .*30 días/);
    assert.deepEqual(bodies['POST /api/cli-auth/join'], [{ code }, { code }, { code }]);
    assert.equal(bodies['POST /api/cli-auth/logout'], undefined);
    assert.deepEqual(calls.slice(-2), ['GET /api/backup', 'POST /api/campaign/x?y=1']);
    assert.ok(!calls.some((c) => c.includes('local-admin')));
    assert.deepEqual(JSON.parse(readFileSync(path.join(dir, readdirSync(dir)[0]), 'utf8')), validBackup());
    const stored = JSON.parse(readFileSync(saved, 'utf8'));
    assert.equal(stored.origin, origin);
    assert.equal(stored.code, code);
    assert.match(stored.token, /^[a-f0-9]{64}$/);
    assert.ok(stored.expiresAt > Date.now() + 29 * 86_400_000);
    if (process.platform !== 'win32') assert.equal(statSync(saved).mode & 0o777, 0o600);
  });
});

test('later commands reuse the saved access without asking the browser again', async () => {
  await withServer({ browser: true, joins: ['approved'] }, async (origin, calls) => {
    const saved = tokenFile();
    assert.equal((await cli(origin, ['login', '--browser', '--no-open'], '{}', undefined, saved)).code, 0);
    calls.length = 0;
    const r = await cli(origin, ['post', 'campaign/x', '-', '--browser', '--no-backup'], '{}', undefined, saved);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!r.stderr.includes('Código de la terminal'));
    assert.deepEqual(calls, ['GET /api/session', 'POST /api/campaign/x']);
  });
});

test('a saved access the server rejects, or for another origin, pairs again', async () => {
  await withServer({ browser: true, joins: ['approved'], sessionStatus: 401 }, async (origin, calls) => {
    const saved = tokenFile();
    const expiresAt = Date.now() + 86_400_000;
    writeFileSync(saved, JSON.stringify({ origin, token: 'a'.repeat(64), code: 'A'.repeat(16), expiresAt }));
    const r = await cli(origin, ['campaign', 'x', '--browser', '--no-open'], '{}', undefined, saved);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(calls, ['GET /api/session', 'POST /api/cli-auth/join', 'GET /api/campaign/x']);
    assert.notEqual(JSON.parse(readFileSync(saved, 'utf8')).token, 'a'.repeat(64));
  });
  await withServer({ browser: true, joins: ['approved'] }, async (origin, calls) => {
    const saved = tokenFile();
    const expiresAt = Date.now() + 86_400_000;
    writeFileSync(
      saved,
      JSON.stringify({ origin: 'https://otro.example', token: 'a'.repeat(64), code: 'A', expiresAt }),
    );
    assert.equal((await cli(origin, ['campaign', 'x', '--browser', '--no-open'], '{}', undefined, saved)).code, 0);
    assert.equal(calls[0], 'POST /api/cli-auth/join');
  });
});

test('a saved access that lost superadmin writes nothing', async () => {
  await withServer({ browser: true, joins: ['approved'], role: 'team_admin' }, async (origin, calls) => {
    const saved = tokenFile();
    assert.equal((await cli(origin, ['login', '--browser', '--no-open'], '{}', undefined, saved)).code, 0);
    const r = await cli(origin, ['post', 'campaign/x', '-', '--browser', '--no-backup'], '{}', undefined, saved);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /superadmin/);
    assert.ok(!calls.includes('POST /api/campaign/x'));
  });
});

test('logout revokes the saved access with retries and deletes it', async () => {
  await withServer({ browser: true, joins: ['drop', 429, 503, 'approved'], logouts: [503] }, async (origin, calls) => {
    const saved = tokenFile();
    assert.equal((await cli(origin, ['login', '--browser', '--no-open'], '{}', undefined, saved)).code, 0);
    const r = await cli(origin, ['logout', '--browser'], '{}', undefined, saved);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(calls.filter((c) => c === 'POST /api/cli-auth/logout').length, 2);
    assert.ok(!/no se pudo revocar/.test(r.stderr));
    assert.throws(() => statSync(saved));
  });
});

test('an unconfirmed revocation keeps the saved access so logout can be retried', async () => {
  await withServer({ browser: true, joins: ['approved'], logouts: [500, 500, 500] }, async (origin, calls) => {
    const saved = tokenFile();
    await cli(origin, ['login', '--browser', '--no-open'], '{}', undefined, saved);
    const stored = readFileSync(saved, 'utf8');
    const r = await cli(origin, ['logout', '--browser'], '{}', undefined, saved);
    assert.equal(r.code, 1);
    assert.equal(calls.filter((c) => c === 'POST /api/cli-auth/logout').length, 3);
    assert.match(r.stderr, /sigue activo; se conserva/);
    assert.equal(readFileSync(saved, 'utf8'), stored);
    const retry = await cli(origin, ['logout', '--browser'], '{}', undefined, saved);
    assert.equal(retry.code, 0, retry.stderr);
    assert.throws(() => statSync(saved));
  });
});

test('login over a saved access revokes it before pairing a new one', async () => {
  await withServer({ browser: true, joins: ['approved'] }, async (origin, calls, bodies) => {
    const saved = tokenFile();
    await cli(origin, ['login', '--browser', '--no-open'], '{}', undefined, saved);
    const first = JSON.parse(readFileSync(saved, 'utf8'));
    calls.length = 0;
    const r = await cli(origin, ['login', '--browser', '--no-open'], '{}', undefined, saved);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(calls.slice(0, 2), ['POST /api/cli-auth/logout', 'POST /api/cli-auth/join']);
    assert.deepEqual(bodies['POST /api/cli-auth/logout'], [{ code: first.code }]);
    assert.notEqual(JSON.parse(readFileSync(saved, 'utf8')).token, first.token);
  });
  await withServer({ browser: true, joins: ['approved'], logouts: [500, 500, 500] }, async (origin, calls) => {
    const saved = tokenFile();
    await cli(origin, ['login', '--browser', '--no-open'], '{}', undefined, saved);
    const stored = readFileSync(saved, 'utf8');
    const r = await cli(origin, ['login', '--browser', '--no-open'], '{}', undefined, saved);
    assert.equal(r.code, 1);
    assert.equal(calls.filter((c) => c === 'POST /api/cli-auth/join').length, 1);
    assert.equal(readFileSync(saved, 'utf8'), stored);
  });
});

test(
  'on Windows the access folder grants only the current user, without inheritance',
  { skip: process.platform !== 'win32' },
  async () => {
    await withServer({ browser: true, joins: ['approved'] }, async (origin) => {
      const saved = tokenFile();
      assert.equal((await cli(origin, ['login', '--browser', '--no-open'], '{}', undefined, saved)).code, 0);
      const whoami = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'whoami.exe');
      const sid = execFileSync(whoami, ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' }).match(
        /"(S-1-[\d-]+)"/,
      )![1];
      for (const target of [path.dirname(saved), saved]) {
        const sddl = execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Acl -LiteralPath '${target}').Sddl`], {
          encoding: 'utf8',
        }).trim();
        const aces = sddl.match(/\([^)]*\)/g) ?? [];
        // The folder blocks inheritance; the token file inherits only the folder's single ACE.
        if (target !== saved) assert.ok(sddl.includes('D:P'), 'herencia desactivada: ' + sddl);
        assert.ok(aces.length > 0 && aces.every((ace) => ace.endsWith(';' + sid + ')')), 'solo el usuario: ' + sddl);
      }
    });
  },
);

test('a refused or expired pairing stops polling and still revokes the unapproved token', async () => {
  await withServer({ browser: true, joins: [409] }, async (origin, calls) => {
    const r = await cli(origin, ['campaign', 'x', '--browser', '--no-open']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /409/);
    assert.deepEqual(calls, ['POST /api/cli-auth/join', 'POST /api/cli-auth/logout']);
  });
});

test('a failed write is not retried and keeps the saved access', async () => {
  const fake = { browser: true, joins: ['approved'], postStatus: 503 };
  await withServer(fake, async (origin, calls) => {
    const r = await cli(origin, ['post', 'campaign/x', '-', '--browser', '--no-open', '--no-backup']);
    assert.equal(r.code, 1);
    assert.equal(calls.filter((c) => c === 'POST /api/campaign/x').length, 1);
    assert.ok(!calls.includes('POST /api/cli-auth/logout'));
  });
});

test('cancelling while waiting for approval revokes the pending pairing and saves nothing', async () => {
  await withServer({ browser: true, joins: ['waiting'] }, async (origin, calls) => {
    const saved = tokenFile();
    const r = await cli(origin, ['campaign', 'x', '--browser', '--no-open'], '{}', /Acceso solicitado/, saved);
    assert.equal(r.code, 130, r.stderr);
    assert.equal(calls.at(-1), 'POST /api/cli-auth/logout');
    assert.ok(!calls.includes('GET /api/campaign/x'));
    assert.throws(() => statSync(saved));
  });
});

test('cancelling during the backup writes nothing', async () => {
  await withServer({ browser: true, joins: ['approved'], slow: 'GET /api/backup' }, async (origin, calls) => {
    const dir = scratch();
    const args = ['post', 'campaign/x', '-', '--browser', '--no-open', '--backup-dir', dir];
    const r = await cli(origin, args, '{}', /Acceso solicitado/);
    assert.equal(r.code, 130, r.stderr);
    assert.ok(!calls.includes('POST /api/campaign/x'));
    assert.equal(calls.at(-1), 'GET /api/backup');
    assert.deepEqual(readdirSync(dir), []);
  });
});

test('cancelling during a write waits for its outcome and reports it', async () => {
  await withServer({ browser: true, joins: ['approved'], slow: 'POST /api/campaign/x' }, async (origin, calls) => {
    const args = ['post', 'campaign/x', '-', '--browser', '--no-open', '--no-backup'];
    const r = await cli(origin, args, '{}', /Acceso solicitado/);
    assert.deepEqual(JSON.parse(r.stdout), { ok: true, applied: '/api/campaign/x' });
    assert.equal(calls.at(-1), 'POST /api/campaign/x');
  });
});

test('rejects plain HTTP outside localhost before sending credentials', async () => {
  const r = await cli('http://vacaciones.example.com', ['session']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /HTTPS/);
});

test('a rejected login makes no further requests', async () => {
  await withServer({ loginStatus: 401 }, async (origin, calls) => {
    const r = await cli(origin, ['post', 'campaign/x', '-', '--no-backup']);
    assert.equal(r.code, 1);
    assert.deepEqual(calls, ['POST /api/local-admin/login']);
  });
});

test('a session without superadmin role is revoked and nothing is written', async () => {
  await withServer({ role: 'team_admin' }, async (origin, calls) => {
    const r = await cli(origin, ['post', 'campaign/x', '-', '--no-backup']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /superadmin/);
    assert.equal(calls.at(-1), 'POST /api/local-admin/logout');
    assert.ok(!calls.includes('POST /api/campaign/x'));
  });
});

test('an invalid backup blocks the write and still logs out', async () => {
  const tampered = validBackup();
  tampered.payload.revision = 8;
  for (const backup of [tampered, { ok: true }]) {
    await withServer({ backup }, async (origin, calls) => {
      const dir = scratch();
      const r = await cli(origin, ['post', 'campaign/x', '-', '--backup-dir', dir]);
      assert.equal(r.code, 1);
      assert.match(r.stderr, /integridad/);
      assert.ok(!calls.includes('POST /api/campaign/x'));
      assert.equal(calls.at(-1), 'POST /api/local-admin/logout');
      assert.deepEqual(readdirSync(dir), []);
    });
  }
});

test('a valid backup is saved privately before the write', async () => {
  await withServer({}, async (origin, calls) => {
    const dir = scratch();
    const r = await cli(origin, ['post', 'campaign/x', '-', '--backup-dir', dir]);
    assert.equal(r.code, 0);
    assert.deepEqual(calls.slice(-3), ['GET /api/backup', 'POST /api/campaign/x', 'POST /api/local-admin/logout']);
    const [file] = readdirSync(dir);
    assert.deepEqual(JSON.parse(readFileSync(path.join(dir, file), 'utf8')), validBackup());
    if (process.platform !== 'win32') assert.equal(statSync(path.join(dir, file)).mode & 0o777, 0o600);
  });
});

test('--out replaces an existing world-readable file with a private one', async () => {
  await withServer({}, async (origin) => {
    const dir = scratch();
    const out = path.join(dir, 'respuesta.json');
    writeFileSync(out, 'viejo');
    chmodSync(out, 0o644);
    const r = await cli(origin, ['campaign', 'x', '--out', out]);
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), { ok: true });
    assert.deepEqual(readdirSync(dir), ['respuesta.json']);
    if (process.platform !== 'win32') assert.equal(statSync(out).mode & 0o777, 0o600);
  });
});

test('a failed --out after an applied POST says so and exits with 2', async () => {
  await withServer({}, async (origin) => {
    const r = await cli(origin, ['post', 'campaign/x', '-', '--no-backup', '--out', scratch()]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /SÍ se aplicó/);
    assert.deepEqual(JSON.parse(r.stdout), { ok: true, applied: '/api/campaign/x' });
  });
});

test('a server error on POST exits with 1 and logs out', async () => {
  await withServer({ postStatus: 409 }, async (origin, calls) => {
    const r = await cli(origin, ['post', 'campaign/x', '-', '--no-backup']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Error 409/);
    assert.equal(calls.at(-1), 'POST /api/local-admin/logout');
  });
});

test('a failed logout is a warning and keeps the POST result', async () => {
  await withServer({ logoutDrops: true }, async (origin) => {
    const r = await cli(origin, ['post', 'campaign/x', '-', '--no-backup']);
    assert.equal(r.code, 0);
    assert.match(r.stderr, /no se pudo cerrar la sesión/);
    assert.deepEqual(JSON.parse(r.stdout), { ok: true, applied: '/api/campaign/x' });
  });
});

test('a lost response after sending a write reports an unknown outcome and is not retried', async () => {
  await withServer({ browser: true, joins: ['approved'], postDrops: true }, async (origin, calls) => {
    const r = await cli(origin, ['post', 'campaign/x', '-', '--browser', '--no-open', '--no-backup']);
    assert.equal(r.code, 3, r.stderr);
    assert.match(r.stderr, /DESCONOCIDO/);
    assert.equal(calls.filter((c) => c === 'POST /api/campaign/x').length, 1);
    assert.equal(calls.at(-1), 'POST /api/campaign/x');
  });
});

test('a write slower than the 30 s read timeout is awaited, not aborted', async () => {
  const fake = { browser: true, joins: ['approved'], slow: 'POST /api/campaign/x', slowMs: 32000 };
  await withServer(fake, async (origin) => {
    const r = await cli(origin, ['post', 'campaign/x', '-', '--browser', '--no-open', '--no-backup']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { ok: true, applied: '/api/campaign/x' });
  });
});
