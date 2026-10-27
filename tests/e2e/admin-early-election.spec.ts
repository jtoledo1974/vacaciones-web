import { expect, test, type APIRequestContext } from '@playwright/test';

type Member = { id: string; code: string; person_id: string };
type Account = { member_id: string; principal_key: string; version: number };
type Campaign = { id: string; team_id: string; year: number; scope_key: string };

// Only the isolated local Playwright database is used. Never target a deployed Site.
const origin = 'http://127.0.0.1:5199';

async function post(api: APIRequestContext, path: string, body: unknown) {
  const response = await api.post('/api/' + path, { data: body, headers: { Origin: origin } });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}
async function read(api: APIRequestContext, id: string) {
  const response = await api.get('/api/campaign/' + id);
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}
async function election(api: APIRequestContext, id: string, body: object) {
  const campaign = await read(api, id);
  return post(api, 'election/' + id, { ...body, version: campaign.campaign.version });
}

test('quien administra y es el siguiente puede elegir por adelantado para sí', async ({ page, request }) => {
  await request.get('/signin-with-chatgpt?return_to=/');
  await page.context().addCookies((await request.storageState()).cookies);
  const session = await (await request.get('/api/session')).json();
  let index = await (await request.get('/api/index')).json();
  if (!index.campaigns.length) index = await post(request, 'initialize', {});
  const live = index.campaigns.find((c: Campaign) => c.team_id === 'C' && c.year === 2026 && c.scope_key === 'live');
  const before = await read(request, live.id);
  const controller = before.members[0];
  const original = before.election.accounts.find((a: Account) => a.member_id === controller.id);
  const originalKey: string = original?.principal_key ?? '';
  const originalProvider = originalKey.startsWith('firebase:') ? 'firebase' : 'chatgpt';
  const originalSubject = originalKey ? originalKey.slice(originalProvider.length + 1) : '';
  await election(request, live.id, {
    action: 'link_account',
    memberId: controller.id,
    provider: 'chatgpt',
    subject: session.identity.email,
    accountVersion: original?.version ?? 0,
  });
  try {
    const linked = await read(request, live.id);
    const cloned = await post(request, 'simulations/' + live.id, {
      name: 'Anticipada admin ' + crypto.randomUUID().slice(0, 8),
      version: linked.campaign.version,
    });
    const simulation = await read(request, cloned.id);
    const own = simulation.members.find((m: Member) => m.person_id === controller.person_id);
    const first = simulation.members.find((m: Member) => m.id !== own.id);
    const rest = simulation.members.filter((m: Member) => m.id !== own.id && m.id !== first.id);
    const order = [first, own, ...rest];
    await post(request, 'campaign/' + cloned.id, {
      action: 'config',
      version: simulation.campaign.version,
      config: {
        ...simulation.config,
        previousScores: Object.fromEntries(order.map((m: Member, i: number) => [m.code, 10 + i * 10])),
        previousScoresSource: 'Puntuaciones ficticias para la anticipada',
      },
    });
    await election(request, cloned.id, {
      action: 'start',
      order: order.map((m: Member) => m.id),
      source: 'Orden ficticio para la anticipada',
      rulesConfirmed: true,
      allowDeferral: false,
    });
    const started = await read(request, cloned.id);
    expect(started.election.turn.memberId).toBe(first.id);
    const date: string = started.election.early.guaranteed[0];
    expect(date).toBeTruthy();

    await page.goto('/?equipo=C&year=2026');
    await page.getByLabel('Escenario', { exact: true }).selectOption(cloned.id);
    await expect(page.getByRole('heading', { name: first.code + ' elige ahora', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Elegir por adelantado', exact: true }).click();
    const banner = page.getByRole('status').filter({ hasText: 'Eligiendo por adelantado para ti' });
    await expect(banner).toBeVisible();
    await page.locator('.vac2-cycle[data-cycle-date="' + date + '"]').click();
    await page.getByRole('button', { name: 'Confirmar', exact: true }).click();
    await expect(banner).toBeHidden();
    await expect(page.getByRole('heading', { name: first.code + ' elige ahora', exact: true })).toBeVisible();
    const after = await read(request, cloned.id);
    expect(
      after.awards
        .filter((a: { member_id: string }) => a.member_id === own.id)
        .map((a: { cycle_date: string }) => a.cycle_date),
    ).toEqual([date]);
    expect(after.election.turn.memberId).toBe(first.id);
  } finally {
    const current = await read(request, live.id);
    const account = current.election.accounts.find((a: Account) => a.member_id === controller.id);
    await election(request, live.id, {
      action: 'link_account',
      memberId: controller.id,
      provider: originalProvider,
      subject: originalSubject,
      accountVersion: account?.version ?? 0,
    });
  }
});
