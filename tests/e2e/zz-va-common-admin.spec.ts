import { test, expect } from '@playwright/test';

const origin = 'http://127.0.0.1:5199';

/**
 * Last on purpose: once the common VA campaign exists, «Antigüedad» shows it instead of
 * the old VA screens that earlier specs still exercise (they disappear in phase 5).
 */
test('quien solo administra VA llega a su administración común desde «Administración» y abre sus PDF', async ({
  page,
  request,
}) => {
  await request.get('/signin-with-chatgpt?return_to=/');
  if (!(await (await request.get('/api/index')).json()).campaigns.length)
    expect((await request.post('/api/initialize', { data: {}, headers: { Origin: origin } })).ok()).toBeTruthy();
  // One entitled person with validated master data is enough for the census.
  const census = await (await request.get('/api/va/census')).json();
  const person = census.people.find((p: { status: string }) => p.status === 'entitled');
  const entries = [{ personId: person.personId, date: person.seniority, employeeNumber: 7001, page: 1 }];
  const fichas = { title: 'Fichas E2E', asOf: '2026-01-05', sha256: 'e'.repeat(64) };
  if (!person.controllerNumber) {
    const preview = await (
      await request.post('/api/people/seniority', {
        data: { action: 'preview', entries, source: fichas },
        headers: { Origin: origin },
      })
    ).json();
    const applied = await request.post('/api/people/seniority', {
      data: { action: 'apply', entries, source: fichas, reviewToken: preview.reviewToken },
      headers: { Origin: origin },
    });
    expect(applied.ok(), await applied.text()).toBeTruthy();
  }
  const year = census.year;
  const body = { people: [person.personId], source: { title: 'Censo E2E', sha256: 'd'.repeat(64) } };
  const preview = await (
    await request.post(`/api/va/campaign/${year}`, {
      data: { ...body, action: 'preview' },
      headers: { Origin: origin },
    })
  ).json();
  const loaded = await request.post(`/api/va/campaign/${year}`, {
    data: { ...body, action: 'apply', reviewToken: preview.reviewToken },
    headers: { Origin: origin },
  });
  expect(loaded.ok(), await loaded.text()).toBeTruthy();

  const email = 'va-only-admin@sites.test';
  const granted = await request.post('/api/users', {
    data: { subject: email, role: 'team_admin', teams: ['va'], version: 0 },
    headers: { Origin: origin },
  });
  expect(granted.ok(), await granted.text()).toBeTruthy();

  await page.goto('/signin-with-chatgpt?como=' + email);
  await page.goto('/administracion');
  await expect(page.getByRole('button', { name: /Activar elección/ }).first()).toBeVisible();
  await expect(page.getByText('Administración reservada')).toHaveCount(0);

  // The VA PDFs go through the session, never the public /lite route.
  const cid = (await (await page.request.get('/api/index')).json()).vaCampaign.id;
  for (const path of ['pdf', 'individual-pdf?cta=' + encodeURIComponent(person.code)]) {
    const pdf = await page.request.get(`/api/campaign/${cid}/${path}`);
    expect(pdf.status(), path).toBe(200);
    expect(pdf.headers()['content-type']).toBe('application/pdf');
  }
});
