import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createApiClient, withPreview } from '../app/api-client.ts';

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : /\.tsx?$/.test(name) ? [path] : [];
  });
}

test('only app/api-client.ts calls fetch on /api', () => {
  const offenders = sources('app').filter(
    (path) => path !== join('app', 'api-client.ts') && /fetch\(\s*['"`]\/api/.test(readFileSync(path, 'utf8')),
  );
  assert.deepEqual(offenders, []);
});

test('withPreview only propagates verComo to campaign and election routes', () => {
  assert.equal(withPreview('campaign/c1', '?verComo=JUAN'), 'campaign/c1?verComo=JUAN');
  assert.equal(
    withPreview('election/c1/impact?version=2', '?verComo=J%20B'),
    'election/c1/impact?version=2&verComo=J%20B',
  );
  assert.equal(withPreview('admin', '?verComo=JUAN'), 'admin');
  assert.equal(withPreview('campaign/c1', ''), 'campaign/c1');
});

test('the client adds the Bearer token, verComo, no-store and the JSON body', async (t) => {
  const calls: { url: string; init: RequestInit }[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response('{"ok":true}', { status: 200 });
  });
  const scope = globalThis as { location?: unknown };
  scope.location = { search: '?verComo=ANA' };
  t.after(() => {
    delete scope.location;
  });
  const { api, apiFetch } = createApiClient(async () => 'tok');
  assert.deepEqual(await api('election/c1/options?selected=x'), { ok: true });
  assert.equal(calls[0].url, '/api/election/c1/options?selected=x&verComo=ANA');
  assert.equal(calls[0].init.cache, 'no-store');
  assert.equal(calls[0].init.method, 'GET');
  assert.deepEqual(calls[0].init.headers, { Authorization: 'Bearer tok' });
  await api('users', { body: { a: 1 } });
  assert.equal(calls[1].url, '/api/users');
  assert.equal(calls[1].init.method, 'POST');
  assert.equal(calls[1].init.body, '{"a":1}');
  assert.deepEqual(calls[1].init.headers, { Authorization: 'Bearer tok', 'Content-Type': 'application/json' });
  await apiFetch('auth-config', { auth: false });
  assert.deepEqual(calls[2].init.headers, {});
});

test('errors carry the server message or the fallback', async (t) => {
  let body = '{"error":"Sin permiso"}';
  t.mock.method(globalThis, 'fetch', async () => new Response(body, { status: 403 }));
  const { api } = createApiClient(async () => null);
  await assert.rejects(api('admin'), /Sin permiso/);
  body = '{}';
  await assert.rejects(api('admin', {}, 'Fallo propio'), /Fallo propio/);
});
