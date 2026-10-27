import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const COOKIE = '__Host-vacaciones-local-admin=v2.prueba';

interface Fake {
  loginStatus?: number;
  role?: string;
  backup?: unknown;
  postStatus?: number;
  logoutDrops?: boolean;
}

function validBackup() {
  const payload = { format: 'vacaciones-backup-v1', revision: 7, tables: { teams: [{ id: 'D' }] } };
  return { payload, sha256: createHash('sha256').update(JSON.stringify(payload)).digest('hex') };
}

/** Minimal stand-in for the API: records every request the CLI makes. */
async function withServer(fake: Fake, run: (origin: string, calls: string[]) => Promise<void>) {
  const calls: string[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const route = req.method + ' ' + req.url;
    calls.push(route);
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    req.resume();
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
    await run('http://127.0.0.1:' + (server.address() as AddressInfo).port, calls);
  } finally {
    server.close();
  }
}

function cli(origin: string, args: string[], input = '{}') {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = execFile(
      process.execPath,
      ['scripts/admin-cli.mjs', ...args],
      {
        env: {
          ...process.env,
          VACACIONES_URL: origin,
          VACACIONES_ADMIN_USER: 'cli',
          VACACIONES_ADMIN_PASSWORD: 'secreto',
        },
      },
      (error, stdout, stderr) =>
        resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, stderr }),
    );
    child.stdin!.end(input);
  });
}

const scratch = () => mkdtempSync(path.join(tmpdir(), 'admin-cli-'));

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
