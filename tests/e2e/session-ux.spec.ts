import { test, expect } from '@playwright/test';

test(
  'el visitante encuentra el acceso ChatGPT sin abrir el menú móvil',
  { tag: '@mobile-only' },
  async ({ browser }) => {
    const context = await browser.newContext({
      baseURL: 'http://127.0.0.1:5199',
      viewport: { width: 390, height: 844 },
    });
    try {
      const page = await context.newPage();
      await page.goto('/');
      await expect(page.locator('.topbar').getByRole('link', { name: /Iniciar sesión con ChatGPT/ })).toBeVisible();
      await page.getByRole('button', { name: 'Abrir menú' }).click();

      const session = page.getByRole('region', { name: 'Tu sesión' });
      await expect(session).toContainText('No has iniciado sesión');
      await expect(session.getByRole('link', { name: 'Iniciar sesión con ChatGPT' })).toBeVisible();
      await expect(page.getByText('Consulta pública disponible')).toBeVisible();
    } finally {
      await context.close();
    }
  },
);

test(
  'el usuario autenticado ve su identidad y rol en cabecera y menú móvil',
  { tag: '@mobile-only' },
  async ({ page, request }) => {
    await request.get('/signin-with-chatgpt?return_to=/');
    await page.context().addCookies((await request.storageState()).cookies);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');

    const account = page.locator('.header-account');
    await expect(account).toBeVisible();
    await expect(account).toContainText('Rol: Superadministrador');
    await account.click();

    const session = page.getByRole('region', { name: 'Tu sesión' });
    await expect(session).toContainText('Sesión iniciada');
    await expect(session).toContainText('Usuario');
    await expect(session).toContainText('Superadministrador');
    await expect(session).toContainText('Acceso mediante ChatGPT');
    await expect(session.getByRole('link', { name: 'Cerrar sesión' })).toBeVisible();
  },
);

test('el pie muestra qué código se ha compilado y cuándo', async ({ page }) => {
  await page.goto('/');
  const stamp = page.locator('.content > footer .footer-build');
  await expect(stamp).toBeVisible();
  await expect(stamp).toContainText(/Código (?:[a-f0-9]{10}|no identificada) · compilado/);
  await expect(stamp.locator('time')).toHaveAttribute('datetime', /^\d{4}-\d{2}-\d{2}T/);
});
