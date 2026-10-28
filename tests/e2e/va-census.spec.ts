import { test, expect } from '@playwright/test';

const origin = 'http://127.0.0.1:5199';
/** Sidebar buttons on desktop, top links on mobile. */
const section = (page: import('@playwright/test').Page, name: string) =>
  page.getByRole('button', { name, exact: true }).or(page.getByRole('link', { name, exact: true }));

/** Explicit 2027 fixture: C06 has seniority 2006, so 21 years and 1 VA day.
 * Other specs also create 2027 campaigns; this test must work alone or after them.
 */
test(
  'el administrador vincula un acceso en Administración › Antigüedad, sin elegir equipo, y esa persona ve sus días',
  { tag: '@both' },
  async ({ page, request }) => {
    await request.get('/signin-with-chatgpt?return_to=/');
    let index = await (await request.get('/api/index')).json();
    if (!index.campaigns.length) {
      const initialized = await request.post('/api/initialize', { data: {}, headers: { Origin: origin } });
      expect(initialized.ok(), await initialized.text()).toBeTruthy();
      index = await (await request.get('/api/index')).json();
    }
    if (!index.campaigns.some((c: { year: number }) => c.year === 2027)) {
      const created = await request.post('/api/campaigns', {
        data: { year: 2027, copyYear: 2026 },
        headers: { Origin: origin },
      });
      expect(created.ok(), await created.text()).toBeTruthy();
      index = await (await request.get('/api/index')).json();
    }
    expect(index.va).toMatchObject({ year: 2027, entry: true, admin: true });
    await page.context().addCookies((await request.storageState()).cookies);
    const email = 'va-e2e@sites.test';
    try {
      await page.goto('/administracion/antiguedad');
      await expect(page.getByRole('heading', { name: 'Administración de VA' })).toBeVisible();
      await expect(page.getByRole('navigation', { name: 'Tipo de administración' })).toContainText('Ordinarias');
      const panel = page.getByRole('region', { name: 'Censo y accesos de VA' });
      await expect(panel.getByRole('heading', { name: 'Censo y accesos de VA · 2027' })).toBeVisible();
      await expect(panel).toContainText('Cupos de RRHH sin cargar');
      await panel.getByLabel('Buscar en el censo de VA').fill('C06');
      await panel.getByRole('button', { name: /^C06/ }).click();
      const access = panel.getByLabel('Acceso VA de C06', { exact: true });
      await access.fill(email);
      await access.press('Tab');
      await expect(panel.getByRole('status').filter({ hasText: 'Guardado' })).toBeVisible();

      await page.goto('/signin-with-chatgpt?como=' + email);
      await page.goto('/');
      await expect(section(page, 'Antigüedad').first()).toBeVisible();
      await page.goto('/antiguedad');
      const right = page.getByRole('region', { name: 'Tus días de VA' });
      await expect(right).toContainText('21 años de antigüedad');
      await expect(right).toContainText('1 día');
      await expect(right).toContainText('01/01/2006');
      const width = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      expect(width).toBeLessThanOrEqual(0);
    } finally {
      // Leave the shared e2e database as other specs expect it.
      const census = await (await request.get('/api/va/census')).json();
      const row = census.people?.find((p: { code: string }) => p.code === 'C06');
      if (row?.account)
        await request.post('/api/va/account', {
          data: { personId: row.personId, subject: '', accountVersion: row.account.version },
          headers: { Origin: origin },
        });
    }
  },
);

test('un controlador sin derecho no ve la entrada «Antigüedad»', async ({ page }) => {
  await page.goto('/signin-with-chatgpt?como=sin-derecho@sites.test');
  await page.goto('/');
  await expect(section(page, 'Vacaciones').first()).toBeVisible();
  await expect(section(page, 'Antigüedad')).toHaveCount(0);
});
