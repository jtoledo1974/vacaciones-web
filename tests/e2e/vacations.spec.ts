import { readFileSync } from 'node:fs';
import { test, expect, type APIRequestContext, type Page, type Request } from '@playwright/test';
// No configurable remote URL: destructive QA is restricted to the dedicated local DB.
const origin = 'http://127.0.0.1:5199';
type BackupTestWindow = Window &
  typeof globalThis & {
    __backupLines: string[];
    __backupClosed: boolean;
    __backupAborted: boolean;
    showSaveFilePicker: () => Promise<{
      createWritable: () => Promise<{
        write: (line: string) => Promise<void>;
        close: () => Promise<void>;
        abort: () => Promise<void>;
      }>;
    }>;
  };

test(
  'se elimina el filtro redundante «Ver vacaciones de» y se conserva la vista Por CTA',
  { tag: '@both' },
  async ({ page, request }) => {
    const scenario = await setup(request, page);
    await open(page, scenario.id);
    await activate(page);
    await expect(page.getByLabel('Ver vacaciones de controlador')).toHaveCount(0);
    await expect(page.getByText('Ver vacaciones de', { exact: true })).toHaveCount(0);
    await page.getByRole('group', { name: 'Vista del calendario' }).getByRole('button', { name: 'Por CTA' }).click();
    await expect(page.getByRole('group', { name: 'Ordenación de vacaciones por CTA' })).toBeVisible();
  },
);

test(
  'rutas directas a Ayuda, Estadísticas y Administración conservan el escenario y admiten navegación',
  { tag: ['@both', '@smoke'] },
  async ({ page, request }) => {
    const scenario = await setup(request, page);
    await open(page, scenario.id);
    if ((page.viewportSize()?.width ?? 1280) <= 850) {
      const navigation = page.getByRole('navigation', { name: 'Ir a una sección' });
      await expect(navigation).toBeVisible();
      await navigation.getByRole('link', { name: 'Ayuda' }).click();
    } else {
      await page.getByRole('button', { name: 'Ayuda', exact: true }).click();
    }
    await expect(page).toHaveURL(/\/ayuda\?.*equipo=C/);
    await expect(page.getByRole('heading', { level: 1, name: 'Ayuda y documentación' })).toBeVisible();
    await page.goto('/estadisticas?equipo=C&year=2026&escenario=' + scenario.id);
    await expect(page.getByRole('heading', { name: 'Estadísticas', exact: true })).toBeVisible();
    await expect(page.getByLabel('Escenario', { exact: true })).toHaveValue(scenario.id);
    const adminResponse = page.waitForResponse(
      (response) => response.url().endsWith('/api/admin') && response.status() === 200,
    );
    await page.goto('/administracion?equipo=C&year=2026&escenario=' + scenario.id);
    const loadedAdmin = await adminResponse;
    expect((await loadedAdmin.json()).users).toBeDefined();
    await expect(page.getByRole('heading', { name: 'Administración general' })).toBeVisible();
    await expect(page.getByLabel('Escenario', { exact: true })).toHaveValue(scenario.id);
    await page.goBack();
    await expect(page).toHaveURL(/\/estadisticas\?/);
    await expect(page.getByRole('heading', { name: 'Estadísticas', exact: true })).toBeVisible();
  },
);

test(
  'Atrás tras cambiar de equipo en otra sección vuelve al equipo de la URL',
  { tag: ['@both', '@smoke'] },
  async ({ page, request }) => {
    await setup(request, page);
    await page.goto('/?equipo=A&year=2026');
    const team = page.getByLabel('Equipo', { exact: true });
    await expect(team).toHaveValue('A');
    if ((page.viewportSize()?.width ?? 1280) <= 850)
      await page
        .getByRole('navigation', { name: 'Ir a una sección' })
        .getByRole('link', { name: 'Administración' })
        .click();
    else await page.getByRole('button', { name: 'Administración', exact: true }).click();
    await expect(page).toHaveURL(/\/administracion\?.*equipo=A/);
    await team.selectOption('B');
    await expect(page).toHaveURL(/\/administracion\?.*equipo=B/);
    await page.goBack();
    await expect(page).toHaveURL(/\/\?.*equipo=A/);
    await expect(team).toHaveValue('A');
    await expect(page.getByText(/Equipo A · 2026/)).toBeVisible();
  },
);

test(
  'reiniciar sin pausar advierte del borrado y permite deshacer inmediatamente',
  { tag: '@smoke' },
  async ({ page, request }) => {
    const scenario = await setup(request, page);
    await open(page, scenario.id);
    await activate(page);
    await cycle(page, scenario.data.result.cycles[0].date);
    await confirm(page, 'Confirmar ciclo');
    await expect(page.getByRole('heading', { name: 'QA_B elige ahora', exact: true })).toBeVisible();
    if (await page.getByRole('button', { name: 'Abrir menú', exact: true }).isVisible())
      await page.getByRole('button', { name: 'Abrir menú', exact: true }).click();
    await page.getByRole('button', { name: 'Administración', exact: true }).click();
    await page.getByText('Herramientas avanzadas', { exact: true }).click();
    await page.getByRole('button', { name: 'Empezar de cero las vacaciones' }).click();
    const dialog = page.getByRole('dialog', { name: 'Confirmar cambio' });
    await expect(dialog).toContainText('elección EN CURSO');
    await expect(dialog).toContainText('TODAS las adjudicaciones ya confirmadas (1)');
    await expect(dialog).toContainText('No requiere pausa previa');
    await dialog.getByRole('textbox', { name: 'Confirmación del equipo y año' }).fill('C-2026');
    await dialog.getByRole('button', { name: 'Confirmar' }).click();
    await expect.poll(async () => (await read(request, scenario.id)).election.state).toBeNull();
    const cleared = await read(request, scenario.id);
    expect(cleared.undo?.action).toBe('reset_vacations');
    await post(request, 'campaign/' + scenario.id, {
      action: 'undo_vacations',
      version: cleared.campaign.version,
      undoId: cleared.undo.id,
    });
    await expect.poll(async () => (await read(request, scenario.id)).awards.length).toBe(1);
    expect((await read(request, scenario.id)).election.state.status).toBe('active');
    expect((await read(request, scenario.id)).latestReset).toBeUndefined();
  },
);

test('menús de acciones se cierran con Escape y clic exterior', { tag: '@both' }, async ({ page, request }) => {
  const s = await setup(request, page);
  await open(page, s.id);
  await activate(page);
  const actionMenu = page.locator('.election-turn-controls > .election-more-actions');
  const opener = actionMenu.locator('summary');
  await opener.click();
  await expect(actionMenu).toHaveAttribute('open', '');
  await page.keyboard.press('Escape');
  await expect(actionMenu).not.toHaveAttribute('open', '');
  await opener.click();
  await expect(actionMenu).toHaveAttribute('open', '');
  await page.getByRole('heading', { name: 'Vacaciones del equipo' }).click();
  await expect(actionMenu).not.toHaveAttribute('open', '');

  const scenarioMenu = page.locator('.scenario-actions');
  await scenarioMenu.locator('summary').click();
  await expect(scenarioMenu).toHaveAttribute('open', '');
  await page.keyboard.press('Escape');
  await expect(scenarioMenu).not.toHaveAttribute('open', '');
  await scenarioMenu.locator('summary').click();
  await page.getByRole('heading', { name: 'Vacaciones del equipo' }).click();
  await expect(scenarioMenu).not.toHaveAttribute('open', '');
  if ((page.viewportSize()?.width ?? 1280) <= 900) {
    for (const target of [opener, scenarioMenu.locator('summary')]) {
      const rect = await target.boundingBox();
      expect(rect?.width).toBeGreaterThanOrEqual(44);
      expect(rect?.height).toBeGreaterThanOrEqual(44);
    }
  }
});

