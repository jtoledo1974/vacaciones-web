/**
 * Small Cloudflare Free Worker that retries notification delivery once per minute.
 * No election logic, no D1 binding, and no user data stored in this Worker.
 * The matching dispatch secret is configured separately in ChatGPT Sites.
 */
export async function runDispatch(env, http = fetch) {
  if (!env.SITE_ORIGIN || !env.NOTIFICATIONS_DISPATCH_SECRET) {
    throw new Error('SITE_ORIGIN or NOTIFICATIONS_DISPATCH_SECRET is missing');
  }
  const base = new URL(env.SITE_ORIGIN);
  if (base.protocol !== 'https:') throw new Error('SITE_ORIGIN must use HTTPS');
  const target = new URL('/api/notifications/dispatch', base);
  const response = await http(target.toString(), {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.NOTIFICATIONS_DISPATCH_SECRET },
    signal: AbortSignal.timeout(25_000)
  });
  if (!response.ok) throw new Error('Notification dispatch returned HTTP ' + response.status);
  return response.status;
}

export default {
  scheduled(_event, env, ctx) {
    ctx.waitUntil(runDispatch(env));
  },
  fetch() {
    return new Response('Not found', { status: 404 });
  }
};
