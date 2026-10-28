import { test } from 'node:test';
import { importRoster } from './import-helper.ts';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { Service } from '../server/service.ts';
import type { Repository, Statement } from '../server/repository.ts';
import { orderAwardsBySelection } from '../domain/award-display-order.ts';
class Repo implements Repository {
  db = new DatabaseSync(':memory:');
  constructor() {
    this.db.exec('PRAGMA foreign_keys=ON');
    for (const f of readdirSync('drizzle')
      .filter((f) => f.endsWith('.sql'))
      .sort())
      this.db.exec(readFileSync('drizzle/' + f, 'utf8'));
  }
  async all<T = any>(sql: string, args: any[] = []): Promise<T[]> {
    return this.db.prepare(sql).all(...args) as T[];
  }
  async batch(ss: Statement[]) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const results = ss.map((s) => {
        const q = this.db.prepare(s.sql);
        return {
          results: q.columns().length ? q.all(...((s.args ?? []) as any[])) : (q.run(...((s.args ?? []) as any[])), []),
        };
      });
      this.db.exec('COMMIT');
      return results;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
}
const owner = { id: 'chatgpt:owner', role: 'superadmin' as const, teams: [] };

test('imported cycle columns survive reversed SQL scans for admin and public readers', async () => {
  const repo = new Repo(),
    s = new Service(repo, owner);
  await s.init();
  const cid = (await s.list()).campaigns.find((c) => c.team_id === 'C' && c.year === 2026).id;
  const before = await s.view(cid);
  const cycles = before.result.cycles;
  const dates = [cycles.at(-3)!.date, cycles[0].date, cycles[8].date];
  const source = {
    format: 'vacaciones-roster-v1',
    team: 'C',
    year: 2026,
    copySelections: true,
    selectionOrder: [
      { round: 1, code: 'PRIMERO', date: dates[0] },
      { round: 1, code: 'SEGUNDO', date: dates[2] },
      { round: 2, code: 'PRIMERO', date: dates[1] },
      { round: 2, code: 'SEGUNDO', date: dates[1] },
      { round: 3, code: 'PRIMERO', date: dates[2] },
    ],
    rows: [
      { code: 'PRIMERO', label: 'Prueba uno', seniority: '', dates },
      { code: 'SEGUNDO', label: 'Prueba dos', seniority: '', dates: [dates[2], dates[1]] },
    ],
  };
  const review = await s.mutate(cid, { action: 'preview_import_roster', version: before.campaign.version, source });
  await importRoster(s, cid, {
    action: 'import_roster',
    version: before.campaign.version,
    source,
    reviewToken: review.reviewToken,
    acceptViolations: true,
  });
  // No chronology exists for this import. Deliberately change row insertion
  // order and reverse unordered scans, as a D1 index/restore can do in production.
  const raw = await repo.all('SELECT * FROM awards WHERE campaign_id=?', [cid]);
  await repo.batch([
    {
      sql: `INSERT INTO requests(id,campaign_id,member_id,slot,cycle_date,version)
      SELECT 'duplicate-request',campaign_id,member_id,6,cycle_date,1
      FROM requests WHERE campaign_id=? AND slot=1 LIMIT 1`,
      args: [cid],
    },
    { sql: 'DELETE FROM awards WHERE campaign_id=?', args: [cid] },
    ...raw.reverse().map((a) => ({
      sql: 'INSERT INTO awards(id,campaign_id,member_id,cycle_date,version,selection_index,selection_round) VALUES(?,?,?,?,?,?,?)',
      args: [a.id, a.campaign_id, a.member_id, a.cycle_date, a.version, a.selection_index, a.selection_round],
    })),
  ]);
  repo.db.exec('PRAGMA reverse_unordered_selects=ON');
  for (const reader of [s, new Service(repo, { id: null, role: 'viewer', teams: [] })]) {
    const view = await reader.view(cid);
    const awards = orderAwardsBySelection(view.awards, view.election.timeline);
    for (const row of source.rows) {
      const member = view.members.find((m) => m.code === row.code)!;
      assert.deepEqual(
        awards.filter((a) => a.member_id === member.id).map((a) => a.cycle_date),
        row.dates,
      );
    }
    assert.deepEqual(
      awards.filter((a) => a.cycle_date === dates[2]).map((a) => view.members.find((m) => m.id === a.member_id)!.code),
      ['SEGUNDO', 'PRIMERO'],
      'occupants follow the selection sequence: round 1 before round 3, regardless of roster position',
    );
    assert.equal(awards.length, 5, 'joins must neither duplicate nor lose awards');
  }
  await repo.batch([
    { sql: 'UPDATE awards SET selection_index=NULL,selection_round=NULL WHERE campaign_id=?', args: [cid] },
  ]);
  const legacy = await s.view(cid);
  assert.equal(legacy.awards.length, 5, 'duplicate restored requests do not duplicate legacy awards either');
  for (const row of source.rows) {
    const member = legacy.members.find((m) => m.code === row.code)!;
    assert.deepEqual(
      legacy.awards.filter((a) => a.member_id === member.id).map((a) => a.cycle_date),
      row.dates,
    );
  }
});
test('retirar trabajador conserva el ejercicio anterior y no lo copia a futuros', async () => {
  const repo = new Repo(),
    s = new Service(repo, owner);
  await s.init();
  await s.createCampaigns(2027, 2026);
  const index = await s.list(),
    old = index.campaigns.find((c) => c.year === 2026 && c.team_id === 'C'),
    current = index.campaigns.find((c) => c.year === 2027 && c.team_id === 'C');
  const previous = await s.load(old.id);
  let d = await s.view(current.id);
  const m = d.members[0];
  await s.mutate(current.id, { action: 'retire_member', version: d.campaign.version, memberId: m.id });
  assert.equal((await s.view(current.id)).members.length, 15);
  assert.deepEqual(await s.load(old.id), previous);
  await s.createCampaigns(2028, 2027);
  const next = (await s.list()).campaigns.find((c) => c.year === 2028 && c.team_id === 'C');
  assert.equal((await s.view(next.id)).members.length, 15);
});
test('los equipos son A–H y sus nombres públicos son fijos', async () => {
  const repo = new Repo(),
    s = new Service(repo, owner);
  await s.init();
  await repo.batch([{ sql: "UPDATE teams SET name='Nombre legado' WHERE id='C'" }]);
  assert.equal((await s.list()).teams.find((t) => t.id === 'C').name, 'Equipo C');
});
test('importación atómica conserva nombre, orden, antigüedad vacía y selección', async () => {
  const repo = new Repo(),
    s = new Service(repo, owner);
  await s.init();
  const cid = (await s.list()).campaigns.find((c) => c.team_id === 'C').id;
  const d = await s.view(cid),
    date = d.result.cycles[0].date;
  const source = {
    format: 'vacaciones-roster-v1',
    team: 'C',
    year: 2026,
    copySelections: true,
    selectionOrder: [{ round: 1, code: 'PEÑA', date }],
    rows: [
      { code: 'PEÑA', label: 'Nombre ficticio uno', seniority: '', dates: [date] },
      { code: 'DOS', label: 'Nombre ficticio dos', seniority: '', dates: [] },
    ],
  };
  const review = await s.mutate(cid, { action: 'preview_import_roster', version: d.campaign.version, source });
  const imported = await importRoster(s, cid, {
    action: 'import_roster',
    version: d.campaign.version,
    source,
    reviewToken: review.reviewToken,
    acceptViolations: true,
  });
  assert.equal(imported.members.length, 2);
  assert.equal(imported.members[0].code, 'PEÑA');
  assert.equal(imported.members[0].label, 'Nombre ficticio uno');
  assert.equal(imported.members[0].seniority, '');
  assert.equal(imported.requests.length, 1);
  assert.equal(imported.awards.length, 1);
  await s.createCampaigns(2027, 2026);
  const next = (await s.list()).campaigns.find((c) => c.team_id === 'C' && c.year === 2027);
  assert.equal((await s.load(next.id)).members[0].label, 'Nombre ficticio uno');
  assert.equal((await s.load(next.id)).requests.length, 0);
});
test('edición masiva conserva selecciones y rechaza identidades ajenas', async () => {
  const repo = new Repo(),
    s = new Service(repo, owner);
  await s.init();
  const cid = (await s.list()).campaigns.find((c) => c.team_id === 'C').id;
  let d = await s.view(cid);
  d = await s.mutate(cid, {
    action: 'request',
    version: d.campaign.version,
    memberId: d.members[0].id,
    slot: 1,
    date: d.result.cycles[0].date,
  });
  const before = d.requests;
  d = await s.mutate(cid, {
    action: 'bulk_members',
    version: d.campaign.version,
    rows: d.members.map((m, i) => ({ memberId: m.id, code: m.code, label: 'Ficticio ' + i, seniority: '' })),
  });
  assert.deepEqual(d.requests, before);
  assert.ok(d.members.every((m) => m.seniority === ''));
  await assert.rejects(
    s.mutate(cid, {
      action: 'bulk_members',
      version: d.campaign.version,
      rows: [{ memberId: 'foreign', code: 'ZZ', label: '', seniority: '' }],
    }),
    /ajeno/,
  );
  const limited = new Service(repo, { id: 'chatgpt:x', role: 'team_admin', teams: ['C'] });
  await limited.mutate(cid, {
    action: 'bulk_members',
    version: d.campaign.version,
    rows: [{ code: 'ZZ', label: '', seniority: '' }],
  });
});

