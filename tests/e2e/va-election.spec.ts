import { test, expect, type APIRequestContext } from '@playwright/test';

// All writes are restricted to the dedicated local e2e database.
const origin = 'http://127.0.0.1:5199';
async function post(api: APIRequestContext, route: string, body: object) {
  const r = await api.post('/api/' + route, { data: body, headers: { Origin: origin } });
  expect(r.ok(), await r.text()).toBeTruthy();
  return r.json();
}
test(
  'VA: preferencias entre meses, dos rondas y confirmación delegada respetan el cupo',
  { tag: '@both' },
  async ({ page, request }) => {
    test.setTimeout(120_000);
    await request.get('/signin-with-chatgpt?return_to=/');
    let index = await (await request.get('/api/index')).json();
    if (!index.campaigns.length) {
      await post(request, 'initialize', {});
      index = await (await request.get('/api/index')).json();
    }
    if (!index.campaigns.some((c: { year: number }) => c.year === 2027)) {
      await post(request, 'campaigns', { year: 2027, copyYear: 2026 });
      index = await (await request.get('/api/index')).json();
    }
    const backup = await (await request.get('/api/backup')).json();
    try {
      const master = {
        action: 'preview',
        source: { title: 'Escalafón ficticio e2e', asOf: '2026-01-01', sha256: 'a'.repeat(64) },
        entries: [
          { personId: 'C-1', date: '2001-01-01', employeeNumber: 99901, page: 1 },
          { personId: 'C-6', date: '2006-01-01', controllerNumber: 99906, page: 1 },
        ],
      };
      const masterReview = await post(request, 'people/seniority', master);
      await post(request, 'people/seniority', { ...master, action: 'apply', reviewToken: masterReview.reviewToken });
      const source = { title: 'RRHH e2e', sha256: 'b'.repeat(64), receivedAt: '2026-10-28' };
      const census = { action: 'preview', people: ['C-1', 'C-6'], source };
      const review = await post(request, 'va/census/2027', census);
      await post(request, 'va/census/2027', { ...census, action: 'apply', reviewToken: review.reviewToken });
      const days = { '2027-01-10': 1, '2027-01-11': 1, '2027-02-12': 1 };
      const quotas = { action: 'preview', year: 2027, source, days };
      const quotaReview = await post(request, 'va/quotas', quotas);
      await post(request, 'va/quotas', { ...quotas, action: 'apply', reviewToken: quotaReview.reviewToken });
      const rows = await (await request.get('/api/va/census')).json();
      const first = rows.people.find((p: { personId: string }) => p.personId === 'C-1');
      await post(request, 'va/account', {
        personId: 'C-1',
        subject: 'va-eleccion@sites.test',
        accountVersion: first.account?.version ?? 0,
      });
      await page.goto('/signin-with-chatgpt?como=va-eleccion@sites.test');
      await page.goto('/antiguedad');
      const panel = page.getByRole('region', { name: 'Elección de días de VA', exact: true });
      await expect(panel.getByRole('group', { name: 'Modo de vacaciones', exact: true })).toBeVisible();
      await panel.getByRole('button', { name: 'Mis preferencias', exact: true }).click();
      await expect(panel.getByLabel('Leyenda de plazas disponibles')).toContainText('Tu selección');
      await panel.getByRole('button', { name: '10 de enero: 1 plazas libres', exact: true }).click();
      await expect(panel.getByRole('button', { name: '10 de enero: 1 plazas libres', exact: true })).toHaveClass(
        /vac2-selected/,
      );
      await expect(panel.getByRole('button', { name: '10 de enero: 1 plazas libres', exact: true })).toContainText(
        'P1',
      );
      await panel.getByRole('button', { name: 'Mes siguiente' }).click();
      await panel.getByRole('button', { name: '12 de febrero: 1 plazas libres', exact: true }).click();
      await panel.getByRole('button', { name: 'Mapa anual', exact: true }).click();
      await expect(panel.getByRole('button', { name: /^Ver .*2027$/ })).toHaveCount(12);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
      await panel.getByRole('button', { name: 'Ver febrero de 2027', exact: true }).click();
      await expect(panel.getByRole('button', { name: '12 de febrero: 1 plazas libres', exact: true })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await panel.getByLabel('Aplicar preferencias').selectOption('immediate');
      await panel.getByRole('button', { name: 'Guardar preferencias' }).click();
      await expect(panel.getByRole('status')).toHaveText('Preferencias guardadas');
      await page.reload();
      await panel.getByRole('button', { name: 'Mis preferencias', exact: true }).click();
      await expect(panel.getByRole('heading', { name: 'Mis preferencias · 2 días' })).toBeVisible();
      for (const c of index.campaigns.filter(
        (c: { year: number; scope_key: string }) => c.year === 2027 && c.scope_key === 'live',
      )) {
        const data = await (await request.get('/api/campaign/' + c.id)).json();
        await post(request, 'campaign/' + c.id, { action: 'close', version: data.campaign.version });
      }
      const mutate = async (body: object) => {
        const current = await (await request.get('/api/va/election/2027')).json();
        return post(request, 'va/election/2027', { ...body, version: current.version });
      };
      const started = await mutate({ action: 'start' });
      expect(started.state.turn).toBe('C-6');
      expect(started.state.choices.map((c: { date: string }) => c.date)).toEqual(['2027-01-10']);
      // Leave round 2 manual so the test can inspect and undo the automatic boundary.
      await post(page.request, 'va/election/2027', {
        action: 'preferences',
        version: started.version,
        dates: ['2027-01-10', '2027-02-12'],
        mode: 'manual',
        waitMinutes: 0,
      });
      await page.goto('/signin-with-chatgpt?return_to=/');
      await page.goto('/administracion/antiguedad');
      await expect(panel.getByRole('button', { name: 'Deshacer', exact: true })).toBeVisible();
      await expect(panel.getByRole('button', { name: 'Deshacer', exact: true })).toBeEnabled();
      await panel.getByRole('button', { name: /^Elegir en nombre de / }).click();
      await expect(panel.getByRole('group', { name: 'Calendario de elección de VA', exact: true })).toBeFocused();
      await expect(panel.getByRole('button', { name: '10 de enero: completo', exact: true })).toBeDisabled();
      await panel.getByRole('button', { name: '11 de enero: 1 plazas libres', exact: true }).click();
      await panel.getByRole('button', { name: 'Mes siguiente' }).click();
      await panel.getByRole('button', { name: '12 de febrero: 1 plazas libres', exact: true }).click();
      // In round 1 tapping a different date replaces the single selection, as in ordinary vacations.
      await panel.getByRole('button', { name: 'Mes anterior' }).click();
      await expect(panel.getByRole('button', { name: '11 de enero: 1 plazas libres', exact: true })).toHaveAttribute(
        'aria-pressed',
        'false',
      );
      await panel.getByRole('button', { name: '11 de enero: 1 plazas libres', exact: true }).click();
      if (process.env.VA_UI_SCREENSHOTS)
        await panel.screenshot({ path: '.sites-runtime/va-ui-admin-' + test.info().project.name + '.png' });
      await panel.getByRole('button', { name: 'Revisar y confirmar' }).click();
      const dialog = page.getByRole('dialog', { name: 'Confirmar días de VA', exact: true });
      await expect(dialog).toHaveAttribute('aria-modal', 'true');
      await page.keyboard.press('Escape');
      await expect(dialog).not.toBeVisible();
      await expect(panel.getByRole('button', { name: 'Revisar y confirmar' })).toBeFocused();
      await expect(panel.getByRole('button', { name: '11 de enero: 1 plazas libres', exact: true })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await panel.getByRole('button', { name: 'Revisar y confirmar' }).click();
      // The ordinary shared dialog must retain the version actually reviewed, even if polling updates behind it.
      await mutate({ action: 'pause' });
      await mutate({ action: 'resume' });
      await dialog.getByRole('button', { name: 'Confirmar días de VA', exact: true }).click();
      await expect(panel.getByRole('alert')).toContainText('La campaña cambió');
      await expect(panel.getByRole('button', { name: '11 de enero: 1 plazas libres', exact: true })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await expect(panel).toContainText('RONDA 1');
      await panel.getByRole('button', { name: 'Revisar y confirmar' }).click();
      await dialog.getByRole('button', { name: 'Confirmar días de VA', exact: true }).click();
      await expect(panel).toContainText('RONDA 2');
      await expect(panel.getByRole('button', { name: 'Abrir segunda ronda' })).toHaveCount(0);
      await expect(panel.getByText(/Días con hueco/)).toHaveCount(0);
      // History actions stay visible without expanding administrative controls, just as in ordinary elections.
      await panel.getByRole('button', { name: 'Deshacer', exact: true }).click();
      const historyDialog = page.getByRole('dialog', { name: 'Confirmar cambio', exact: true });
      await historyDialog.getByRole('button', { name: 'Cancelar', exact: true }).click();
      await expect(panel).toContainText('RONDA 2');
      await panel.getByRole('button', { name: 'Deshacer', exact: true }).click();
      await historyDialog.getByRole('button', { name: 'Confirmar', exact: true }).click();
      await expect(panel).toContainText('RONDA 1');
      await panel.getByRole('button', { name: 'Rehacer', exact: true }).click();
      await historyDialog.getByRole('button', { name: 'Confirmar', exact: true }).click();
      await expect(panel).toContainText('RONDA 2');
      await page.goto('/signin-with-chatgpt?como=va-eleccion@sites.test');
      await page.goto('/antiguedad');
      await expect(panel.getByRole('heading', { name: 'Es tu turno', exact: true })).toBeVisible();
      await expect(panel.locator('.va-turn')).toHaveClass(/is-my-turn/);
      await expect(panel.getByRole('button', { name: '10 de enero: VA elegida', exact: true })).toBeDisabled();
      await panel.getByRole('button', { name: 'Mes siguiente' }).click();
      if (process.env.VA_UI_SCREENSHOTS)
        await panel.screenshot({ path: '.sites-runtime/va-ui-participant-' + test.info().project.name + '.png' });
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
      // Unsaved preferences are not silently lost when switching back to the calendar.
      await panel.getByRole('button', { name: 'Mis preferencias', exact: true }).click();
      await panel.getByRole('button', { name: '12 de febrero: 1 plazas libres', exact: true }).click();
      await panel.getByRole('button', { name: 'Calendario', exact: true }).click();
      const unsaved = page.getByRole('dialog', { name: 'Preferencias sin guardar', exact: true });
      await unsaved.getByRole('button', { name: 'Cancelar', exact: true }).click();
      await expect(panel.getByRole('heading', { name: 'Mis preferencias · 1 día', exact: true })).toBeVisible();
      await panel.getByRole('button', { name: 'Calendario', exact: true }).click();
      await unsaved.getByRole('button', { name: 'Descartar cambios', exact: true }).click();
      await page.goto('/signin-with-chatgpt?return_to=/');
      await page.goto('/administracion/antiguedad');
      await panel.getByText('Gestionar elección · Historial y reconstrucción', { exact: true }).click();
      await panel.getByRole('button', { name: 'Mes siguiente' }).click();
      await panel.getByRole('button', { name: '12 de febrero: 1 plazas libres', exact: true }).click();
      await panel.getByRole('button', { name: 'Revisar y confirmar' }).click();
      await dialog.getByRole('button', { name: 'Confirmar días de VA', exact: true }).click();
      await expect(panel.getByRole('heading', { name: 'Elección terminada' })).toBeVisible();
      await panel.getByRole('button', { name: 'Reconstruir desde el principio' }).click();
      await expect(panel).toContainText('Reconstrucción en curso');
      const beforeApply = await (await request.get('/api/va/election/2027')).json();
      await panel.getByRole('button', { name: 'Aplicar reconstrucción', exact: true }).click();
      const applyDialog = page.getByRole('dialog', { name: 'Aplicar reconstrucción de VA', exact: true });
      await expect(applyDialog).toContainText('El borrador está vacío');
      await expect(applyDialog).toContainText('se eliminarán todas las adjudicaciones actuales');
      await applyDialog.getByRole('button', { name: 'Volver al borrador', exact: true }).click();
      const afterCancel = await (await request.get('/api/va/election/2027')).json();
      expect(afterCancel.version).toBe(beforeApply.version);
      expect(afterCancel.reconstructing).toBe(true);
      expect(afterCancel.state).toEqual(beforeApply.state);
      await panel.getByRole('button', { name: 'Mes anterior' }).click();
      await panel.getByRole('button', { name: '10 de enero: 1 plazas libres', exact: true }).click();
      await panel.getByRole('button', { name: 'Revisar y confirmar' }).click();
      await dialog.getByRole('button', { name: 'Confirmar días de VA', exact: true }).click();
      await panel.getByRole('button', { name: 'Volver un paso' }).click();
      await expect(panel).toContainText('Reconstrucción · 0 pasos');
      await panel.getByRole('button', { name: 'Cancelar reconstrucción' }).click();
      await expect(panel.getByRole('heading', { name: 'Elección terminada' })).toBeVisible();
      await page.goto('/signin-with-chatgpt?como=va-eleccion@sites.test');
      await page.goto('/antiguedad');
      await expect(panel).toContainText('Saldo: 0');
      await expect(panel.getByRole('listitem').filter({ hasText: '12 de febrero · Ronda 2' })).toBeVisible();
      await page.setViewportSize({ width: 360, height: 780 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
      if (!process.env.CI)
        await page.screenshot({ path: '../tmp/va-eleccion-' + test.info().project.name + '.png', fullPage: true });
    } finally {
      const revision = await (await request.get('/api/revision')).json();
      await post(request, 'restore', { backup, revision: revision.revision });
    }
  },
);
