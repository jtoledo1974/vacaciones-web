import { test, expect } from '@playwright/test';

const origin = 'http://127.0.0.1:5199';

/** Loads a one-person VA campaign, so it restores the shared fixture like zz-va-common-admin. */
test(
  'el calendario de VA bloquea a la vista las vacaciones ordinarias y los días libres del turnero',
  { tag: '@both' },
  async ({ page, request }) => {
    const post = (path: string, data: unknown) => request.post('/api/' + path, { data, headers: { Origin: origin } });
    await request.get('/signin-with-chatgpt?return_to=/');
    if (!(await (await request.get('/api/index')).json()).campaigns.length)
      expect((await post('initialize', {})).ok()).toBeTruthy();
    const backup = await (await request.get('/api/backup')).json();
    try {
      const census = await (await request.get('/api/va/census')).json();
      const year = census.year;
      const person = census.people.find((p: { status: string }) => p.status === 'entitled');
      if (!person.controllerNumber) {
        const entries = [{ personId: person.personId, date: person.seniority, employeeNumber: 7001, page: 1 }];
        const source = { title: 'Fichas E2E', asOf: '2026-01-05', sha256: 'e'.repeat(64) };
        const { reviewToken } = await (await post('people/seniority', { action: 'preview', entries, source })).json();
        expect((await post('people/seniority', { action: 'apply', entries, source, reviewToken })).ok()).toBeTruthy();
      }
      const days = Object.fromEntries(
        Array.from({ length: 31 }, (_, i) => [`${year}-01-${String(i + 1).padStart(2, '0')}`, 2]),
      );
      const quotas = {
        year,
        days,
        source: { title: 'Cupos E2E', sha256: 'c'.repeat(64), receivedAt: `${year}-01-01` },
      };
      const { reviewToken: quotaToken } = await (await post('va/quotas', { ...quotas, action: 'preview' })).json();
      const applied = await post('va/quotas', { ...quotas, action: 'apply', reviewToken: quotaToken });
      expect(applied.ok(), await applied.text()).toBeTruthy();
      const body = { people: [person.personId], source: { title: 'Censo E2E', sha256: 'd'.repeat(64) } };
      const { reviewToken } = await (await post(`va/campaign/${year}`, { ...body, action: 'preview' })).json();
      expect((await post(`va/campaign/${year}`, { ...body, action: 'apply', reviewToken })).ok()).toBeTruthy();

      const index = await (await request.get('/api/index')).json();
      const ordinaryId = index.campaigns.find(
        (c: { team_id: string; year: number }) => c.team_id === person.code[0] && c.year === year,
      ).id;
      const ordinary = await (await request.get('/api/campaign/' + ordinaryId)).json();
      const holder = ordinary.members.find((m: { code: string }) => m.code === person.code);
      const cycle = ordinary.result.cycles[0];
      const requested = await post('campaign/' + ordinaryId, {
        action: 'request',
        version: ordinary.campaign.version,
        memberId: holder.id,
        slot: 1,
        date: cycle.date,
      });
      expect(requested.ok(), await requested.text()).toBeTruthy();
      const awarded = await post('campaign/' + ordinaryId, {
        action: 'award',
        version: (await requested.json()).campaign.version,
        memberId: holder.id,
        date: cycle.date,
      });
      expect(awarded.ok(), await awarded.text()).toBeTruthy();

      const cid = index.vaCampaign.id;
      const view = await (await request.get('/api/campaign/' + cid)).json();
      const member = view.members.find((m: { code: string }) => m.code === person.code);
      const onVacation: string = view.daysOff[member.id].ordinary[0];
      const free: string = view.daysOff[member.id].rest.find(
        (d: string) => d in days && !view.daysOff[member.id].ordinary.includes(d),
      );
      const working = Object.keys(days).find(
        (d) => !view.daysOff[member.id].rest.includes(d) && !view.daysOff[member.id].ordinary.includes(d),
      )!;

      await page.context().addCookies((await request.storageState()).cookies);
      await page.goto('/antiguedad?verComo=' + encodeURIComponent(person.code));
      const calendarView = page.getByRole('button', { name: 'Meses', exact: false }).first();
      if (await calendarView.isVisible().catch(() => false)) await calendarView.click();
      const lockedDay = page.locator(`.vac2-calendar .vac2-locked-rest[data-cycle-date="${free}"]`);
      await expect(lockedDay).toBeVisible();
      await expect(lockedDay).toHaveAttribute('aria-label', /Libre por turnero, no se puede elegir/);
      await expect(lockedDay).toHaveCSS('background-color', 'rgb(174, 181, 185)');
      const vacationDay = page.locator(`.vac2-calendar .vac2-locked-ordinary[data-cycle-date="${onVacation}"]`);
      await expect(vacationDay).toHaveCSS('background-color', 'rgb(104, 185, 232)');
      await expect(page.locator(`.vac2-calendar button[data-cycle-date="${working}"]`)).toBeEnabled();
      if (process.env.VA_SHOTS)
        await page
          .locator('.vac2-calendar')
          .screenshot({ path: `${process.env.VA_SHOTS}/months-${test.info().project.name}.png` });

      await page.getByRole('button', { name: 'Tabla', exact: false }).first().click();
      const row = page.locator(`.vac3-table tr.vac3-locked-rest[data-cycle-date="${free}"]`);
      await expect(row).toContainText('Libre');
      await expect(row.locator('button')).toBeDisabled();
      await expect(page.locator(`.vac3-table tr[data-cycle-date="${working}"] button`)).toBeEnabled();
      if (process.env.VA_SHOTS)
        await page
          .locator('.vac3')
          .screenshot({ path: `${process.env.VA_SHOTS}/table-${test.info().project.name}.png` });
    } finally {
      const current = await (await request.get('/api/backup')).json();
      const restored = await post('restore', { backup, revision: current.payload.revision });
      expect(restored.ok(), await restored.text()).toBeTruthy();
    }
  },
);
