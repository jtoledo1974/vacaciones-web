import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteRepo } from './sqlite-repo.ts';
import { Service } from '../server/service.ts';
import { yearSummary } from '../server/year-summary.ts';
import { calendar } from '../domain/calendar.ts';
import { availabilityBand } from '../app/year-summary-bands.ts';
import type { Principal } from '../server/permissions.ts';

const superadmin: Principal = { id: 'test-admin', role: 'superadmin', teams: [] };
const exec = (repo: SQLiteRepo, sql: string, args: unknown[] = []) => repo.batch([{ sql, args }]);

/** The demo team A, promoted to real data for 2026. */
async function setup() {
  const repo = new SQLiteRepo();
  await new Service(repo, superadmin).init();
  const [campaign] = await repo.all("SELECT * FROM campaigns WHERE team_id='A' AND year=2026");
  await exec(repo, "UPDATE campaigns SET data_kind='configured',status='closed' WHERE id=?", [campaign.id]);
  const [params] = await repo.all('SELECT json FROM parameters WHERE campaign_id=?', [campaign.id]);
  const members = await repo.all('SELECT * FROM campaign_members WHERE campaign_id=? ORDER BY position', [campaign.id]);
  const cycles = calendar(2026, 'A', JSON.parse(params.json));
  return { repo, campaign, members, cycles };
}
const award = (repo: SQLiteRepo, campaign: string, member: string, date: string) =>
  exec(repo, 'INSERT INTO awards(id,campaign_id,member_id,cycle_date,version) VALUES(?,?,?,?,1)', [
    crypto.randomUUID(),
    campaign,
    member,
    date,
  ]);

test('cuenta cada día del ciclo y resta de la plantilla', async () => {
  const { repo, campaign, members, cycles } = await setup();
  const cycle = cycles[5];
  await award(repo, campaign.id, members[0].id, cycle.date);
  await award(repo, campaign.id, members[1].id, cycle.date);
  const summary = await yearSummary(repo, superadmin, null);
  assert.equal(summary.year, 2026);
  assert.equal(summary.staff, members.length);
  assert.equal(summary.days.length, 365);
  const day = (date: string) => summary.days.find((d) => d.date === date)!;
  assert.deepEqual(
    { ...day(cycle.date), date: '' },
    { date: '', vacation: 2, va: 0, available: members.length - 2, incomplete: false },
  );
  assert.equal(day(cycle.end).vacation, 2);
  assert.equal(day(cycles[6].date).vacation, 0);
  assert.ok(summary.missingTeams.includes('B'), 'los equipos de demo quedan fuera');
});

test('los días antes del primer ciclo sin campaña anterior quedan incompletos', async () => {
  const { repo, cycles } = await setup();
  const summary = await yearSummary(repo, superadmin, 2026);
  for (const d of summary.days) assert.equal(d.incomplete, d.date < cycles[0].date, d.date);
});

test('una persona solo del censo de VA cuenta como VA pero no resta disponibles', async () => {
  const { repo, campaign, members, cycles } = await setup();
  const [params] = await repo.all('SELECT json FROM parameters WHERE campaign_id=?', [campaign.id]);
  await exec(repo, "INSERT OR IGNORE INTO teams(id,name,version,kind) VALUES('va','VA',1,'va')");
  const va = crypto.randomUUID();
  await exec(
    repo,
    "INSERT INTO campaigns(id,team_id,year,status,version,data_kind,scope_key,simulation_name,created_at) VALUES(?,'va',2026,'open',1,'real','live','',?)",
    [va, new Date().toISOString()],
  );
  await exec(repo, 'INSERT INTO parameters(campaign_id,json) VALUES(?,?)', [va, params.json]);
  const addVaMember = async (id: string, person: string, code: string, position: number) =>
    exec(
      repo,
      "INSERT INTO campaign_members(id,campaign_id,person_id,code,label,position,seniority,version) VALUES(?,?,?,?,?,?,'2000-01-01',1)",
      [id, va, person, code, '', position],
    );
  const [outsider] = await repo.all("SELECT id FROM people WHERE team_id='B' LIMIT 1");
  await addVaMember('va-in', members[0].person_id, 'IN', 0);
  await addVaMember('va-out', outsider.id, 'OUT', 1);
  const date = cycles[5].date;
  await award(repo, va, 'va-in', date);
  await award(repo, va, 'va-out', date);
  const summary = await yearSummary(repo, superadmin, 2026);
  const day = summary.days.find((d) => d.date === date)!;
  assert.equal(day.va, 2);
  assert.equal(day.available, members.length - 1);
  assert.equal(summary.vaOpen, true);
});

test('solo superadministradores; año sin campañas reales rechazado', async () => {
  const { repo } = await setup();
  await assert.rejects(yearSummary(repo, { id: 'x', role: 'team_admin', teams: ['A'] }, null));
  await assert.rejects(yearSummary(repo, superadmin, 2030), /año/);
});

test('tramos de color', () => {
  assert.deepEqual([0, 130, 131, 136, 137, 145, 146, 159].map(availabilityBand), [0, 0, 1, 2, 3, 5, 6, 6]);
});