test(
  'activación visible desde Vacaciones, regreso automático y reanudación destacada',
  { tag: '@both' },
  async ({ page, request }) => {
    const scenario = await setup(request, page);
    expect(scenario.data.election.state).toBeNull();
    await open(page, scenario.id);
    const switcher = page.getByRole('group', { name: 'Modo de vacaciones' });
    await expect(switcher.getByRole('button', { name: 'Calendario', exact: true })).toBeVisible();
    const configure = page.getByRole('button', { name: 'Configurar e iniciar elección', exact: true });
    await expect(configure).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Elección sin iniciar', exact: true })).toHaveCount(0);
    await configure.click();
    await expect(page.getByRole('heading', { name: 'Administración general', exact: true })).toBeVisible();
    const activation = page.locator('#activation-panel');
    await expect(activation).toHaveAttribute('open', '');
    await activation.getByLabel('Confirmo Criterios Vacaciones 1.1').check();
    await activation.getByRole('button', { name: 'Activar elección', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Vacaciones del equipo', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'QA_A elige ahora', exact: true })).toBeVisible();
    await page.getByLabel('Más acciones', { exact: true }).click();
    await page.getByRole('button', { name: 'Pausar elección', exact: true }).click();
    const resume = page.getByRole('button', { name: 'Reanudar elección', exact: true });
    await expect(resume).toBeVisible();
    await expect(page.locator('.election-more-actions')).toHaveCount(0);
    await resume.click();
    await expect(page.getByRole('heading', { name: 'QA_A elige ahora', exact: true })).toBeVisible();
  },
);

test(
  'la activación señala puntuaciones concretas y documenta procedencia en un formulario visible',
  { tag: '@both' },
  async ({ page, request }) => {
    const scenario = await setup(request, page);
    await post(request, 'campaign/' + scenario.id, {
      action: 'config',
      version: scenario.data.campaign.version,
      config: { ...scenario.data.config, previousScores: { QA_A: 10, QA_B: 20, QA_C: 30 }, previousScoresSource: '' },
    });
    await open(page, scenario.id);
    await page.getByRole('button', { name: 'Configurar e iniciar elección' }).click();
    const activation = page.locator('#activation-panel');
    await expect(activation).toHaveAttribute('open', '');
    await expect(activation).toContainText('QA_D');
    await activation.getByRole('button', { name: 'Completar puntuaciones en la plantilla' }).click();
    await expect(page.getByLabel('Puntuación anterior de QA_D')).toBeFocused();
    await page.getByLabel('Puntuación anterior de QA_D').fill('40');
    await page.getByLabel('Puntuación anterior de QA_D').press('Tab');
    await expect(
      page.locator('#roster-panel').getByRole('status').filter({ hasText: 'Todos los cambios guardados' }),
    ).toBeVisible();
    await expect(activation).not.toContainText('Falta la puntuación');
    await activation.getByRole('button', { name: 'Documentar procedencia' }).click();
    const sourceForm = activation.getByRole('group', { name: 'Documentar origen de las puntuaciones' });
    await expect(sourceForm).toBeVisible();
    await expect(sourceForm).toContainText('Esta descripción queda guardada para todo el equipo');
    const sourceInput = sourceForm.getByRole('textbox', { name: 'Procedencia de las puntuaciones' });
    await expect(sourceInput).toBeFocused();
    await sourceInput.fill('Clasificación verificada del equipo, recibida el 22/10/2026');
    await sourceForm.getByRole('button', { name: 'Guardar procedencia' }).click();
    await expect(sourceForm).toHaveCount(0);
    const saved = await read(request, scenario.id);
    expect(saved.config.previousScoresSource).toContain('Clasificación verificada');
    await expect(activation).not.toContainText('Falta documentar');
    await activation.getByLabel('Confirmo Criterios Vacaciones 1.1').check();
    await activation.getByRole('button', { name: 'Activar elección', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'QA_A elige ahora' })).toBeVisible();
  },
);

test('historial heredado: adjudicaciones tras sorteo y cuadro con destinatario sin fecha duplicada', async ({
  page,
  request,
}, info) => {
  const source = await setup(request, page);
  const ids = source.data.members.map((m: any) => m.id);
  const config = source.data.config;
  await post(request, 'campaign/' + source.id, {
    action: 'config',
    version: source.data.campaign.version,
    config: {
      ...config,
      previousScores: { QA_A: 10, QA_B: 10, QA_C: 30, QA_D: 40 },
      previousScoresSource: 'Puntuaciones ficticias para regresión de simulación heredada',
    },
  });
  await election(request, source.id, { action: 'start', rulesConfirmed: true, allowDeferral: true });
  const base = await read(request, source.id);
  const clone = await post(request, 'simulations/' + source.id, {
    name: 'Historial heredado QA',
    version: base.campaign.version,
  });
  await election(request, clone.id, { action: 'resume' });
  const before = await read(request, clone.id),
    members = before.members;
  await election(request, clone.id, {
    action: 'resolve_tie',
    method: 'external',
    order: members.slice(0, 2).map((m: any) => m.id),
  });
  const dates = before.result.cycles.map((c: any) => c.date);
  await election(request, clone.id, { action: 'choose', memberId: members[0].id, dates: [dates[0]] });
  await election(request, clone.id, { action: 'choose', memberId: members[1].id, dates: [dates[1]] });
  await open(page, clone.id);
  const log = page.locator('.election-log');
  await expect(log.locator('li')).toHaveCount(3);
  await expect(log.locator('li').first()).toContainText('R1 · 2');
  await expect(log.locator('li').nth(1)).toContainText('R1 · 1');
  await expect(log.locator('li').last()).toContainText('Sorteo de empate');
  await expect(log.locator('li').last().locator('.election-cycle-number')).toHaveCount(0);
  await expect(page.getByText('Inicio del historial · No hay eventos anteriores.')).toBeVisible();
  // Choose a cycle already occupied, preserving its occupant and capacity details.
  await cycle(page, dates[0]);
  const card = page.getByRole('region', { name: 'Detalle del ciclo seleccionado' });
  await expect(card.locator('.election-selected-summary')).toHaveText('Elige QA_C');
  await expect(card.locator('.person-chip')).toContainText('QA_A');
  await expect(card).toContainText('plazas ocupadas');
  await expect(card).toContainText('puntos');
  await expect(card.getByRole('button', { name: 'Confirmar ciclo', exact: true })).toBeEnabled();
  await expect(card.getByRole('button', { name: 'Cancelar selección', exact: true })).toBeVisible();
  if (!process.env.CI) await page.screenshot({ path: info.outputPath('historial-y-destinatario.png'), fullPage: true });
  if (!process.env.CI) await card.screenshot({ path: info.outputPath('cuadro-destinatario.png') });
  await card.getByRole('button', { name: 'Cancelar selección', exact: true }).click();
  await expect(card).toHaveCount(0);
  expect((await read(request, clone.id)).awards).toHaveLength(2);
});
async function post(api: APIRequestContext, path: string, body: unknown) {
  const r = await api.post('/api/' + path, { data: body, headers: { Origin: origin } });
  expect(r.ok(), await r.text()).toBeTruthy();
  return r.json();
}
async function read(api: APIRequestContext, id: string) {
  const r = await api.get('/api/campaign/' + id);
  expect(r.ok()).toBeTruthy();
  return r.json();
}
async function election(api: APIRequestContext, id: string, body: object) {
  const d = await read(api, id);
  return post(api, 'election/' + id, { ...body, version: d.campaign.version });
}
// The dialog closes before the UI's POST is stored: wait for it before reading by API.
async function confirmSaved(page: Page, id: string) {
  const saved = page.waitForResponse((r) => r.url().includes('/api/election/' + id) && r.request().method() === 'POST');
  await page.getByRole('dialog').getByRole('button', { name: 'Confirmar', exact: true }).click();
  expect((await saved).ok()).toBeTruthy();
}
async function setup(api: APIRequestContext, page: Page) {
  await api.get('/signin-with-chatgpt?return_to=/');
  await page.context().addCookies((await api.storageState()).cookies);
  let index = await (await api.get('/api/index')).json();
  if (!index.campaigns.length) index = await post(api, 'initialize', {});
  const live = index.campaigns.find((c: any) => c.team_id === 'C' && c.year === 2026 && c.scope_key === 'live');
  const baseline = await read(api, live.id);
  const clone = await post(api, 'simulations/' + live.id, {
    name: 'Playwright ' + crypto.randomUUID().slice(0, 8),
    version: baseline.campaign.version,
  });
  let d = await read(api, clone.id);
  // Every import is previewed first; its token confirms exactly that report.
  const roster = {
    action: 'import_roster',
    version: d.campaign.version,
    source: {
      format: 'vacaciones-roster-v1',
      team: 'C',
      year: 2026,
      copySelections: false,
      rows: ['QA_A', 'QA_B', 'QA_C', 'QA_D'].map((code) => ({ code, label: 'Ficticio ' + code, seniority: '' })),
    },
  };
  const review = await post(api, 'campaign/' + clone.id, { ...roster, action: 'preview_import_roster' });
  d = await post(api, 'campaign/' + clone.id, { ...roster, reviewToken: review.reviewToken });
  d = await post(api, 'campaign/' + clone.id, {
    action: 'config',
    version: d.campaign.version,
    config: {
      ...d.config,
      previousScores: { QA_A: 10, QA_B: 20, QA_C: 30, QA_D: 40 },
      previousScoresSource: 'Puntuaciones de Playwright verificadas',
    },
  });
  return { id: clone.id, live, baseline, data: d };
}
async function open(page: Page, id: string) {
  await page.goto('/?equipo=C&year=2026');
  await page.getByLabel('Escenario', { exact: true }).selectOption(id);
  await expect(page.getByText(/SIMULACIÓN PRIVADA/i)).toBeVisible();
}
async function activate(page: Page, ties = '') {
  // Activation UI has its own desktop/mobile regressions. Most tests exercise
  // other workflows, so start their isolated simulation via the same API.
  const id = await page.getByLabel('Escenario', { exact: true }).inputValue();
  expect(id).toBeTruthy();
  if (ties) {
    const current = await read(page.request, id),
      previousScores = { ...current.config.previousScores };
    for (const code of ties.split(',').map((s) => s.trim())) previousScores[code] = 20;
    await post(page.request, 'campaign/' + id, {
      action: 'config',
      version: current.campaign.version,
      config: { ...current.config, previousScores },
    });
  }
  let next = await election(page.request, id, { action: 'start', rulesConfirmed: true, allowDeferral: true });
  for (let step = 0; step < 100 && next.election.pendingAutomatic; step++)
    next = await election(page.request, id, { action: 'advance' });
  // Refresh once rather than waiting for the five-second live revision poll.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'QA_A elige ahora', exact: true })).toBeVisible();
}
async function cycle(page: Page, date: string) {
  await page.locator('.vac2-cycle[data-cycle-date="' + date + '"]').click();
}
async function confirm(page: Page, button: string) {
  const target = page.getByRole('button', { name: button, exact: true });
  if (button.startsWith('Aplazar') && !(await target.isVisible()))
    await page.getByLabel('Más acciones', { exact: true }).click();
  // A covered/unclickable control should fail locally, not consume the entire 45 s test timeout.
  await target.click({ timeout: 10_000 });
  // An award or a deferral is a POST: wait until the server has answered it, or the next
  // API read can see the state before the decision (only on a loaded CI runner).
  const decision = /^(Confirmar (ciclo|ambos ciclos|tres ciclos|turno conjunto)|Aplazar para elegir (dos|tres))$/.test(
    button,
  );
  const isPost = (r: Request) => r.url().includes('/api/election/') && r.method() === 'POST';
  const settled = decision
    ? Promise.race([page.waitForResponse((r) => isPost(r.request())), page.waitForEvent('requestfailed', isPost)])
    : null;
  if (/^Confirmar (ciclo|ambos ciclos|tres ciclos|turno conjunto)$/.test(button)) {
    const dialog = page.getByRole('dialog', { name: 'Confirmar adjudicación' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Adjudicar', exact: true }).click();
  } else await page.getByRole('dialog').getByRole('button', { name: 'Confirmar', exact: true }).click();
  await settled;
}

test(
  'confirmación rápida es opcional y local únicamente en simulaciones',
  { tag: '@both' },
  async ({ page, request }) => {
    const scenario = await setup(request, page);
    await open(page, scenario.id);
    await activate(page);
    const menu = page.locator('.election-turn-controls > .election-more-actions');
    await menu.locator('summary').click();
    const checkbox = menu.getByRole('checkbox', { name: 'Requerir confirmación antes de adjudicar' });
    await expect(checkbox).toBeChecked();
    await checkbox.uncheck();
    await expect(page.getByText('Simulación · confirmación rápida')).toBeVisible();
    await page.reload();
    await expect(page.getByText('Simulación · confirmación rápida')).toBeVisible();
    await cycle(page, scenario.data.result.cycles[0].date);
    await expect(page.getByRole('button', { name: 'Confirmar ciclo', exact: true })).toHaveCount(0);
    await expect(page.getByRole('dialog', { name: 'Confirmar adjudicación' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'QA_B elige ahora', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '↶ Deshacer' }).click();
    await expect(page.getByRole('dialog', { name: 'Confirmar cambio' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'QA_A elige ahora', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '↷ Rehacer' }).click();
    await expect(page.getByRole('dialog', { name: 'Confirmar cambio' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'QA_B elige ahora', exact: true })).toBeVisible();
  },
);

test(
  'una elección confirmada no espera el índice ni pierde su éxito si falla su actualización',
  { tag: '@both' },
  async ({ page, request }) => {
    const s = await setup(request, page);
    await open(page, s.id);
    await activate(page);
    await page.route('**/api/index', (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Metadatos temporalmente no disponibles' }),
      }),
    );
    await cycle(page, s.data.result.cycles[0].date);
    await confirm(page, 'Confirmar ciclo');
    await expect(page.getByRole('heading', { name: 'QA_B elige ahora', exact: true })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'Elección confirmada' })).toBeVisible();
    await expect(page.getByText(/No se ha confirmado la adjudicación/)).toHaveCount(0);
    await expect(page.locator('.vac2-cycle').first()).toBeEnabled();
    expect((await read(request, s.id)).awards).toHaveLength(1);
  },
);

test(
  'los pasos automáticos confirmados se muestran antes de terminar y se conservan si falla continuar',
  { tag: '@both' },
  async ({ page, request }) => {
    const s = await setup(request, page),
      dates = s.data.result.cycles.map((c: any) => c.date);
    await open(page, s.id);
    await activate(page);
    // Lists saved before activation would be taken early during it; saving them now
    // leaves both automatic steps to the continuation that follows QA_A's choice.
    for (const person of [1, 2])
      await election(request, s.id, {
        action: 'preferences',
        memberId: s.data.members[person].id,
        dates: [dates[person]],
        persistent: false,
      });
    await page.reload();
    await expect(page.getByRole('heading', { name: 'QA_A elige ahora', exact: true })).toBeVisible();
    let advances = 0,
      release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/election/**', async (route) => {
      const body = route.request().method() === 'POST' ? route.request().postDataJSON() : null;
      if (body?.action === 'advance' && ++advances === 2) {
        await held;
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Continuación temporalmente no disponible' }),
        });
      } else await route.continue();
    });
    try {
      await cycle(page, dates[0]);
      await confirm(page, 'Confirmar ciclo');
      await expect.poll(() => advances).toBe(2);
      await expect(page.getByRole('heading', { name: 'QA_C elige ahora', exact: true })).toBeVisible();
      await expect(page.locator('.vac2-cycle').first()).toBeDisabled();
    } finally {
      release();
    }
    await expect(
      page.getByText(
        'La operación se ha guardado, pero no se han completado los automatismos. Puedes continuar los pendientes sin repetir la elección.',
      ),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Continuar automatismos', exact: true })).toBeEnabled();
    await expect(page.getByText(/No se ha confirmado la adjudicación/)).toHaveCount(0);
    const saved = await read(request, s.id);
    expect(saved.awards).toHaveLength(2);
    expect(saved.election.turn.memberId).toBe(s.data.members[2].id);
  },
);

test(
  'el modal de progreso solo aparece si tarda la adjudicación automática',
  { tag: '@both' },
  async ({ page, request }) => {
    const scenario = await setup(request, page);
    await open(page, scenario.id);
    await activate(page);
    const menu = page.locator('.election-turn-controls > .election-more-actions');
    await menu.locator('summary').click();
    await menu.getByRole('checkbox', { name: 'Requerir confirmación antes de adjudicar' }).uncheck();
    await page.route('**/api/election/**', async (route) => {
      if (route.request().method() === 'POST' && JSON.parse(route.request().postData() ?? '{}').action === 'choose')
        await new Promise((resolve) => setTimeout(resolve, 2000));
      await route.continue();
    });
    await cycle(page, scenario.data.result.cycles[0].date);
    await expect(page.getByRole('status').filter({ hasText: 'Registrando la adjudicación' })).toBeVisible();
    const dialog = page.getByRole('dialog', { name: 'El motor está comprobando el reparto' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Registrando la adjudicación');
    await expect(page.getByRole('heading', { name: 'QA_B elige ahora', exact: true })).toBeVisible();
    await expect(dialog).toHaveCount(0);
  },
);

test('integración: dos aplazamientos permiten elegir tres ciclos desde el calendario', async ({
  page,
  request,
}, info) => {
  const s = await setup(request, page);
  await open(page, s.id);
  await activate(page);
  const dates = s.data.result.cycles.map((c: any) => c.date);
  await confirm(page, 'Aplazar para elegir dos');
  for (let round = 0; round < 2; round++) {
    for (let person = 1; person < 4; person++)
      await election(request, s.id, {
        action: 'choose',
        memberId: s.data.members[person].id,
        dates: [dates[round * 3 + person - 1]],
      });
    await expect(page.getByRole('heading', { name: 'QA_A elige ahora', exact: true })).toBeVisible({ timeout: 18000 });
    if (round === 0) await confirm(page, 'Aplazar para elegir tres');
  }
  await cycle(page, dates[6]);
  await cycle(page, dates[7]);
  await expect(page.getByRole('button', { name: 'Confirmar tres ciclos', exact: true })).toBeDisabled();
  await expect(page.locator('.vac2-cycle[data-cycle-date="' + dates[8] + '"]').first()).toBeEnabled();
  await cycle(page, dates[8]);
  await confirm(page, 'Confirmar tres ciclos');
  await expect(page.getByRole('heading', { name: 'QA_B elige ahora', exact: true })).toBeVisible();
  await expect(page.getByText(/Turno triple: recupera 2 aplazamiento/)).toBeVisible();
  await expect(
    page.getByText('Turno aplazado, sin adjudicación. Acumula un ciclo para la siguiente ronda.'),
  ).toHaveCount(2);
  const result = await read(request, s.id);
  expect(result.awards.filter((a: any) => a.member_id === s.data.members[0].id)).toHaveLength(3);
  expect(result.requests.filter((a: any) => a.member_id === s.data.members[0].id)).toHaveLength(3);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  if (!process.env.CI) await page.screenshot({ path: info.outputPath('eleccion-integrada.png'), fullPage: true });
});

test('vista de controlador distingue Mis preferencias de la navegación administrativa', async ({ page, request }) => {
  const scenario = await setup(request, page);
  await open(page, scenario.id);
  await page.getByLabel('Probar simulación como controlador').selectOption('QA_A');
  await expect(page.getByText('Vista como controlador QA_A')).toBeVisible();
  const tabs = page.getByRole('group', { name: 'Modo de vacaciones' });
  const mine = tabs.getByRole('button', { name: 'Mis preferencias', exact: true });
  await expect(mine).toBeVisible();
  await expect(tabs.getByRole('button', { name: 'Preferencias', exact: true })).toHaveCount(0);
  await mine.click();
  await expect(mine).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.preferences-panel')).toBeVisible();
});

test(
  'vista de controlador: tarjeta «Mi elección», turno propio y glosario',
  { tag: '@both' },
  async ({ page, request }) => {
    const scenario = await setup(request, page);
    await open(page, scenario.id);
    await activate(page);
    const as = async (code: string) => {
      const url = new URL(page.url());
      url.searchParams.set('verComo', code);
      await page.goto(url.toString());
    };
    await as('QA_A');
    const card = page.getByRole('region', { name: 'Mi elección' });
    await expect(card.getByRole('heading', { name: 'Es tu turno' })).toBeVisible();
    await expect(card).toContainText('No tienes preferencias guardadas');
    await expect(card.getByRole('button', { name: 'Elegir ahora' })).toBeVisible();
    await as('QA_B');
    await expect(card.getByRole('heading', { name: 'Eres el siguiente' })).toBeVisible();
    await page.getByRole('link', { name: 'ⓘ Qué significa' }).click();
    await expect(page.locator('#glosario')).toHaveAttribute('open', '');
  },
);

test(
  'vista de controlador: previsión cuando quienes van delante eligen con sus preferencias (#66)',
  { tag: '@both' },
  async ({ page, request }) => {
    const s = await setup(request, page),
      dates = s.data.result.cycles.map((c: any) => c.date);
    // QA_A elige a mano; QA_B y QA_C, por delante de QA_D, tienen preferencias activas.
    for (const person of [1, 2])
      await election(request, s.id, {
        action: 'preferences',
        memberId: s.data.members[person].id,
        dates: [dates[person + 4]],
        persistent: true,
      });
    await open(page, s.id);
    await activate(page);
    const url = new URL(page.url());
    url.searchParams.set('verComo', 'QA_D');
    await page.goto(url.toString());
    const card = page.getByRole('region', { name: 'Mi elección' });
    await expect(card.getByRole('heading', { name: 'Faltan 3 turnos para el tuyo' })).toBeVisible();
    await expect(card).toContainText(
      'Tu turno puede llegar en cuanto termine quien está eligiendo ahora: las otras 2 personas que van delante elegirán automáticamente con sus preferencias.',
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  },
);

test('navegación compacta entre Calendario y Preferencias', async ({ page, request }) => {
  const s = await setup(request, page);
  await open(page, s.id);
  const switcher = page.getByRole('group', { name: 'Modo de vacaciones' });
  const calendar = switcher.getByRole('button', { name: 'Calendario', exact: true });
  const preferences = switcher.getByRole('button', { name: 'Preferencias', exact: true });
  await expect(calendar).toHaveAttribute('aria-pressed', 'true');
  await expect(preferences).toHaveAttribute('aria-pressed', 'false');
  await preferences.click();
  await expect(preferences).toHaveAttribute('aria-pressed', 'true');
  await calendar.click();
  await expect(calendar).toHaveAttribute('aria-pressed', 'true');
  for (const width of [320, 375, 430]) {
    await page.setViewportSize({ width, height: 640 });
    const bounds = await switcher.boundingBox();
    expect(bounds).not.toBeNull();
    // One row of 44 px touch targets (#64), never wrapped onto a second row.
    expect(bounds!.height).toBeLessThanOrEqual(56);
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  }
});

test(
  'móvil: el menú Más acciones permanece dentro de la pantalla',
  { tag: '@mobile-only' },
  async ({ page, request }) => {
    const s = await setup(request, page);
    await open(page, s.id);
    await activate(page);
    const actions = page.locator('.election-turn-controls > .election-more-actions');
    const summary = actions.locator('summary');
    for (const width of [320, 375, 430]) {
      await page.setViewportSize({ width, height: 640 });
      await summary.click();
      const menu = actions.locator('.election-more-menu');
      const defer = menu.getByRole('button', { name: 'Aplazar para elegir dos' });
      await expect(defer).toBeVisible();
      await defer.scrollIntoViewIfNeeded();
      const bounds = await menu.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
      await summary.click();
    }
  },
);

test('integración: administración agrupada y navegación pública en escritorio y móvil', async ({
  page,
  request,
  browser,
}, info) => {
  const s = await setup(request, page);
  await open(page, s.id);
  // Simulations are private: their PDF comes from the authenticated API.
  await expect(page.getByRole('button', { name: 'Ver PDF de la situación' })).toBeVisible();
  const pdf = await page.request.get('/api/campaign/' + s.id + '/pdf');
  expect(pdf.headers()['content-type']).toBe('application/pdf');
  const ctaPicker = page.getByRole('combobox', { name: 'Controlador para calendario PDF' });
  await expect(ctaPicker).toBeVisible();
  await ctaPicker.selectOption({ index: 1 });
  await expect(page.getByRole('button', { name: 'Ver calendario individual en PDF' })).toBeEnabled();
  const cta = await ctaPicker.inputValue();
  const individualPdf = await page.request.get(
    '/api/campaign/' + s.id + '/individual-pdf?cta=' + encodeURIComponent(cta),
  );
  expect(individualPdf.headers()['content-type']).toBe('application/pdf');
  expect((await individualPdf.text()).includes('/MediaBox [0 0 842 595]')).toBeTruthy();
  const badCta = await page.request.get('/api/campaign/' + s.id + '/individual-pdf?cta=no-existe');
  expect(badCta.status()).toBe(400);
  if (await page.getByRole('button', { name: 'Abrir menú', exact: true }).isVisible())
    await page.getByRole('button', { name: 'Abrir menú', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Configuración', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Administración', exact: true }).click();
  // Global work for all teams is not offered inside a simulation (#65).
  await expect(page.getByRole('heading', { name: 'Estado de la campaña' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Campañas anuales' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Descargar copia completa v2' })).toBeHidden();
  await page.getByText('Parámetros del ejercicio', { exact: true }).click();
  await expect(page.getByRole('button', { name: 'Guardar parámetros' })).toBeVisible();
  await page.getByText('Parámetros del ejercicio', { exact: true }).click();
  await page.getByText('Herramientas avanzadas', { exact: true }).click();
  await expect(page.getByRole('button', { name: 'Descargar copia completa v2' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  if (!process.env.CI) await page.screenshot({ path: info.outputPath('administracion-integrada.png'), fullPage: true });
  const anonymous = await browser.newContext({ baseURL: origin });
  const p = await anonymous.newPage();
  await p.goto('/?equipo=C&year=2026');
  await expect(p.getByRole('heading', { name: 'Disponibilidad y baremo' })).toBeVisible();
  await expect(p.getByRole('button', { name: 'Administración', exact: true })).toHaveCount(0);
  await anonymous.close();
});

test('calendario público, permisos y aislamiento', { tag: '@smoke' }, async ({ page, request, browser }) => {
  const s = await setup(request, page);
  await open(page, s.id);
  await activate(page);
  const anonymous = await browser.newContext({ baseURL: origin });
  const p = await anonymous.newPage();
  await p.goto('/?equipo=C&year=2026');
  await expect(p.getByRole('heading', { name: 'Disponibilidad y baremo' })).toBeVisible();
  await expect(p.getByLabel('Escenario', { exact: true })).toHaveCount(0);
  await expect(p.getByRole('button', { name: 'Confirmar ciclo', exact: true })).toHaveCount(0);
  expect((await anonymous.request.get('/api/campaign/' + s.id)).status()).toBe(403);
  expect(
    (
      await anonymous.request.post('/api/election/' + s.id, { data: { action: 'pause' }, headers: { Origin: origin } })
    ).status(),
  ).toBe(401);
  const after = await read(request, s.live.id);
  expect(after.awards).toEqual(s.baseline.awards);
  expect(after.campaign).toEqual(s.baseline.campaign);
  await anonymous.close();
});

test(
  'aplazar, elegir dos en calendario y deshacer/rehacer',
  { tag: ['@both', '@smoke'] },
  async ({ page, request }) => {
    const s = await setup(request, page);
    await open(page, s.id);
    await activate(page);
    const dates = s.data.result.cycles.map((c: any) => c.date);
    await cycle(page, dates[0]);
    await confirm(page, 'Aplazar para elegir dos');
    // An open action menu would cover the Redo control on desktop.
    await expect(page.locator('.election-turn-controls > .election-more-actions')).not.toHaveAttribute('open', '');
    await expect(page.getByRole('heading', { name: 'QA_B elige ahora', exact: true })).toBeVisible();
    for (let i = 1; i < 4; i++) {
      await cycle(page, dates[i - 1]);
      await confirm(page, 'Confirmar ciclo');
      await expect(
        page.getByRole('heading', {
          name: (i === 3 ? 'QA_A' : ['QA_A', 'QA_B', 'QA_C', 'QA_D'][i + 1]) + ' elige ahora',
          exact: true,
        }),
      ).toBeVisible();
    }
    await cycle(page, dates[0]);
    await expect(page.getByRole('button', { name: 'Confirmar ambos ciclos', exact: true })).toBeDisabled();
    const options = await (await request.get('/api/election/' + s.id + '/options?selected=' + dates[0])).json();
    await expect(page.locator('.vac2-cycle[data-cycle-date="' + options.available[0] + '"]').first()).toBeEnabled();
    await cycle(page, options.available[0]);
    await confirm(page, 'Confirmar ambos ciclos');
    await expect(page.getByRole('heading', { name: 'QA_B elige ahora', exact: true })).toBeVisible();
    expect((await read(request, s.id)).awards).toHaveLength(5);
    await confirm(page, '↶ Deshacer');
    await expect(page.getByRole('heading', { name: 'QA_A elige ahora', exact: true })).toBeVisible();
    expect((await read(request, s.id)).awards).toHaveLength(3);
    await confirm(page, '↷ Rehacer');
    await expect(page.getByRole('heading', { name: 'QA_B elige ahora', exact: true })).toBeVisible();
    expect((await read(request, s.id)).awards).toHaveLength(5);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  },
);

test('preferencias delegadas y elección automática al llegar el turno', async ({ page, request }) => {
  const s = await setup(request, page),
    date = s.data.result.cycles[0].date;
  await open(page, s.id);
  await page
    .getByRole('group', { name: 'Modo de vacaciones' })
    .getByRole('button', { name: 'Preferencias', exact: true })
    .click();
  await page.getByLabel('Preferencias de controlador', { exact: true }).selectOption(s.data.members[1].id);
  await cycle(page, date);
  await expect(page.getByLabel('Asignar automáticamente desde esta lista cuando llegue mi turno')).toHaveCount(0);
  if (
    !(await page.locator('.preference-sheet').isVisible()) &&
    (await page.getByRole('button', { name: 'Revisar y guardar', exact: true }).isVisible())
  )
    await page.getByRole('button', { name: 'Revisar y guardar', exact: true }).click();
  await page.getByRole('button', { name: 'Guardar preferencias', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Preferencias guardadas' }).first()).toBeVisible();
  if (await page.getByRole('button', { name: 'Cerrar revisión de preferencias', exact: true }).isVisible())
    await page.getByRole('button', { name: 'Cerrar revisión de preferencias', exact: true }).click();
  await page
    .getByRole('group', { name: 'Modo de vacaciones' })
    .getByRole('button', { name: 'Calendario', exact: true })
    .click();
  await activate(page);
  await cycle(page, date);
  await confirm(page, 'Confirmar ciclo');
  await expect(page.getByRole('heading', { name: 'QA_C elige ahora', exact: true })).toBeVisible();
  const d = await read(request, s.id);
  expect(d.awards).toHaveLength(2);
  expect(d.awards.some((a: any) => a.member_id === s.data.members[1].id)).toBeTruthy();
});

test('undo en navegador deshace solo el último turno automático y permite corregirlo', async ({ page, request }) => {
  const s = await setup(request, page),
    dates = s.data.result.cycles.map((x: any) => x.date),
    [a, b, c, d] = s.data.members;
  await open(page, s.id);
  await activate(page);
  // Saved after activation so they run as automatic turns, not as early choices.
  await election(request, s.id, { action: 'preferences', memberId: b.id, dates: [dates[1]] });
  await election(request, s.id, { action: 'preferences', memberId: c.id, dates: [dates[2]] });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'QA_A elige ahora', exact: true })).toBeVisible();
  await cycle(page, dates[0]);
  await confirm(page, 'Confirmar ciclo');
  await expect(page.getByRole('heading', { name: 'QA_D elige ahora', exact: true })).toBeVisible();
  let current = await read(request, s.id);
  expect(current.awards.map((x: any) => x.member_id).sort()).toEqual([a.id, b.id, c.id].sort());
  await confirm(page, '↶ Deshacer');
  await expect(page.getByRole('heading', { name: 'QA_C elige ahora', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reanudar automatismos', exact: true })).toBeVisible();
  current = await read(request, s.id);
  expect(current.awards.map((x: any) => x.member_id).sort()).toEqual([a.id, b.id].sort());
  expect(current.election.state.automaticPaused).toBe(true);
  expect(current.election.preferences.find((p: any) => p.member_id === c.id).active).toBe(true);
  await cycle(page, dates[3]);
  await confirm(page, 'Confirmar ciclo');
  await expect(page.getByRole('heading', { name: 'QA_D elige ahora', exact: true })).toBeVisible();
  current = await read(request, s.id);
  expect(current.awards.find((x: any) => x.member_id === c.id)?.cycle_date).toBe(dates[3]);
  expect(current.election.state.automaticPaused).toBe(true);
  await page.getByRole('button', { name: 'Reanudar automatismos', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Confirmar', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Reanudar automatismos', exact: true })).toHaveCount(0);
  expect((await read(request, s.id)).election.state.automaticPaused).toBe(false);
});

test('guardar preferencias durante el turno avisa antes de adjudicar automáticamente', async ({ page, request }) => {
  const s = await setup(request, page),
    member = s.data.members[0],
    date = s.data.result.cycles[0].date;
  await open(page, s.id);
  await activate(page);
  await page
    .getByRole('group', { name: 'Modo de vacaciones' })
    .getByRole('button', { name: 'Preferencias', exact: true })
    .click();
  await page.getByLabel('Preferencias de controlador', { exact: true }).selectOption(member.id);
  await cycle(page, date);
  if (
    !(await page.locator('.preference-sheet').isVisible()) &&
    (await page.getByRole('button', { name: 'Revisar y guardar', exact: true }).isVisible())
  )
    await page.getByRole('button', { name: 'Revisar y guardar', exact: true }).click();
  await page.getByRole('button', { name: 'Guardar preferencias', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Confirmar cambio' });
  await expect(dialog).toContainText('adjudicar inmediatamente');
  await expect(dialog).toContainText('sin otra confirmación');
  expect((await read(request, s.id)).awards).toHaveLength(0);
  await dialog.getByRole('button', { name: 'Cancelar', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect((await read(request, s.id)).awards).toHaveLength(0);
  if (
    !(await page.locator('.preference-sheet').isVisible()) &&
    (await page.getByRole('button', { name: 'Revisar y guardar', exact: true }).isVisible())
  )
    await page.getByRole('button', { name: 'Revisar y guardar', exact: true }).click();
  await page.getByRole('button', { name: 'Guardar preferencias', exact: true }).click();
  await dialog.getByRole('button', { name: 'Confirmar', exact: true }).click();
  if (await page.getByRole('button', { name: 'Cerrar revisión de preferencias', exact: true }).isVisible())
    await page.getByRole('button', { name: 'Cerrar revisión de preferencias', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'QA_B elige ahora', exact: true })).toBeVisible();
  const after = await read(request, s.id);
  expect(after.awards.filter((a: any) => a.member_id === member.id).map((a: any) => a.cycle_date)).toEqual([date]);
  expect(after.election.preferences.find((p: any) => p.member_id === member.id)).toMatchObject({
    dates: [date],
    automatic: true,
  });
});

test(
  'reconstrucción guiada: tercera elección distinta y cuarta por preferencias anteriores',
  { tag: '@both' },
  async ({ page, request }, info) => {
    if (info.project.name === 'chromium') await page.setViewportSize({ width: 1440, height: 900 });
    const s = await setup(request, page),
      dates = s.data.result.cycles.map((c: any) => c.date),
      ids = s.data.members.map((m: any) => m.id);
    await election(request, s.id, { action: 'preferences', memberId: ids[3], dates: [dates[4]] });
    await election(request, s.id, {
      action: 'start',
      order: ids,
      source: 'Orden ficticio para reconstrucción UI Playwright',
      rulesConfirmed: true,
      allowDeferral: true,
    });
    for (let i = 0; i < 3; i++)
      await election(request, s.id, { action: 'choose', memberId: ids[i], dates: [dates[i]] });
    await election(request, s.id, { action: 'advance' });
    await open(page, s.id);
    const historyPanel = page.getByRole('region', { name: 'Historial de elección' });
    await expect(page.getByRole('heading', { name: 'Reconstruir elecciones anteriores' })).toHaveCount(0);
    await expect(historyPanel.getByRole('button', { name: 'Desde aquí' })).toHaveCount(0);
    await historyPanel.locator('summary[aria-label="Más acciones del historial"]').click();
    await historyPanel.getByRole('button', { name: 'Reconstruir desde un turno…' }).click();
    await expect(historyPanel.getByRole('region', { name: 'Elegir inicio de reconstrucción' })).toBeVisible();
    const history = (await read(request, s.id)).election.reconstruction.candidates;
    const point = history.find((e: any) => e.action === 'choose' && e.memberIds.includes(ids[2]));
    expect(point).toBeTruthy();
    await historyPanel.getByRole('button', { name: 'Reconstruir desde QA_C (ronda 1)' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Confirmar', exact: true }).click();
    await expect(page.locator('.reconstruction-status')).toContainText('Elección congelada');
    await expect(page.getByText('Decisión del administrador', { exact: true })).toBeVisible();
    const editor = page.getByRole('region', { name: 'Reconstrucción guiada' }),
      calendar = page.locator('.election-calendar-wrap');
    await expect(editor.locator('.reconstruction-decisions label').first()).toHaveCSS('flex-direction', 'row');
    await expect(page.locator('.reconstruction-status')).toContainText('Reconstrucción en curso');
    await expect(page.getByRole('region', { name: 'Turno de elección' })).toHaveCount(0);
    const checkLayout = async (side: boolean) => {
      const panelBox = await editor.boundingBox(),
        calendarBox = await calendar.boundingBox();
      expect(panelBox).toBeTruthy();
      expect(calendarBox).toBeTruthy();
      if (side) {
        expect(panelBox!.x).toBeGreaterThanOrEqual(calendarBox!.x + calendarBox!.width);
        expect(panelBox!.width).toBeLessThanOrEqual(361);
      } else expect(panelBox!.y + panelBox!.height).toBeLessThanOrEqual(calendarBox!.y);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    };
    await checkLayout(info.project.name === 'chromium');
    if (!process.env.CI) await page.screenshot({ path: info.outputPath('reconstruction-initial.png'), fullPage: true });
    if (!process.env.CI) await editor.screenshot({ path: info.outputPath('reconstruction-panel.png') });
    await editor.getByLabel('Registrar otra decisión').check();
    const alternative = editor.getByLabel('Ciclo alternativo');
    await alternative.selectOption(dates[5]);
    await expect(alternative).toHaveCount(0);
    await expect(editor.getByText('Pendiente de registrar')).toBeVisible();
    await expect(editor.getByRole('button', { name: 'Cambiar ciclo 1' })).toBeVisible();
    await expect(editor.getByRole('button', { name: 'Registrar decisión y continuar' })).toBeEnabled();
    await editor.getByRole('button', { name: 'Cambiar ciclo 1' }).click();
    await expect(alternative).toBeVisible();
    await expect(editor.getByRole('button', { name: 'Registrar decisión y continuar' })).toBeDisabled();
    await alternative.selectOption(dates[3]);
    await expect(alternative).toHaveCount(0);
    if (info.project.name === 'chromium') {
      for (const viewport of [
        { width: 1280, height: 720 },
        { width: 1440, height: 650 },
        { width: 768, height: 1024 },
      ]) {
        await page.setViewportSize(viewport);
        await checkLayout(viewport.width > 900);
        await editor.scrollIntoViewIfNeeded();
        await expect(editor.getByRole('button', { name: 'Registrar decisión y continuar' })).toBeInViewport();
        if (!process.env.CI)
          await page.screenshot({
            path: info.outputPath('reconstruction-' + viewport.width + 'x' + viewport.height + '.png'),
            fullPage: true,
          });
      }
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.evaluate(() => window.scrollTo(0, 650));
      await expect(editor.getByRole('button', { name: 'Registrar decisión y continuar' })).toBeInViewport();
      expect((await editor.boundingBox())!.y).toBeGreaterThanOrEqual(15);
      if (!process.env.CI) await page.screenshot({ path: info.outputPath('reconstruction-sticky.png') });
    }
    await page.getByRole('button', { name: 'Registrar decisión y continuar' }).click();
    await expect(page.getByText('Mejor preferencia histórica:')).toBeVisible();
    await page.getByRole('button', { name: 'Registrar decisión y continuar' }).click();
    await expect(page.getByRole('heading', { name: 'Turnos reconstruidos' })).toBeVisible();
    await page.getByRole('button', { name: 'Finalizar reconstrucción' }).click();
    await confirmSaved(page, s.id);
    const result = await read(request, s.id);
    expect(result.election.reconstruction.status).toBe('completed');
    expect(result.awards.find((a: any) => a.member_id === ids[2]).cycle_date).toBe(dates[3]);
    expect(result.awards.find((a: any) => a.member_id === ids[3]).cycle_date).toBe(dates[4]);
    expect(result.election.state.automaticPaused).toBe(true);
    await expect(page.getByRole('heading', { name: 'Reconstruir elecciones anteriores' })).toHaveCount(0);
    await expect(editor).toHaveCount(0);
    await expect(page.locator('.reconstruction-status')).toHaveCount(0);
    await expect(historyPanel.getByText(/Última reconstrucción/)).toBeVisible();
  },
);

test('reconstrucción: un turno doble oculta el selector completo y permite cambiar cualquier ciclo', async ({
  page,
  request,
}) => {
  const s = await setup(request, page),
    ids = s.data.members.map((m: any) => m.id),
    dates = s.data.result.cycles.map((c: any) => c.date);
  await open(page, s.id);
  await activate(page);
  await confirm(page, 'Aplazar para elegir dos');
  for (let i = 1; i < 4; i++) await election(request, s.id, { action: 'choose', memberId: ids[i], dates: [dates[i]] });
  await expect(page.getByRole('heading', { name: 'QA_A elige ahora', exact: true })).toBeVisible();
  await cycle(page, dates[0]);
  const options = await (await request.get('/api/election/' + s.id + '/options?selected=' + dates[0])).json();
  await cycle(page, options.available[0]);
  await confirm(page, 'Confirmar ambos ciclos');
  const before = await read(request, s.id);
  const point = before.election.reconstruction.candidates.find(
    (c: any) => c.action === 'choose' && c.memberIds.includes(ids[0]),
  );
  expect(point).toBeTruthy();
  await election(request, s.id, { action: 'reconstruction_start', historyId: point.id });
  await open(page, s.id);
  const editor = page.getByRole('region', { name: 'Reconstrucción guiada' });
  await expect(editor.getByRole('heading', { name: /QA_A.*Elegir 2 ciclo/ })).toBeVisible();
  await editor.getByLabel('Registrar otra decisión').check();
  const alternative = editor.getByLabel('Ciclo alternativo');
  const available = (await read(request, s.id)).election.reconstruction.current.available as string[];
  expect(available.length).toBeGreaterThanOrEqual(2);
  await alternative.selectOption(available[0]);
  await expect(alternative).toBeVisible();
  await expect(alternative.locator('option[value="' + available[0] + '"]')).toHaveCount(0);
  await expect(editor.getByRole('button', { name: 'Registrar decisión y continuar' })).toBeDisabled();
  await alternative.selectOption(available[1]);
  await expect(alternative).toHaveCount(0);
  await expect(editor.getByRole('button', { name: 'Cambiar ciclo 1' })).toBeVisible();
  await expect(editor.getByRole('button', { name: 'Cambiar ciclo 2' })).toBeVisible();
  await expect(editor.getByRole('button', { name: 'Registrar decisión y continuar' })).toBeEnabled();
  await editor.getByRole('button', { name: 'Cambiar ciclo 1' }).click();
  await expect(alternative).toBeVisible();
  await expect(editor.getByRole('button', { name: 'Registrar decisión y continuar' })).toBeDisabled();
  await alternative.selectOption(available[0]);
  await expect(alternative).toHaveCount(0);
  await expect(editor.getByRole('button', { name: 'Registrar decisión y continuar' })).toBeEnabled();
  await editor.getByRole('button', { name: 'Cancelar y restaurar estado original' }).click();
  await confirmSaved(page, s.id);
  expect((await read(request, s.id)).awards.map((a: any) => [a.member_id, a.cycle_date]).sort()).toEqual(
    before.awards.map((a: any) => [a.member_id, a.cycle_date]).sort(),
  );
});

test('reconstrucción lateral: deshacer, rehacer y cancelar restaura las adjudicaciones', async ({ page, request }) => {
  const s = await setup(request, page),
    ids = s.data.members.map((m: any) => m.id),
    dates = s.data.result.cycles.map((c: any) => c.date);
  await election(request, s.id, {
    action: 'start',
    order: ids,
    source: 'Orden ficticio para restauración de reconstrucción lateral',
    rulesConfirmed: true,
    allowDeferral: true,
  });
  for (let i = 0; i < 3; i++) await election(request, s.id, { action: 'choose', memberId: ids[i], dates: [dates[i]] });
  const before = await read(request, s.id),
    point = before.election.reconstruction.candidates.find((c: any) => c.memberIds.includes(ids[1]));
  await election(request, s.id, { action: 'reconstruction_start', historyId: point.id });
  await open(page, s.id);
  const editor = page.getByRole('region', { name: 'Reconstrucción guiada' });
  await editor.getByLabel('Recuperar elección anterior').check();
  await editor.getByRole('button', { name: 'Registrar decisión y continuar' }).click();
  await expect(editor.getByRole('heading', { name: /QA_C/ })).toBeVisible();
  await editor.getByRole('button', { name: 'Deshacer paso' }).click();
  await expect(editor.getByRole('heading', { name: /QA_B/ })).toBeVisible();
  await editor.getByRole('button', { name: 'Rehacer paso' }).click();
  await expect(editor.getByRole('heading', { name: /QA_C/ })).toBeVisible();
  await editor.getByRole('button', { name: 'Cancelar y restaurar estado original' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancelar', exact: true }).click();
  await expect(editor).toBeVisible();
  await editor.getByRole('button', { name: 'Cancelar y restaurar estado original' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Confirmar', exact: true }).click();
  await expect(editor).toHaveCount(0);
  const after = await read(request, s.id);
  expect(after.awards.map((a: any) => [a.member_id, a.cycle_date]).sort()).toEqual(
    before.awards.map((a: any) => [a.member_id, a.cycle_date]).sort(),
  );
  // Everything is restored except the open turn's clock: choosing was frozen during the
  // reconstruction, so that turn starts waiting again when it ends (server/reconstruction.ts).
  const { turnSince: restartedClock, ...restored } = after.election.state;
  const { turnSince: originalClock, ...original } = before.election.state;
  expect(restored).toEqual(original);
  expect(restartedClock.cursor).toBe(originalClock.cursor);
  expect(Date.parse(restartedClock.at)).toBeGreaterThan(Date.parse(originalClock.at));
});
test(
  'un administrador puede iniciar reconstrucción desde una rama abandonada del historial',
  { tag: ['@both', '@smoke'] },
  async ({ page, request }) => {
    const s = await setup(request, page),
      dates = s.data.result.cycles.map((c: any) => c.date),
      ids = s.data.members.map((m: any) => m.id);
    await election(request, s.id, {
      action: 'start',
      order: ids,
      source: 'Orden ficticio para probar el historial de ramas',
      rulesConfirmed: true,
      allowDeferral: false,
    });
    for (let i = 0; i < 4; i++)
      await election(request, s.id, { action: 'choose', memberId: ids[i], dates: [dates[i]] });
    let state = await read(request, s.id);
    state = await election(request, s.id, { action: 'election_undo', historyId: state.election.undo });
    state = await election(request, s.id, { action: 'election_undo', historyId: state.election.undo });
    await election(request, s.id, { action: 'choose', memberId: ids[2], dates: [dates[6]] });
    state = await read(request, s.id);
    expect(state.election.redo).toBeNull();
    const archived = state.election.reconstruction.candidates.find(
      (candidate: any) => candidate.archived && candidate.memberIds.includes(ids[2]),
    );
    expect(archived).toBeTruthy();
    await open(page, s.id);
    const historyPanel = page.getByRole('region', { name: 'Historial de elección' });
    await expect(historyPanel.getByText(/Recuperación excepcional/)).toHaveCount(0);
    await historyPanel.locator('summary[aria-label="Más acciones del historial"]').click();
    await historyPanel.getByRole('button', { name: 'Reconstruir desde un turno…' }).click();
    const recovery = historyPanel.locator('.history-archived-choices');
    await expect(recovery).not.toHaveAttribute('open');
    await expect(historyPanel.getByRole('button', { name: 'Reconstruir desde QA_C (ronda 1)' })).toBeVisible();
    expect(
      await historyPanel
        .locator('.election-log')
        .evaluate(
          (history) =>
            !!(
              history.compareDocumentPosition(history.parentElement!.querySelector('.history-archived-choices')!) &
              Node.DOCUMENT_POSITION_FOLLOWING
            ),
        ),
    ).toBe(true);
    await expect(recovery.getByRole('button', { name: 'Recuperar esta decisión anterior' })).not.toBeVisible();
    await historyPanel.locator('.history-archived-choices summary').click();
    await expect(recovery.getByRole('button', { name: 'Recuperar esta decisión anterior' })).toBeDisabled();
    await expect(historyPanel.getByLabel('Elegir decisión de rama anterior')).toHaveValue('');
    await expect(recovery).toContainText(
      'Para corregir una elección actual, busca su ronda arriba y pulsa «Desde aquí»',
    );
    await historyPanel.getByLabel('Elegir decisión de rama anterior').selectOption(archived.id);
    await historyPanel.getByRole('button', { name: 'Recuperar esta decisión anterior' }).click();
    await confirmSaved(page, s.id);
    state = await read(request, s.id);
    expect(state.election.reconstruction.active).toBe(true);
    expect(state.election.reconstruction.current.memberId).toBe(ids[2]);
    expect(state.awards).toHaveLength(2);
    await expect(page.locator('.reconstruction-status')).toContainText('Elección congelada');
  },
);
test('bloqueo, descarga y restauración de backup completo', async ({ page, request }, info) => {
  const s = await setup(request, page);
  await open(page, s.id);
  await activate(page);
  if (await page.getByRole('button', { name: 'Abrir menú', exact: true }).isVisible())
    await page.getByRole('button', { name: 'Abrir menú', exact: true }).click();
  await page.getByRole('button', { name: 'Administración', exact: true }).click();
  await page.getByText('Herramientas avanzadas', { exact: true }).click();
  // A v1 JSON downloaded from the panel restores through the panel's own form.
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Descargar copia v1', exact: true }).click();
  const v1 = JSON.parse(readFileSync((await (await download).path())!, 'utf8'));
  expect(v1.payload.format).toBe('vacaciones-backup-v1');
  const campaigns = v1.payload.tables.campaigns.length;
  await page.getByLabel('Restaurar copia').setInputFiles({
    name: 'copia.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(v1)),
  });
  await page.getByRole('dialog').getByRole('button', { name: 'Confirmar', exact: true }).click();
  await expect(page.getByText('Copia restaurada')).toBeVisible();
  expect((await (await request.get('/api/backup')).json()).payload.tables.campaigns).toHaveLength(campaigns);
  // Test-only disk writer shim: production never falls back to an in-memory Blob.
  await page.evaluate(() => {
    const w = window as BackupTestWindow;
    w.__backupLines = [];
    w.__backupClosed = false;
    w.__backupAborted = false;
    w.showSaveFilePicker = async () => ({
      createWritable: async () => ({
        write: async (line: string) => {
          w.__backupLines.push(line);
        },
        close: async () => {
          w.__backupClosed = true;
        },
        abort: async () => {
          w.__backupLines = [];
          w.__backupAborted = true;
        },
      }),
    });
  });
  await page.getByRole('button', { name: 'Descargar copia completa v2' }).click();
  await expect
    .poll(() => page.evaluate(() => (window as BackupTestWindow).__backupClosed), { timeout: 60000 })
    .toBe(true);
  const lines = await page.evaluate(() =>
    (window as BackupTestWindow).__backupLines.map((line: string) => JSON.parse(line)),
  );
  expect(lines[0].payload.format).toBe('vacaciones-backup-v2');
  expect(lines.at(-1).kind).toBe('complete');
  await page.evaluate(() => {
    (window as BackupTestWindow).__backupClosed = false;
  });
  await page.route(
    '**/api/backup-v2/page',
    (route) =>
      route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Escritura concurrente sintética' }),
      }),
    { times: 1 },
  );
  await page.getByRole('button', { name: 'Descargar copia completa v2' }).click();
  await expect.poll(() => page.evaluate(() => (window as BackupTestWindow).__backupAborted)).toBe(true);
  expect(await page.evaluate(() => (window as BackupTestWindow).__backupClosed)).toBe(false);
  expect(await page.evaluate(() => (window as BackupTestWindow).__backupLines.length)).toBe(0);
  await expect(page.getByText(/Escritura concurrente sintética/)).toBeVisible();
  const backup = await (await request.get('/api/backup')).json();
  await confirm(page, 'Cerrar equipo C');
  await expect(page.getByText('Campaña cerrada', { exact: true })).toBeVisible();
  let d = await read(request, s.id);
  expect(d.campaign.status).toBe('closed');
  const blocked = await request.post('/api/election/' + s.id, {
    data: { action: 'preferences', version: d.campaign.version, memberId: d.members[0].id, dates: [] },
    headers: { Origin: origin },
  });
  expect(blocked.status()).toBe(400);
  const current = await (await request.get('/api/backup')).json();
  await post(request, 'restore', { backup, revision: current.payload.revision });
  d = await read(request, s.id);
  expect(d.campaign.status).toBe('open');
  expect(d.election.state.status).toBe('active');
});

