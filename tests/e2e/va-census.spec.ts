import { test, expect } from '@playwright/test';

const origin = 'http://127.0.0.1:5199';
/** Sidebar buttons on desktop, top links on mobile. */
const section = (page: import('@playwright/test').Page, name: string) =>
  page.getByRole('button', { name, exact: true }).or(page.getByRole('link', { name, exact: true }));

/** Demo seed: 2026 campaigns; C-6 has seniority 2006, so 20 years and 1 VA day in 2026. */
test(
  'el administrador vincula un acceso en el censo de VA y esa persona ve «Mi derecho»',
  { tag: '@both' },
  async ({ page, request }) => {
    await request.get('/signin-with-chatgpt?return_to=/');
    let index = await (await request.get('/api/index')).json();
    if (!index.campaigns.length) {
      const initialized = await request.post('/api/initialize', { data: {}, headers: { Origin: origin } });
      expect(initialized.ok(), await initialized.text()).toBeTruthy();
      index = await (await request.get('/api/index')).json();
    }
    expect(index.va).toMatchObject({ year: 2026, entry: true, admin: true });
    await page.context().addCookies((await request.storageState()).cookies);
    const email = 'va-e2e@sites.test';
    try {
      await page.goto('/administracion?equipo=C&year=2026');
      const panel = page.getByRole('region', { name: 'Censo y accesos de VA' });
      await expect(panel.getByRole('heading', { name: 'Censo y accesos de VA · 2026' })).toBeVisible();
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
      const right = page.getByRole('region', { name: 'Mi derecho' });
      await expect(right).toContainText('20 años de antigüedad');
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
