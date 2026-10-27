import { test, expect } from '@playwright/test';

test('versión sencilla y PDF de la situación son públicos y de solo lectura', async ({ page, request }) => {
  await request.get('/signin-with-chatgpt?return_to=/');
  let index = await (await request.get('/api/index')).json();
  if (!index.campaigns.length)
    index = await (
      await request.post('/api/initialize', { data: {}, headers: { Origin: 'http://127.0.0.1:5199' } })
    ).json();
  const anonymous = await page.request.get('/lite?equipo=A&year=2026');
  expect(anonymous.ok(), await anonymous.text()).toBeTruthy();
  const html = await anonymous.text();
  expect(html).not.toContain('<script');
  await page.goto('/lite?equipo=A&year=2026');
  await expect(page.getByRole('heading', { name: 'Equipo A · 2026' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Ciclos y plazas libres' })).toBeVisible();
  const pdf = await page.request.get('/lite/pdf?equipo=A&year=2026');
  expect(pdf.headers()['content-type']).toBe('application/pdf');
  expect(pdf.headers()['content-disposition']).toMatch(/^inline/);
  expect((await pdf.body()).subarray(0, 8).toString()).toBe('%PDF-1.4');
  await page.goto('/lite');
  await expect(page.getByRole('link', { name: 'A', exact: true }).first()).toBeVisible();
});
