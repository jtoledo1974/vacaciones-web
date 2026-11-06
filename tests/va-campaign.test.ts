import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importRoster } from './import-helper.ts';
import { SQLiteRepo } from './sqlite-repo.ts';
import { Service } from '../server/service.ts';
import { VA_TEAM } from '../server/teams.ts';
import { loadVaCampaign } from '../server/va-campaign.ts';
import { defaultConfig } from '../domain/defaults.ts';
import { singleDays } from '../app/unit-words.ts';
import { personCalendar } from '../server/person-calendar.ts';
import { myVa } from '../server/va-census.ts';
import { renderPersonCalendarPdf } from '../server/individual-calendar-pdf.ts';
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
  // Validated master records: employee numbers in HR's order.
  await repo.batch(
    ['AA', 'BB', 'CC'].map((code, i) => ({
      sql: 'UPDATE people SET controller_number=? WHERE id=?',
      args: [9000 + i, people[code]],
    })),
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
  const start = async () => {
    const v = await s.view(first.campaignId);
    return s.election().mutate(first.campaignId, {
      action: 'start',
      order: v.members.map((m: { id: string }) => m.id),
      source: 'Orden del censo de RRHH',
      rulesConfirmed: true,
      allowDeferral: true,
      version: v.campaign.version,
    });
  };
  // Without HR's quotas it cannot start: afterwards they could no longer be loaded.
  await assert.rejects(start(), /Carga los cupos de RRHH/);
  assert.equal((await repo.all('SELECT 1 FROM election_states WHERE campaign_id=?', [first.campaignId])).length, 0);
  await repo.batch([
    { sql: 'INSERT INTO va_quotas(year,date,places) VALUES(2026,?,5)', args: ['2026-03-02'] },
    { sql: 'INSERT INTO va_quotas(year,date,places) VALUES(2026,?,5)', args: ['2026-03-03'] },
  ]);
  await start();
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

test('el censo exige número de empleado, avisa del orden descendente y no congela datos cambiados entretanto', async () => {
  const { repo, service, people, load } = await setup();
  const body = { action: 'preview', people: [people.BB, people.AA], source };
  const preview = await loadVaCampaign(service, repo, va, 2026, body);
  assert.deepEqual(preview.warnings, ['AA no sigue el número de empleado ascendente']);
  await repo.batch([{ sql: 'UPDATE people SET controller_number=NULL WHERE id=?', args: [people.AA] }]);
  await assert.rejects(loadVaCampaign(service, repo, va, 2026, body), /sin datos validados/);
  await repo.batch([{ sql: 'UPDATE people SET controller_number=9100 WHERE id=?', args: [people.AA] }]);
  // A write between the apply's reads and its batch (here, right before the commit) is refused.
  const ok = await loadVaCampaign(service, repo, va, 2026, body);
  const commit = service.commit.bind(service);
  service.commit = async (ops) => {
    await repo.batch([{ sql: "UPDATE app_state SET revision=revision+1 WHERE id='main'" }]);
    return commit(ops);
  };
  await assert.rejects(
    loadVaCampaign(service, repo, va, 2026, { ...body, action: 'apply', reviewToken: ok.reviewToken }),
    /actualizado|Recarga/,
  );
  service.commit = commit;
  assert.ok((await load([people.AA])).applied);
});

test('la campaña de VA se abre solo para su administración y sus participantes', async () => {
  const { repo, s, people, load } = await setup();
  const { campaignId } = await load([people.AA]);
  const as = (id: string, emailKey?: string) =>
    new Service(repo, { id, role: 'viewer', teams: [], ...(emailKey ? { emailKey } : {}) });
  await repo.batch([
    {
      sql: 'INSERT INTO controller_accounts(person_id,principal_key,version) VALUES(?,?,1)',
      args: [people.AA, 'chatgpt-email:aa@x.test'],
    },
  ]);
  const participant = as('chatgpt:aa', 'chatgpt-email:aa@x.test'),
    other = as('chatgpt:zz', 'chatgpt-email:zz@x.test');
  assert.equal((await participant.list()).vaCampaign?.id, campaignId);
  assert.equal((await participant.view(campaignId)).campaign.id, campaignId);
  assert.equal((await other.list()).vaCampaign, null);
  await assert.rejects(other.view(campaignId), /cuenta participante/);
  assert.equal((await s.list()).vaCampaign?.id, campaignId, 'la administración la ve siempre');
  // Every read path, not only the view.
  const anonymous = as('');
  for (const reader of [other, anonymous]) {
    await assert.rejects(reader.election().availability(campaignId), /cuenta participante/);
    await assert.rejects(reader.publishedView(campaignId), /cuenta participante/);
  }
  await participant.election().availability(campaignId);
});

test('el participante de VA sin permisos recibe solo su propio derecho, no el de los demás', async () => {
  const { repo, people, load } = await setup();
  const { campaignId } = await load([people.AA, people.BB]);
  await repo.batch([
    {
      sql: 'INSERT INTO controller_accounts(person_id,principal_key,version) VALUES(?,?,1)',
      args: [people.BB, 'chatgpt-email:bb@x.test'],
    },
  ]);
  const participant = new Service(repo, {
    id: 'chatgpt:bb',
    role: 'viewer',
    teams: [],
    emailKey: 'chatgpt-email:bb@x.test',
  });
  const view = await participant.view(campaignId);
  assert.equal(view.editable, false, 'recibe la proyección pública');
  assert.equal(view.config, null);
  assert.equal(view.election.myEntitlement, 2, 'sus días de VA, no los seis ciclos de ordinarias');
  for (const member of view.members) assert.deepEqual(Object.keys(member).sort(), ['code', 'id']);
});

test('recargar el censo en preparación descarta las solicitudes de los miembros anteriores', async () => {
  const { repo, s, people, load } = await setup();
  const { campaignId } = await load([people.AA, people.BB]);
  await repo.batch([{ sql: 'INSERT INTO va_quotas(year,date,places) VALUES(2026,?,5)', args: ['2026-03-02'] }]);
  const d = await s.load(campaignId);
  await s.mutate(campaignId, {
    action: 'request',
    version: d.campaign.version,
    memberId: d.members[0].id,
    slot: 1,
    date: '2026-03-02',
  });
  assert.equal((await repo.all('SELECT 1 FROM requests WHERE campaign_id=?', [campaignId])).length, 1);
  await load([people.BB]);
  const after = await s.load(campaignId);
  assert.deepEqual(
    after.members.map((m: { code: string }) => m.code),
    ['BB'],
  );
  assert.equal(after.requests.length, 0);
});

test('el calendario individual reúne las vacaciones ordinarias y las de VA de la persona', async () => {
  const { repo, s, people, load } = await setup();
  const { campaignId } = await load([people.AA]);
  const ordinary = (await s.list()).campaigns.find((c: { team_id: string }) => c.team_id === 'C').id;
  const o = await s.load(ordinary),
    v = await s.load(campaignId);
  const cycle = (await s.view(ordinary)).result.cycles[0];
  const award = (cid: string, member: string, date: string) => ({
    sql: 'INSERT INTO awards(id,campaign_id,member_id,cycle_date,version) VALUES(?,?,?,?,1)',
    args: [crypto.randomUUID(), cid, member, date],
  });
  await repo.batch([
    { sql: 'INSERT INTO va_quotas(year,date,places) VALUES(2026,?,3)', args: ['2026-11-20'] },
    award(ordinary, o.members.find((m: { code: string }) => m.code === 'AA').id, cycle.date),
    award(campaignId, v.members[0].id, '2026-11-20'),
  ]);
  const span = [{ date: cycle.date, end: cycle.end }],
    day = [{ date: '2026-11-20', end: '2026-11-20' }];
  // From either campaign, the same year: rotation and holidays of team C, both kinds of days.
  for (const cid of [campaignId, ordinary]) {
    const person = await personCalendar(s, repo, cid, 'AA');
    assert.deepEqual([person.team, person.ordinary, person.va], ['C', span, day]);
    assert.ok(renderPersonCalendarPdf(person).startsWith('%PDF'));
  }
  // A simulation shows itself alone, never the real VA days.
  const sim = await s.createSimulation(ordinary, {
    name: 'Escenario',
    version: (await s.load(ordinary)).campaign.version,
  });
  assert.deepEqual((await personCalendar(s, repo, sim.id, 'AA')).va, []);
  // A failure other than a refusal fails the PDF instead of leaving the VA days out.
  const view = s.view.bind(s);
  s.view = async (cid, options) => {
    if (cid === campaignId) throw new Error('D1 caído');
    return view(cid, options);
  };
  await assert.rejects(personCalendar(s, repo, ordinary, 'AA'), /D1 caído/);
  s.view = view;
  // Anyone who may not read VA gets the ordinary calendar alone.
  const anonymous = new Service(repo, { id: '', role: 'viewer', teams: [] });
  assert.deepEqual((await personCalendar(anonymous, repo, ordinary, 'AA')).va, []);
});

test('sin cupos cargados, la vista de VA ya habla de días: la unidad viene de la política', async () => {
  const { s, people, load } = await setup();
  const { campaignId } = await load([people.AA]);
  const v = await s.view(campaignId);
  assert.deepEqual(v.result.cycles, []);
  assert.ok(singleDays(v.election.policyPresentation));
});

test('una escritura de ordinarias no puede dejar a la persona con un día ya concedido en VA (§3 bis)', async () => {
  const { repo, s, people, load } = await setup();
  const { campaignId } = await load([people.AA]);
  const ordinary = (await s.list()).campaigns.find((c: { team_id: string }) => c.team_id === 'C').id;
  const o = await s.load(ordinary),
    v = await s.load(campaignId);
  const member = (code: string) => o.members.find((m: { code: string }) => m.code === code).id;
  const cycles = (await s.view(ordinary)).result.cycles as { date: string; end: string }[];
  const award = (cid: string, memberId: string, date: string) => ({
    sql: 'INSERT INTO awards(id,campaign_id,member_id,cycle_date,version) VALUES(?,?,?,?,1)',
    args: [crypto.randomUUID(), cid, memberId, date],
  });
  const cycle = cycles.find((c) => c.date.startsWith('2026-11'))!;
  await repo.batch([
    { sql: 'INSERT INTO va_quotas(year,date,places) VALUES(2026,?,3)', args: [cycle.end] },
    award(campaignId, v.members[0].id, cycle.end),
  ]);
  // The ordinary cycle that contains AA's VA day is refused for AA, in the same transaction.
  await assert.rejects(s.commit([award(ordinary, member('AA'), cycle.date)]), /mismo día/);
  assert.equal((await repo.all('SELECT 1 FROM awards WHERE campaign_id=?', [ordinary])).length, 0);
  // Another person, or another cycle, is not affected.
  await s.commit([award(ordinary, member('BB'), cycle.date)]);
  await s.commit([award(ordinary, member('AA'), cycles[0].date)]);

  // December→January: the last ordinary cycle of 2026 ends in 2027 and meets VA of 2027.
  const last = cycles.at(-1)!;
  assert.ok(last.end.startsWith('2027-'), 'el último ciclo acaba en enero');
  await repo.batch([
    {
      sql: "INSERT INTO campaigns(id,team_id,year,status,version,data_kind,created_at) VALUES('va27','va',2027,'open',1,'real','2026-12-01')",
    },
    {
      sql: 'INSERT INTO parameters(campaign_id,json,version) SELECT ?,json,1 FROM parameters WHERE campaign_id=?',
      args: ['va27', campaignId],
    },
    {
      sql: "INSERT INTO campaign_members(id,campaign_id,person_id,code,label,seniority,position,entitlement,version) VALUES('va27-aa','va27',?,'AA','CTA AA','1996-02-01',0,3,1)",
      args: [people.AA],
    },
    { sql: 'INSERT INTO va_quotas(year,date,places) VALUES(2027,?,3)', args: [last.end] },
    award('va27', 'va27-aa', last.end),
  ]);
  await assert.rejects(s.commit([award(ordinary, member('AA'), last.date)]), /mismo día/);
});

test('myVa conserva los días congelados de la campaña aunque cambie o se desactive la ficha maestra', async () => {
  const { repo, people, load } = await setup();
  await load([people.AA, people.BB]);
  const before = await myVa(repo, owner, { team: 'C', code: 'AA' });
  assert.equal(before.me?.days, 3);
  // Newer seniority (would give 0 days) and an inactive record: the frozen entitlement rules.
  await repo.batch([{ sql: "UPDATE people SET seniority='2020-01-01',active=0 WHERE id=?", args: [people.AA] }]);
  const after = await myVa(repo, owner, { team: 'C', code: 'AA' });
  assert.deepEqual([after.me?.days, after.me?.status, after.me?.seniority], [3, 'entitled', '1996-02-01']);
  // Outside the campaign there is no entitlement, even with one in the master records.
  assert.equal((await myVa(repo, owner, { team: 'C', code: 'CC' })).me, null);
});

test('la migración 0026 no se aplica mientras quede una elección de VA antigua', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { readdirSync, readFileSync } = await import('node:fs');
  const db = new DatabaseSync(':memory:');
  const files = readdirSync('drizzle')
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const f of files.filter((f) => f < '0026')) db.exec(readFileSync('drizzle/' + f, 'utf8'));
  db.exec(`INSERT INTO va_campaigns(year,version,json) VALUES(2026,1,'{"people":[]}')`);
  const migration = readFileSync('drizzle/' + files.find((f) => f.startsWith('0026'))!, 'utf8');
  assert.throws(() => db.exec('BEGIN;' + migration + ';COMMIT;'), /old_va_election_still_present|CHECK/);
  db.exec('ROLLBACK');
  assert.equal((db.prepare('SELECT count(*) AS n FROM va_campaigns').get() as { n: number }).n, 1);
  db.exec('DELETE FROM va_campaigns');
  db.exec(migration);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='va_campaigns'").all().length, 0);
});
