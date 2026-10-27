import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ownerKey, updateSubscription } from '../server/notifications.ts';
import type { Principal } from '../server/permissions.ts';
import type { Repository } from '../server/repository.ts';

const actor: Principal = {
  id: 'chatgpt:legacy-subject',
  emailKey: 'chatgpt-email:controller@example.test',
  role: 'viewer',
  teams: [],
};
const config = { VAPID_PUBLIC_KEY: 'public', VAPID_PRIVATE_JWK: 'private', VAPID_SUBJECT: 'mailto:admin@example.test' };

function mapped(keys: string[]): Repository {
  return { all: async () => keys.map((principal_key) => ({ principal_key })) } as unknown as Repository;
}

test('Push owner matches an older UID link, not a verified email alias', async () => {
  assert.equal(await ownerKey(mapped([actor.id]), actor), actor.id);
  assert.equal(await ownerKey(mapped([actor.emailKey!]), actor), actor.emailKey);
  assert.equal(await ownerKey(mapped([]), actor), actor.emailKey);
});

test('ambiguous UID and email links refuse Push registration', async () => {
  await assert.rejects(ownerKey(mapped([actor.id, actor.emailKey!]), actor), /más de un controlador/);
});

test('re-registering the same device can migrate between verified aliases, not other users', async () => {
  const actions: { sql: string; args: unknown[] }[] = [];
  const endpoint = 'https://push.example.test/device';
  const repo = {
    all: async (sql: string) => {
      if (sql.includes('SELECT principal_key')) return [{ principal_key: actor.id }];
      if (sql.includes('SELECT owner_key')) return [{ owner_key: actor.emailKey }];
      return [];
    },
    batch: async (ops: { sql: string; args: unknown[] }[]) => {
      actions.push(...ops);
      return [];
    },
  } as unknown as Repository;
  const body = { action: 'subscribe', subscription: { endpoint, keys: { p256dh: 'abc', auth: 'def' } } };
  assert.deepEqual(await updateSubscription(repo, actor, body, config), { ok: true });
  assert.match(actions[0].sql, /owner_key=excluded.owner_key/);
  assert.equal(actions[0].args[1], actor.id);
  await assert.rejects(
    updateSubscription(
      {
        ...repo,
        all: async (sql: string) =>
          sql.includes('SELECT principal_key')
            ? [{ principal_key: actor.id }]
            : [{ owner_key: 'chatgpt:someone-else' }],
      } as unknown as Repository,
      actor,
      body,
      config,
    ),
    /otra cuenta/,
  );
});
