import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importRoster } from './import-helper.ts';
import { SQLiteRepo } from './sqlite-repo.ts';
import { Service } from '../server/service.ts';
import { VA_TEAM } from '../server/teams.ts';
import { loadVaCampaign } from '../server/va-campaign.ts';
import { defaultConfig } from '../domain/defaults.ts';
import type { Principal } from '../server/permissions.ts';

const owner: Principal = { id: 'chatgpt:owner', role: 'superadmin', teams: [] };
const va: Principal = { id: 'chatgpt:va', role: 'team_admin', teams: [VA_TEAM] };
const source = { title: 'Censo VA 2026 de RRHH', sha256: 'b'.repeat(64) };

/** Team C in 2026: AA and BB entitled to VA (3 and 2 days), CC not yet. */
async function setup() {
  const repo = new SQLiteRepo(),
    s = new Service(repo, owner);
  await s.init();
  const cid = (await s.list()).campaigns.find((c: { team_id: string }) => c.team_id === 'C').id;
  const d = await s.view(cid);
  await importRoster(s, cid, {
    action: 'import_roster',
    version: d.campaign.version,
    source: {
      format: 'vacaciones-roster-v1',
      team: 'C',
      year: 2026,
      copySelections: false,
      rows: [
        { code: 'AA', label: 'CTA AA', seniority: '1996-02-01' },
        { code: 'BB', label: 'CTA BB', seniority: '2001-05-01' },
        { code: 'CC', label: 'CTA CC', seniority: '2016-01-01' },
      ],
    },
  });
  const people = Object.fromEntries(
    (await s.load(cid)).members.map((m: { code: string; person_id: string }) => [m.code, m.person_id]),
  );
  const service = new Service(repo, va);
  const load = async (ids: string[]) => {
    const body = { action: 'preview', people: ids, source };
    const preview = await loadVaCampaign(service, repo, va, 2026, body);
    return loadVaCampaign(service, repo, va, 2026, { ...body, action: 'apply', reviewToken: preview.reviewToken });
  };
  return { repo, s, service, people, load };
}

test('el censo de RRHH da de alta la campaña de VA con sus días congelados y en su orden', async () => {
  const { repo, s, people, load } = await setup();
  // HR's order, not the team roster's.
  const result = await load([people.BB, people.AA]);
  const campaign = (await repo.all('SELECT * FROM campaigns WHERE id=?', [result.campaignId]))[0];
  assert.deepEqual([campaign.team_id, campaign.year, campaign.scope_key], [VA_TEAM, 2026, 'live']);
  const d = await s.load(result.campaignId);
  assert.deepEqual(
    d.members.map((m: { code: string; entitlement: number; position: number }) => [m.code, m.entitlement, m.position]),
    [
      ['BB', 2, 0],
      ['AA', 3, 1],
    ],
  );
  assert.deepEqual(d.config, defaultConfig(2026), 'VA ignora la configuración; se guarda la del año');
  assert.ok(!(await s.list()).teams.some((t: { id: string }) => t.id === VA_TEAM), 'no aparece entre los equipos');
});

test('el censo se puede volver a cargar hasta iniciar la campaña; después queda fijo', async () => {
  const { repo, s, people, load } = await setup();
  const first = await load([people.AA]);
  const again = await load([people.AA, people.BB]);
  assert.equal(again.campaignId, first.campaignId, 'una sola campaña de VA por año');
  assert.equal((await s.load(first.campaignId)).members.length, 2);
  await repo.batch([
    { sql: 'INSERT INTO va_quotas(year,date,places) VALUES(2026,?,5)', args: ['2026-03-02'] },
    { sql: 'INSERT INTO va_quotas(year,date,places) VALUES(2026,?,5)', args: ['2026-03-03'] },
  ]);
  const v = await s.view(first.campaignId);
  await s.election().mutate(first.campaignId, {
    action: 'start',
    order: v.members.map((m: { id: string }) => m.id),
    source: 'Orden del censo de RRHH',
    rulesConfirmed: true,
    allowDeferral: true,
    version: v.campaign.version,
  });
  await assert.rejects(load([people.AA]), /ya se ha iniciado/);
});

test('el censo rechaza a quien no tiene derecho y una vista previa caducada', async () => {
  const { repo, service, people } = await setup();
  const body = { action: 'preview', people: [people.AA, people.CC], source };
  await assert.rejects(loadVaCampaign(service, repo, va, 2026, body), /sin derecho/);
  const preview = await loadVaCampaign(service, repo, va, 2026, { ...body, people: [people.AA] });
  assert.deepEqual(
    preview.omitted.filter((p: { team: string }) => p.team === 'C').map((p: { code: string }) => p.code),
    ['BB'],
    'avisa de quien tiene derecho y no está',
  );
  // The master record changes after the preview: the review no longer applies.
  await repo.batch([{ sql: "UPDATE people SET seniority='1990-01-01' WHERE id=?", args: [people.AA] }]);
  await assert.rejects(
    loadVaCampaign(service, repo, va, 2026, {
      ...body,
      people: [people.AA],
      action: 'apply',
      reviewToken: preview.reviewToken,
    }),
    /Revisa de nuevo/,
  );
  await assert.rejects(
    loadVaCampaign(service, repo, { id: 'x', role: 'team_admin', teams: ['C'] }, 2026, body),
    /administrador de VA/,
  );
});

test('la plantilla de RRHH de VA convive con la de ordinarias del mismo año', async () => {
  const { repo } = await setup();
  const insert = (kind: string) => ({
    sql: 'INSERT INTO hr_templates(year,kind,data,sha256,uploaded_by,uploaded_at) VALUES(2026,?,?,?,?,?)',
    args: [kind, 'eA==', kind, 'admin', '2026-01-01'],
  });
  await repo.batch([insert('ordinary'), insert('va')]);
  assert.deepEqual(
    (await repo.all('SELECT kind FROM hr_templates WHERE year=2026 ORDER BY kind')).map((r) => r.kind),
    ['ordinary', 'va'],
  );
  await assert.rejects(repo.batch([insert('va')]), /UNIQUE|PRIMARY/);
});
