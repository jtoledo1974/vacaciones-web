import { test, expect, type APIRequestContext } from '@playwright/test';

// Same isolated loopback fixture as the other election tests, never the user's 5207 database.
async function post(api: APIRequestContext, route: string, body: object) {
  const response = await api.post('/api/' + route, { data: body, headers: { Origin: 'http://127.0.0.1:5199' } });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}

test('VA: segunda ronda exige todo el saldo en una única confirmación', { tag: '@both' }, async ({ page, request }) => {
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
    const source = { title: 'Fixture ficticia UX VA', sha256: 'c'.repeat(64), receivedAt: '2026-10-28' };
    const external = {
      action: 'preview',
      source,
      entries: [
        {
          code: 'UXVA',
          label: 'Persona ficticia UX',
          employeeNumber: 99998,
          seniority: '1996-01-01',
          category: 'otro',
        },
      ],
    };
    const externalReview = await post(request, 'va/external', external);
    await post(request, 'va/external', { ...external, action: 'apply', reviewToken: externalReview.reviewToken });
    const personId = externalReview.rows[0].id;
    const census = { action: 'preview', people: [personId], source };
    const review = await post(request, 'va/census/2027', census);
    await post(request, 'va/census/2027', { ...census, action: 'apply', reviewToken: review.reviewToken });
    const quotas = {
      action: 'preview',
      year: 2027,
      source,
      days: { '2027-01-10': 1, '2027-01-11': 1, '2027-01-12': 1 },
    };
    const quotaReview = await post(request, 'va/quotas', quotas);
    await post(request, 'va/quotas', { ...quotas, action: 'apply', reviewToken: quotaReview.reviewToken });
    for (const c of index.campaigns.filter(
      (c: { year: number; scope_key: string }) => c.year === 2027 && c.scope_key === 'live',
    )) {
      const data = await (await request.get('/api/campaign/' + c.id)).json();
      await post(request, 'campaign/' + c.id, { action: 'close', version: data.campaign.version });
    }
    const current = await (await request.get('/api/va/election/2027')).json();
    await post(request, 'va/election/2027', { action: 'start', version: current.version });
    await page.goto('/signin-with-chatgpt?return_to=/');
    await page.goto('/administracion/antiguedad');
    const panel = page.getByRole('region', { name: 'Elección de días de VA', exact: true });
    const dialog = page.getByRole('dialog', { name: 'Confirmar días de VA', exact: true });
    await panel.getByRole('button', { name: '10 de enero: 1 plazas libres', exact: true }).click();
    await panel.getByRole('button', { name: 'Revisar y confirmar' }).click();
    await dialog.getByRole('button', { name: 'Confirmar días de VA', exact: true }).click();
    await expect(panel).toContainText('RONDA 2');
    await panel.getByRole('button', { name: '11 de enero: 1 plazas libres', exact: true }).click();
    await expect(panel.locator('.va-selection')).toContainText('1/2');
    await expect(panel.getByRole('button', { name: 'Revisar y confirmar' })).toBeDisabled();
    await expect(dialog).toHaveCount(0);
    await panel.getByRole('button', { name: '12 de enero: 1 plazas libres', exact: true }).click();
    await panel.getByRole('button', { name: 'Revisar y confirmar' }).click();
    await expect(dialog).toContainText('11 de enero');
    await expect(dialog).toContainText('12 de enero');
    await expect(dialog).not.toContainText('menos días');
    await dialog.getByRole('button', { name: 'Volver a la selección', exact: true }).click();
    await expect(panel.getByRole('button', { name: '11 de enero: 1 plazas libres', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    let result = await (await request.get('/api/va/election/2027')).json();
    expect(result.state.choices).toHaveLength(1);
    await panel.getByRole('button', { name: 'Revisar y confirmar' }).click();
    await dialog.getByRole('button', { name: 'Confirmar días de VA', exact: true }).click();
    await expect(panel.getByRole('heading', { name: 'Elección terminada', exact: true })).toBeVisible();
    result = await (await request.get('/api/va/election/2027')).json();
    expect(result.state.choices).toHaveLength(3);
    expect(result.state.people.find((p: { id: string }) => p.id === personId).balance).toBe(0);
  } finally {
    const revision = await (await request.get('/api/revision')).json();
    await post(request, 'restore', { backup, revision: revision.revision });
  }
});

test('VA: un solo día en primera ronda y borrador aislado por turno', { tag: '@both' }, async ({ page, request }) => {
  test.setTimeout(60_000);
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
    const source = { title: 'Fixture ficticia límite VA', sha256: 'd'.repeat(64), receivedAt: '2026-10-28' };
    const external = {
      action: 'preview',
      source,
      entries: ['UXUNO', 'UXDOS'].map((code, i) => ({
        code,
        label: 'Persona ficticia ' + code,
        employeeNumber: 99996 + i,
        seniority: '1996-01-01',
        category: 'otro',
      })),
    };
    const externalReview = await post(request, 'va/external', external);
    await post(request, 'va/external', { ...external, action: 'apply', reviewToken: externalReview.reviewToken });
    const people = externalReview.rows.map((p: { id: string }) => p.id);
    const census = { action: 'preview', people, source };
    const review = await post(request, 'va/census/2027', census);
    await post(request, 'va/census/2027', { ...census, action: 'apply', reviewToken: review.reviewToken });
    const quotas = {
      action: 'preview',
      year: 2027,
      source,
      days: {
        '2027-01-10': 2,
        '2027-01-11': 2,
        '2027-02-12': 2,
      },
    };
    const quotaReview = await post(request, 'va/quotas', quotas);
    await post(request, 'va/quotas', { ...quotas, action: 'apply', reviewToken: quotaReview.reviewToken });
    for (const c of index.campaigns.filter(
      (c: { year: number; scope_key: string }) => c.year === 2027 && c.scope_key === 'live',
    )) {
      const data = await (await request.get('/api/campaign/' + c.id)).json();
      await post(request, 'campaign/' + c.id, { action: 'close', version: data.campaign.version });
    }
    const current = await (await request.get('/api/va/election/2027')).json();
    const started = await post(request, 'va/election/2027', { action: 'start', version: current.version });
    // The server must reject two days independently of any UI restriction.
    const invalid = await request.post('/api/va/election/2027', {
      data: {
        action: 'choose',
        version: started.version,
        personId: started.state.turn,
        dates: ['2027-01-10', '2027-01-11'],
      },
      headers: { Origin: 'http://127.0.0.1:5199' },
    });
    expect(invalid.ok()).toBeFalsy();
    expect((await (await request.get('/api/va/election/2027')).json()).state.choices).toHaveLength(0);
    await page.goto('/signin-with-chatgpt?return_to=/');
    await page.goto('/administracion/antiguedad');
    const panel = page.getByRole('region', { name: 'Elección de días de VA', exact: true });
    const jan10 = panel.getByRole('button', { name: '10 de enero: 2 plazas libres', exact: true });
    const jan11 = panel.getByRole('button', { name: '11 de enero: 2 plazas libres', exact: true });
    await jan10.click();
    await jan11.click();
    await expect(jan10).toHaveAttribute('aria-pressed', 'false');
    await expect(jan11).toHaveAttribute('aria-pressed', 'true');
    await panel.getByRole('button', { name: 'Mes siguiente' }).click();
    const feb12 = panel.getByRole('button', { name: '12 de febrero: 2 plazas libres', exact: true });
    await feb12.click();
    await expect(panel.locator('.va-selection')).toContainText('1/1');
    await expect(feb12).toHaveAttribute('aria-pressed', 'true');
    // Another browser advances the turn while this browser has a draft.
    await post(request, 'va/election/2027', {
      action: 'choose',
      version: started.version,
      personId: started.state.turn,
      dates: ['2027-01-10'],
    });
    // Polling runs every 15 seconds; allow a second cycle when a prior fetch was already in flight.
    await expect(panel.locator('.va-selection')).toContainText('0/1', { timeout: 30_000 });
    await expect(feb12).toHaveAttribute('aria-pressed', 'false');
    await expect(panel.getByRole('button', { name: 'Revisar y confirmar' })).toBeDisabled();
    await feb12.click();
    await panel.getByRole('button', { name: 'Revisar y confirmar' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Confirmar días de VA', exact: true }).click();
    await expect(panel).toContainText('RONDA 2');
    await expect(panel.locator('.va-selection')).toContainText('0/2');
    await expect(panel.getByRole('button', { name: 'Revisar y confirmar' })).toBeDisabled();
  } finally {
    const revision = await (await request.get('/api/revision')).json();
    await post(request, 'restore', { backup, revision: revision.revision });
  }
});
