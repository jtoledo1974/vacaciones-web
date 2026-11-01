import { test, expect } from '@playwright/test';

test('diagnóstico restringido a administrador y solo lectura de D1', async ({ request }) => {
  const path = '/api/diagnostics/database';
  expect((await request.get(path)).status()).toBe(403);
  const login = await request.post('/api/local-admin/login', {
    headers: { Origin: 'http://127.0.0.1:5199', 'CF-Connecting-IP': '192.0.2.110' },
    data: { username: 'qa-superadmin', password: 'Only-for-isolated-e2e-testing-12345' },
  });
  expect(login.status()).toBe(200);
  // The check needs an initialized database; an earlier spec in the run may already have done it.
  const initialized = await request.post('/api/initialize', {
    data: {},
    headers: { Origin: 'http://127.0.0.1:5199' },
  });
  if (initialized.status() !== 200) {
    expect(initialized.status()).toBe(409);
    expect(await initialized.text()).toContain('ya está inicializado');
  }
  const before = await (await request.get('/api/revision')).json();
  const response = await request.get(path);
  expect(response.status()).toBe(200);
  expect(response.headers()['cache-control']).toBe('no-store');
  const result = await response.json();
  expect(result.ok).toBe(true);
  expect(result.requestId).toMatch(/^[0-9a-f-]{36}$/);
  expect(result.checks.map((check: { name: string; ok: boolean }) => [check.name, check.ok])).toEqual([
    ['connection', true],
    ['app_state', true],
  ]);
  expect(await (await request.get('/api/revision')).json()).toEqual(before);
  expect((await request.post(path, { data: {}, headers: { Origin: 'http://127.0.0.1:5199' } })).status()).toBe(404);
});