test(
  'Criterios 1.1: dos CTA eligen juntos al llegar el último, en una sola transacción',
  { tag: '@both' },
  async ({ page, request }) => {
    const fixture = await setup(request, page),
      dates = fixture.data.result.cycles.map((c: any) => c.date);
    await open(page, fixture.id);
    await activate(page);
    // Agree exceptionally during round 1, not as part of campaign preparation.
    await page.getByLabel('Más acciones', { exact: true }).click();
    await page.getByRole('button', { name: 'Gestionar turnos conjuntos…' }).click();
    const joint = page.getByRole('region', { name: 'Gestionar turnos conjuntos' });
    await expect(joint).toBeVisible();
    await joint.getByRole('checkbox', { name: 'QA_A' }).check();
    await joint.getByRole('checkbox', { name: 'QA_C' }).check();
    await joint.getByRole('button', { name: 'Registrar acuerdo' }).click();
    await expect(page.getByRole('heading', { name: 'QA_B elige ahora' })).toBeVisible();
    await cycle(page, dates[0]);
    await confirm(page, 'Confirmar ciclo');
    await expect(page.getByRole('heading', { name: 'QA_A + QA_C elige ahora' })).toBeVisible();
    await cycle(page, dates[1]);
    await expect(page.getByRole('button', { name: 'Confirmar turno conjunto' })).toBeDisabled();
    await page.getByRole('button', { name: /QA_C: 0\/1/ }).click();
    await cycle(page, dates[2]);
    await confirm(page, 'Confirmar turno conjunto');
    const after = await read(request, fixture.id);
    expect(after.awards).toHaveLength(3);
    expect(after.requests).toHaveLength(3);
    await expect(page.getByRole('heading', { name: 'QA_D elige ahora' })).toBeVisible();
  },
);

