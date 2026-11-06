import { test, expect } from '@playwright/test';

const origin = 'http://127.0.0.1:5199';

/** Loads a one-person VA campaign, so it restores the shared fixture like zz-va-common-admin. */
test(
  'el administrador ensaya VA en una simulación sin tocar la campaña real',
  { tag: '@both' },
  async ({ page, request }) => {
    const name = 'Ensayo e2e VA';
    const tag = () => page.getByText('Simulación privada: ' + name, { exact: true });
    const post = (path: string, data: unknown) => request.post('/api/' + path, { data, headers: { Origin: origin } });
    await request.get('/signin-with-chatgpt?return_to=/');
    if (!(await (await request.get('/api/index')).json()).campaigns.length)
      expect((await post('initialize', {})).ok()).toBeTruthy();
    const backupResponse = await request.get('/api/backup');
    expect(backupResponse.ok(), await backupResponse.text()).toBeTruthy();
    const backup = await backupResponse.json();
    try {
      const census = await (await request.get('/api/va/census')).json();
      const person = census.people.find((p: { status: string }) => p.status === 'entitled');
      const entries = [{ personId: person.personId, date: person.seniority, employeeNumber: 7001, page: 1 }];
      const fichas = { title: 'Fichas E2E', asOf: '2026-01-05', sha256: 'e'.repeat(64) };
      if (!person.controllerNumber) {
        const preview = await (await post('people/seniority', { action: 'preview', entries, source: fichas })).json();
        const applied = await post('people/seniority', {
          action: 'apply',
          entries,
          source: fichas,
          reviewToken: preview.reviewToken,
        });
        expect(applied.ok(), await applied.text()).toBeTruthy();
      }
      const body = { people: [person.personId], source: { title: 'Censo E2E', sha256: 'd'.repeat(64) } };
      const path = `va/campaign/${census.year}`;
      const reviewed = await (await post(path, { ...body, action: 'preview' })).json();
      const loaded = await post(path, { ...body, action: 'apply', reviewToken: reviewed.reviewToken });
      expect(loaded.ok(), await loaded.text()).toBeTruthy();

      const real = (await (await request.get('/api/index')).json()).vaCampaign;
      const awards = async () => (await (await request.get('/api/campaign/' + real.id)).json()).awards;
      const before = await awards();
      await page.context().addCookies((await request.storageState()).cookies);

      await page.goto('/administracion/antiguedad');
      const scenario = page.getByRole('combobox', { name: 'Escenario', exact: true });
      await expect(scenario).toHaveValue(real.id);
      await page.getByLabel('Nombre del escenario').fill(name);
      await page.getByRole('button', { name: 'Crear simulación' }).click();
      await expect(tag()).toBeVisible();
      await expect(page).toHaveURL(/escenario=/);
      // The census belongs to the real campaign.
      await expect(page.getByRole('region', { name: 'Censo y accesos de VA' })).toHaveCount(0);
      // So do the global permissions and backups.
      await expect(page.getByRole('heading', { name: 'Responsables y permisos' })).toHaveCount(0);
      await expect(page.getByRole('heading', { name: 'Copias de seguridad' })).toHaveCount(0);

      // A reload, and the election section, stay in the simulation.
      await page.reload();
      await expect(tag()).toBeVisible();
      const simulation = await scenario.inputValue();
      expect(simulation).not.toBe(real.id);
      // Links, opened in another tab, keep the scenario.
      const link = page.getByRole('link', { name: 'Antigüedad', exact: true }).first();
      expect(await link.getAttribute('href')).toContain('escenario=' + simulation);
      await page.goto((await link.getAttribute('href'))!);
      await expect(tag()).toBeVisible();

      // «Probar como» opens the simulation's election as that controller, and comes back to it.
      await page.getByLabel('Probar simulación como controlador').selectOption(person.code);
      await expect(page).toHaveURL(/\/antiguedad\?.*verComo=/);
      await expect(tag()).toBeVisible();
      await page.getByRole('button', { name: 'Salir de vista previa' }).click();
      await expect(scenario).toHaveValue(simulation);

      // Back to the real campaign, which did not change.
      await scenario.selectOption(real.id);
      await expect(tag()).toHaveCount(0);
      await expect(page).not.toHaveURL(/escenario=/);
      expect(await awards()).toEqual(before);

      // Deleting returns to the real campaign.
      await scenario.selectOption(simulation);
      await expect(tag()).toBeVisible();
      await page.locator('.scenario-actions summary').click();
      await page.getByRole('button', { name: 'Eliminar simulación' }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Confirmar' }).click();
      await expect(page.getByRole('status').filter({ hasText: 'Simulación eliminada' })).toBeVisible();
      await expect(scenario).toHaveValue(real.id);
      expect((await request.get('/api/campaign/' + simulation)).status()).toBe(404);

      // A link to the deleted simulation says so instead of silently showing the real campaign.
      await page.goto('/antiguedad?escenario=' + simulation);
      await expect(page.getByRole('alert')).toContainText('Esa simulación no existe');
      await expect(scenario).toHaveValue(real.id);
      await expect(page).not.toHaveURL(/escenario=/);
    } finally {
      const current = await (await request.get('/api/backup')).json();
      const restored = await post('restore', { backup, revision: current.payload.revision });
      expect(restored.ok(), await restored.text()).toBeTruthy();
    }
  },
);
