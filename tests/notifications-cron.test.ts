import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runDispatch } from '../workers/notifications-cron/index.js';

test('Cron dispatcher calls only the protected POST endpoint', async () => {
  let calls = 0;
  const status = await runDispatch(
    { SITE_ORIGIN: 'https://example.org', NOTIFICATIONS_DISPATCH_SECRET: 'test-only' },
    async (url: string, init: RequestInit): Promise<Response> => {
      calls++;
      assert.equal(url, 'https://example.org/api/notifications/dispatch');
      assert.equal(init.method, 'POST');
      assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer test-only');
      return new Response('{}', { status: 200 });
    }
  );
  assert.equal(status, 200);
  assert.equal(calls, 1);
});

test('Cron dispatcher fails closed when the secret is missing', async () => {
  await assert.rejects(
    runDispatch({ SITE_ORIGIN: 'https://example.org' }, async () => { throw Error('Must not fetch'); }),
    /missing/
  );
});

test('Cron dispatcher reports failures for later retry', async () => {
  await assert.rejects(
    runDispatch(
      { SITE_ORIGIN: 'https://example.org', NOTIFICATIONS_DISPATCH_SECRET: 'test-only' },
      async () => new Response('Error', { status: 503 })
    ),
    /503/
  );
});