test(
  'responsive: mapa, calendario mensual, tabla de CTA y selección móvil',
  { tag: '@mobile-only' },
  async ({ page, request }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const s = await setup(request, page);
    await open(page, s.id);
    await activate(page);
    await expect(page.getByRole('button', { name: 'Mapa', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('button', { name: 'Por CTA', exact: true })).toBeVisible();
    await page
      .getByRole('group', { name: 'Vista del calendario' })
      .getByRole('button', { name: 'Meses', exact: true })
      .click();
    await expect(page.getByRole('button', { name: 'Siguiente →' })).toBeVisible();
    await page.getByRole('button', { name: 'Siguiente →' }).click();
    await expect(page.getByRole('button', { name: '← Anterior' })).toBeEnabled();
    await page.getByRole('button', { name: 'Por CTA', exact: true }).click();
    await expect(page.locator('.vac2-member-card').first()).toBeVisible();
    await page.getByRole('button', { name: 'Mapa', exact: true }).click();
    await cycle(page, s.data.result.cycles[0].date);
    await expect(page.getByRole('region', { name: 'Detalle del ciclo seleccionado' })).toBeVisible();
    await expect(page.locator('.vac2-choice-card')).toHaveCSS('position', 'fixed');
    await confirm(page, 'Confirmar ciclo');
    await expect(page.getByRole('region', { name: 'Detalle del ciclo seleccionado' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'QA_B elige ahora', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Últimos turnos y adjudicaciones', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  },
);

test('dos clientes abiertos reciben una adjudicación sin recargar manualmente', async ({ page, request }) => {
  const s = await setup(request, page);
  await open(page, s.id);
  await activate(page);
  const second = await page.context().newPage();
  await second.goto('/?equipo=C&year=2026');
  await second.getByLabel('Escenario', { exact: true }).selectOption(s.id);
  await expect(second.getByRole('heading', { name: 'QA_A elige ahora' })).toBeVisible();
  const date = s.data.result.cycles[0].date;
  await cycle(page, date);
  await confirm(page, 'Confirmar ciclo');
  await expect(second.getByRole('heading', { name: 'QA_B elige ahora' })).toBeVisible({ timeout: 18000 });
  await expect(second.locator('.vac2-cycle[data-cycle-date="' + date + '"]')).toContainText('QA_A');
  if (await second.getByRole('button', { name: 'Abrir menú', exact: true }).isVisible())
    await second.getByRole('button', { name: 'Abrir menú', exact: true }).click();
  await second.getByRole('button', { name: 'Administración', exact: true }).click();
  const updated = await election(request, s.id, {
    action: 'choose',
    memberId: s.data.members[1].id,
    dates: [s.data.result.cycles[1].date],
  });
  expect(updated.awards).toHaveLength(2);
  // The sync indicator is only shown when offline (#65); it must still report live updates.
  await expect(second.locator('.campaign-strip-sync')).toHaveText('Actualización automática · hasta 5 s');
  if (await second.getByRole('button', { name: 'Abrir menú', exact: true }).isVisible())
    await second.getByRole('button', { name: 'Abrir menú', exact: true }).click();
  await second.getByRole('button', { name: 'Vacaciones', exact: true }).click();
  await expect(second.getByRole('heading', { name: 'QA_C elige ahora' })).toBeVisible({ timeout: 18000 });
  await second.close();
});

test(
  'empate anticipado conserva el turno y deja formar grupo conjunto con casillas horizontales',
  { tag: '@mobile-only' },
  async ({ page, request }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const s = await setup(request, page);
    await open(page, s.id);
    await activate(page, 'QA_C');
    await expect(page.getByRole('heading', { name: 'QA_A elige ahora' })).toBeVisible();
    await page.getByLabel('Más acciones', { exact: true }).click();
    await page.getByRole('button', { name: /Resolver empates pendientes/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Resolver empates pendientes' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('QA_B');
    await expect(dialog).toContainText('QA_C');
    await dialog.getByRole('button', { name: 'Añadir al sorteo QA_C' }).click();
    await dialog.getByRole('button', { name: 'Añadir al sorteo QA_B' }).click();
    await dialog.getByRole('button', { name: 'Guardar orden externo' }).click();
    await page
      .getByRole('dialog', { name: 'Confirmar cambio' })
      .getByRole('button', { name: 'Confirmar', exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    const resolved = await read(request, s.id);
    expect(resolved.election.state.tieResolutions[0].anticipated).toBe(true);
    expect(resolved.election.state.tieResolutions[0].order).toEqual([s.data.members[2].id, s.data.members[1].id]);
    expect(resolved.election.turn.memberId).toBe(s.data.members[0].id);
    await expect(page.getByRole('heading', { name: 'QA_A elige ahora' })).toBeVisible();
    await page.getByLabel('Más acciones', { exact: true }).click();
    await page.getByRole('button', { name: 'Gestionar turnos conjuntos…' }).click();
    const joint = page.getByRole('region', { name: 'Gestionar turnos conjuntos' });
    const checkbox = joint.getByRole('checkbox', { name: 'QA_A' });
    // Resolve the associated label from the input: a locator scoped to "joint"
    // cannot be used inside filter({has: ...}) on a descendant label.
    const name = checkbox.locator('..').locator('span');
    await expect(name).toHaveText('QA_A');
    const inputBox = await checkbox.boundingBox();
    const nameBox = await name.boundingBox();
    expect(inputBox && nameBox && nameBox.x >= inputBox.x + inputBox.width - 1).toBeTruthy();
    await checkbox.check();
    await joint.getByRole('checkbox', { name: 'QA_C' }).check();
    await joint.getByRole('button', { name: 'Registrar acuerdo' }).click();
    expect((await read(request, s.id)).election.state.jointAgreements).toHaveLength(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  },
);

test('empate de tres: registrar orden externo pulsando nombres, persistir y rotar', async ({ page, request }) => {
  const s = await setup(request, page);
  await open(page, s.id);
  await activate(page, 'QA_B, QA_C, QA_D');
  await cycle(page, s.data.result.cycles[0].date);
  await confirm(page, 'Confirmar ciclo');
  const panel = page.getByRole('region', { name: 'Resolver empate' });
  await expect(page.getByRole('heading', { name: 'Empate pendiente de sorteo' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Confirmar ciclo', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Guardar orden externo', exact: true })).toBeDisabled();
  for (const code of ['QA_D', 'QA_B', 'QA_C'])
    await page.getByRole('button', { name: 'Añadir al sorteo ' + code, exact: true }).click();
  await expect(page.getByRole('list', { name: 'Orden del sorteo externo' })).toHaveText('QA_DQA_BQA_C');
  await confirm(page, 'Guardar orden externo');
  await expect(page.getByRole('heading', { name: 'QA_D elige ahora', exact: true })).toBeVisible();
  await expect(page.getByText('Sorteo externo registrado · Orden inicial: QA_D → QA_B → QA_C')).toBeVisible();
  await page.reload();
  await page.getByLabel('Escenario', { exact: true }).selectOption(s.id);
  await expect(page.getByRole('heading', { name: 'QA_D elige ahora', exact: true })).toBeVisible();
  const saved = await read(request, s.id);
  expect(saved.election.state.tieResolutions[0].order).toEqual([3, 1, 2].map((i) => s.data.members[i].id));
  expect(saved.election.state.tieResolutions[0].method).toBe('external');
  for (const [i, idx] of [3, 1, 2].entries())
    await election(request, s.id, {
      action: 'choose',
      memberId: s.data.members[idx].id,
      dates: [s.data.result.cycles[i + 1].date],
    });
  await election(request, s.id, {
    action: 'choose',
    memberId: s.data.members[0].id,
    dates: [s.data.result.cycles[4].date],
  });
  expect((await read(request, s.id)).election.turn.memberId).toBe(s.data.members[1].id);
  await page.reload();
  await page.getByLabel('Escenario', { exact: true }).selectOption(s.id);
  await expect(
    page.getByText('Empate a 20 puntos · QA_D: 1.º de 3 · Orden de esta ronda: QA_D → QA_B → QA_C'),
  ).toBeVisible();
  expect((await read(request, s.live.id)).campaign).toEqual(s.baseline.campaign);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});

test('sorteo en la app guarda una permutación y no permite repetir', async ({ page, request }) => {
  const s = await setup(request, page);
  const base = await read(request, s.id);
  await post(request, 'campaign/' + s.id, {
    action: 'config',
    version: base.campaign.version,
    config: {
      ...base.config,
      previousScores: { QA_A: 10, QA_B: 10, QA_C: 10, QA_D: 40 },
      previousScoresSource: 'Puntuaciones ficticias para sorteo',
    },
  });
  await election(request, s.id, { action: 'start', rulesConfirmed: true, allowDeferral: true });
  await open(page, s.id);
  await expect(page.getByRole('heading', { name: 'Empate pendiente de sorteo' })).toBeVisible();
  await confirm(page, 'Sortear y guardar orden');
  await expect(page.getByRole('heading', { name: 'Empate pendiente de sorteo' })).toHaveCount(0);
  const saved = await read(request, s.id),
    resolution = saved.election.state.tieResolutions[0];
  expect(resolution.method).toBe('random');
  expect([...resolution.order].sort()).toEqual(
    s.data.members
      .slice(0, 3)
      .map((m: any) => m.id)
      .sort(),
  );
  await page.reload();
  await page.getByLabel('Escenario', { exact: true }).selectOption(s.id);
  await expect(
    page.getByRole('heading', {
      name: saved.members.find((m: any) => m.id === saved.election.turn.memberId).code + ' elige ahora',
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sortear y guardar orden' })).toHaveCount(0);
  expect((await read(request, s.id)).election.state.tieResolutions).toEqual(saved.election.state.tieResolutions);
});

test('sin equipo en URL no se impone C y el administrador puede borrar una simulación', async ({
  page,
  request,
  browser,
}) => {
  const s = await setup(request, page);
  const visitor = await browser.newContext({ baseURL: origin });
  try {
    const anonymous = await visitor.newPage();
    await anonymous.goto('/');
    await expect(anonymous.getByLabel('Equipo', { exact: true })).toHaveValue('');
    await expect(anonymous.getByRole('heading', { name: 'Selecciona un equipo' })).toBeVisible();
    await anonymous.getByLabel('Equipo', { exact: true }).selectOption('B');
    await expect(anonymous.getByLabel('Equipo', { exact: true })).toHaveValue('B');
    await expect(anonymous).toHaveURL(/equipo=B/);
  } finally {
    await visitor.close();
  }
  await page.goto('/?equipo=C&year=2026');
  await expect(page.getByLabel('Escenario', { exact: true })).toBeVisible();
  await page.getByLabel('Escenario', { exact: true }).selectOption(s.id);
  // Wait for the selected scenario to load; do not race its asynchronous campaign fetch.
  await expect(page.getByText('Simulación privada: ' + s.data.campaign.simulation_name, { exact: true })).toBeVisible();
  // Simulation actions are available directly in the header, independent of navigation.
  await expect(page.locator('.scenario-actions summary')).toBeVisible();
  await page.locator('.scenario-actions summary').click();
  await page.getByRole('button', { name: 'Eliminar simulación' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Confirmar' }).click();
  await expect(page.getByLabel('Escenario', { exact: true })).toHaveValue(s.live.id);
  await expect(page.getByRole('status').filter({ hasText: 'Simulación eliminada' })).toBeVisible();
  expect((await request.get('/api/campaign/' + s.id)).status()).toBe(404);
});

test(
  'Por CTA: ordenación de personas y ciclos independiente en móvil y escritorio',
  { tag: '@both' },
  async ({ page, request }) => {
    const s = await setup(request, page),
      members = s.data.members,
      cycles = s.data.result.cycles;
    const dates = [0.7, 0.2, 0.55, 0.05, 0.1].map((part) => cycles[Math.floor(cycles.length * part)].date);
    expect(new Set(dates).size).toBe(5);
    await election(request, s.id, { action: 'start', rulesConfirmed: true, allowDeferral: true });
    for (let i = 0; i < 5; i++)
      await election(request, s.id, { action: 'choose', memberId: members[i % 4].id, dates: [dates[i]] });
    await open(page, s.id);
    await page.getByRole('group', { name: 'Vista del calendario' }).getByRole('button', { name: 'Por CTA' }).click();
    const controls = page.getByRole('group', { name: 'Ordenación de vacaciones por CTA' });
    const memberSelect = controls.getByLabel('Orden de CTA'),
      cycleSelect = controls.getByLabel('Orden de ciclos');
    await expect(memberSelect).toHaveValue('request');
    await expect(cycleSelect).toHaveValue('request');
    const rows = page.locator('.vac2-members-desktop tbody tr');
    const getRows = () =>
      rows.evaluateAll((items) =>
        items.map((row) => ({
          code: row.querySelector('th')?.textContent?.trim() ?? '',
          points: Number(row.querySelector('td:last-child')?.textContent?.trim()),
        })),
      );
    const initial = await getRows();
    expect(initial.map((r) => r.code)).toEqual(members.map((m: any) => m.code));
    const requested = await rows.first().locator('.vac2-date-link').allTextContents();
    await cycleSelect.selectOption('chronological');
    const chronological = await rows.first().locator('.vac2-date-link').allTextContents();
    expect(chronological).toHaveLength(2);
    expect(requested).toEqual([...chronological].reverse());
    await cycleSelect.selectOption('request');
    expect(await rows.first().locator('.vac2-date-link').allTextContents()).toEqual([...chronological].reverse());
    expect((await getRows()).map((r) => r.code)).toEqual(initial.map((r) => r.code));
    await memberSelect.selectOption('points');
    expect((await getRows()).map((r) => r.code)).toEqual(
      [...initial].sort((a, b) => a.points - b.points || initial.indexOf(a) - initial.indexOf(b)).map((r) => r.code),
    );
    await cycleSelect.selectOption('chronological');
    await expect(memberSelect).toHaveValue('points');
    if ((page.viewportSize()?.width ?? 1280) <= 900) {
      await expect(page.locator('.vac2-member-card')).toHaveCount(members.length);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
    }
  },
);

test('vista de controlador: en su turno, «Tu lista ahora» muestra puntos y plazas de cada preferencia', async ({
  page,
  request,
}) => {
  const s = await setup(request, page);
  await open(page, s.id);
  await activate(page);
  const cycles = s.data.result.cycles,
    dates = [cycles[3].date, cycles[9].date];
  await election(request, s.id, {
    action: 'preferences',
    memberId: s.data.members[0].id,
    dates,
    persistent: false,
    mode: 'manual',
    waitMinutes: 0,
  });
  const url = new URL(page.url());
  url.searchParams.set('verComo', 'QA_A');
  await page.goto(url.toString());
  const list = page.getByRole('region', { name: 'Mi elección' }).locator('.my-election-now');
  await expect(list.locator('li')).toHaveCount(2);
  for (const [i, date] of dates.entries()) {
    const score = cycles.find((c: { date: string; score: number }) => c.date === date).score;
    await expect(list.locator('li').nth(i)).toContainText(
      new RegExp(score + ' pt · Disponible · (quedan? \\d+ plazas?|plazas por confirmar)'),
    );
  }
});

test('vista de tabla: A+ y A− cambian el tamaño de la letra', async ({ page, request }) => {
  const s = await setup(request, page);
  await open(page, s.id);
  await activate(page);
  await page
    .getByRole('group', { name: 'Vista del calendario' })
    .getByRole('button', { name: 'Tabla', exact: true })
    .click();
  const cell = page.locator('.vac3-table td').first();
  const size = async () => parseFloat(await cell.evaluate((el) => getComputedStyle(el).fontSize));
  const before = await size();
  await page.getByRole('button', { name: 'Ampliar letra de la tabla' }).click();
  await page.getByRole('button', { name: 'Ampliar letra de la tabla' }).click();
  await expect.poll(size).toBe(before + 2);
  await page.getByRole('button', { name: 'Reducir letra de la tabla' }).click();
  await expect.poll(size).toBe(before + 1);
});

test('estadísticas: solo con sesión, una tarjeta por equipo y nada para anónimos', async ({
  page,
  request,
  browser,
}) => {
  await setup(request, page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Estadísticas' }).first().click();
  await expect(page.getByRole('heading', { name: /Estado de las campañas/ })).toBeVisible();
  await expect(page.locator('.stats-team').first()).toBeVisible();
  const anonymous = await browser.newContext();
  const response = await anonymous.request.get(origin + '/api/stats');
  expect(response.status()).toBe(401);
  await anonymous.close();
});