test('corregir un año antiguo no cambia la plantilla del siguiente ni la de años futuros', async () => {
  const s = new Service(new Repo(), owner);
  await s.init();
  await s.createCampaigns(2027, 2026);
  let index = await s.list();
  const old = index.campaigns.find((c) => c.year === 2026 && c.team_id === 'C'),
    current = index.campaigns.find((c) => c.year === 2027 && c.team_id === 'C');
  const baseline = await s.load(current.id);
  let d = await s.view(old.id);
  d = await s.mutate(old.id, {
    action: 'bulk_members',
    version: d.campaign.version,
    rows: [
      { memberId: d.members[0].id, code: 'CORREGIDO', label: 'Corrección del pasado', seniority: '' },
      { code: 'NUEVO_2026', label: 'Alta pasada', seniority: '' },
    ],
  });
  await s.mutate(old.id, {
    action: 'retire_member',
    version: d.campaign.version,
    memberId: d.members.find((m) => m.code === 'C02').id,
  });
  assert.deepEqual(await s.load(current.id), baseline);
  await s.createCampaigns(2028, 2027);
  index = await s.list();
  const next = index.campaigns.find((c) => c.year === 2028 && c.team_id === 'C'),
    members = (await s.load(next.id)).members;
  assert.equal(members.length, 16);
  assert.deepEqual(
    members.map((m) => [m.person_id, m.code, m.label, m.seniority]),
    baseline.members.map((m) => [m.person_id, m.code, m.label, m.seniority]),
  );
});
test('plantilla de origen explícita y ejercicio vacío son independientes de los parámetros', async () => {
  const s = new Service(new Repo(), owner);
  await s.init();
  await s.createCampaigns(2027, 2026, null);
  let index = await s.list();
  const current = index.campaigns.find((c) => c.year === 2027 && c.team_id === 'C');
  let d = await s.view(current.id);
  assert.equal(d.members.length, 0);
  d = await s.mutate(current.id, {
    action: 'bulk_members',
    version: d.campaign.version,
    rows: [{ code: 'C01', label: 'Otra persona', seniority: '' }],
  });
  assert.equal(d.members.length, 1);
  await s.createCampaigns(2028, 2027, 2026);
  const next = (await s.list()).campaigns.find((c) => c.year === 2028 && c.team_id === 'C');
  assert.equal((await s.load(next.id)).members.length, 16);
  await assert.rejects(s.createCampaigns(2029, null, 2030), /anterior/);
  await assert.rejects(s.createCampaigns(2029, null, 2025), /origen/);
  assert.equal(
    (await s.list()).campaigns.some((c) => c.year === 2029),
    false,
  );
});
test('cambio de turno por ejercicio es atómico y conserva el histórico y la identidad', async () => {
  const repo = new Repo(),
    s = new Service(repo, owner);
  await s.init();
  await s.createCampaigns(2027, 2026);
  const index = await s.list(),
    source = index.campaigns.find((c) => c.year === 2027 && c.team_id === 'C'),
    target = index.campaigns.find((c) => c.year === 2027 && c.team_id === 'A'),
    old = index.campaigns.find((c) => c.year === 2026 && c.team_id === 'C');
  const historical = await s.load(old.id),
    before = await s.load(source.id),
    destination = await s.load(target.id),
    member = before.members[0];
  const body = {
    action: 'transfer_member',
    memberId: member.id,
    version: source.version,
    targetTeam: 'A',
    targetVersion: target.version,
  };
  await assert.rejects(s.mutate(source.id, { ...body, targetVersion: 0 }), /destino cambió/);
  assert.deepEqual(await s.load(source.id), before);
  assert.deepEqual(await s.load(target.id), destination);
  await assert.rejects(
    new Service(repo, { id: 'team-admin', role: 'team_admin', teams: ['C'] }).mutate(source.id, body),
    /permiso/,
  );
  await s.mutate(source.id, body);
  assert.equal((await s.load(source.id)).members.length, 15);
  const moved = (await s.load(target.id)).members.find((m) => m.person_id === member.person_id);
  assert.equal(moved.code, member.code);
  assert.equal(moved.seniority, member.seniority);
  assert.deepEqual(await s.load(old.id), historical);
  await s.createCampaigns(2028, 2027);
  const next = (await s.list()).campaigns;
  assert.equal((await s.load(next.find((c) => c.year === 2028 && c.team_id === 'A').id)).members.length, 17);
  assert.equal((await s.load(next.find((c) => c.year === 2028 && c.team_id === 'C').id)).members.length, 15);
});
test('no se retira ni se traslada una persona con vacaciones registradas', async () => {
  const s = new Service(new Repo(), owner);
  await s.init();
  const index = await s.list(),
    source = index.campaigns.find((c) => c.team_id === 'C'),
    target = index.campaigns.find((c) => c.team_id === 'A');
  let d = await s.view(source.id);
  const memberId = d.members[0].id;
  d = await s.mutate(source.id, {
    action: 'request',
    version: d.campaign.version,
    memberId,
    slot: 1,
    date: d.result.cycles[0].date,
  });
  const baseline = await s.load(source.id);
  await assert.rejects(
    s.mutate(source.id, { action: 'retire_member', version: d.campaign.version, memberId }),
    /solicitudes/,
  );
  await assert.rejects(
    s.mutate(source.id, {
      action: 'transfer_member',
      version: d.campaign.version,
      memberId,
      targetTeam: 'A',
      targetVersion: target.version,
    }),
    /vacaciones/,
  );
  assert.deepEqual(await s.load(source.id), baseline);
});

test('edita registro legado, corrige correo y revoca o elimina permisos con control de versión', async () => {
  const repo = new Repo(),
    s = new Service(repo, owner);
  await s.init();
  const legacy = 'chatgpt:delegate@example.test';
  await repo.batch([
    {
      sql: 'INSERT INTO users(id,provider,subject,role,version) VALUES(?,?,?,?,1)',
      args: [legacy, 'chatgpt', 'delegate@example.test', 'team_admin'],
    },
  ]);
  const body = {
    id: legacy,
    provider: 'chatgpt',
    subject: 'correct@example.test',
    role: 'team_admin',
    teams: ['B'],
    version: 1,
  };
  await s.configureUser(body);
  const uid = 'chatgpt:email:correct@example.test';
  assert.equal((await repo.all('SELECT * FROM users WHERE id=?', [legacy])).length, 0);
  assert.deepEqual(
    (await repo.all('SELECT team_id FROM grants WHERE user_id=?', [uid])).map((g) => g.team_id),
    ['B'],
  );
  await assert.rejects(s.configureUser({ ...body, id: uid }), /cambiaron/);
  await assert.rejects(s.configureUser({ ...body, id: uid, role: 'viewer', teams: [], version: 2 }));
  await s.configureUser({ subject: 'reserva@example.test', role: 'team_admin', teams: ['B'], version: 0 });
  await s.configureUser({ ...body, id: uid, role: 'viewer', teams: [], version: 2 });
  assert.equal((await repo.all('SELECT * FROM grants')).length, 1);
  await assert.rejects(
    new Service(repo, { id: 'reader', role: 'viewer', teams: [] }).deleteUser({ id: uid, version: 3 }),
    /superadministrador/,
  );
  await assert.rejects(s.deleteUser({ id: uid, version: 2 }), /cambiaron/);
  await s.deleteUser({ id: uid, version: 3 });
  assert.equal((await repo.all('SELECT * FROM users')).length, 1);
  assert.equal((await repo.all("SELECT * FROM audit WHERE action='delete_permissions'")).length, 1);
});

test('corregir correo no sobrescribe otra cuenta ni modifica sus equipos', async () => {
  const repo = new Repo(),
    s = new Service(repo, owner);
  await s.init();
  await s.configureUser({ subject: 'one@example.test', role: 'team_admin', teams: ['A'], version: 0 });
  await s.configureUser({ subject: 'two@example.test', role: 'team_admin', teams: ['B'], version: 0 });
  const before = await s.admin();
  await assert.rejects(
    s.configureUser({
      id: 'chatgpt:email:one@example.test',
      subject: 'two@example.test',
      role: 'viewer',
      teams: [],
      version: 1,
    }),
    /ya tiene permisos/,
  );
  assert.deepEqual((await s.admin()).users, before.users);
  assert.deepEqual((await s.admin()).grants, before.grants);
});

test('responsable sin equipos se rechaza sin crear un registro incompleto', async () => {
  const repo = new Repo(),
    s = new Service(repo, owner);
  await s.init();
  await assert.rejects(
    s.configureUser({ subject: 'empty@example.test', role: 'team_admin', teams: [], version: 0 }),
    /al menos un equipo/,
  );
  assert.equal((await repo.all('SELECT * FROM users')).length, 0);
});
