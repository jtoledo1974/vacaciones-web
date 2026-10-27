import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { Service } from '../server/service.ts';
import type { Principal } from '../server/permissions.ts';
import type { Repository, Statement } from '../server/repository.ts';
import { readHrWorkbook, zipTexts } from '../server/hr-xlsx.ts';

class SQLiteRepo implements Repository {
  db = new DatabaseSync(':memory:');
  constructor() {
    this.db.exec('PRAGMA foreign_keys=ON;');
    for (const migration of readdirSync('drizzle')
      .filter((f) => f.endsWith('.sql'))
      .sort())
      this.db.exec(readFileSync('drizzle/' + migration, 'utf8'));
  }
  async all<T>(sql: string, args: unknown[] = []): Promise<T[]> {
    return this.db.prepare(sql).all(...(args as SQLInputValue[])) as T[];
  }
  async batch(ss: Statement[]) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const results = ss.map((s) => {
        const q = this.db.prepare(s.sql);
        return {
          results: q.columns().length
            ? q.all(...((s.args ?? []) as SQLInputValue[]))
            : (q.run(...((s.args ?? []) as SQLInputValue[])), []),
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
const template = readFileSync(new URL('./fixtures/hr-template-anon.xlsm', import.meta.url));
const superuser: Principal = { id: 'chatgpt:owner', role: 'superadmin', teams: [] };

async function setup() {
  const repo = new SQLiteRepo(),
    s = new Service(repo, superuser);
  await s.init();
  await s.createCampaigns(2027, 2026);
  const cid = (await s.list()).campaigns.find(
    (c: { year: number; team_id: string; scope_key: string }) =>
      c.year === 2027 && c.team_id === 'C' && c.scope_key === 'live',
  ).id;
  const admin = new Service(repo, { id: 'chatgpt:c', role: 'team_admin', teams: ['C'] });
  return { repo, s, cid, admin };
}

test('exportación a RRHH: plantilla, nombres, equipo cerrado y solo la hoja propia', async () => {
  const { repo, s, cid, admin } = await setup();
  assert.equal((await admin.hrStatus(cid)).template, null);
  await assert.rejects(admin.uploadHrTemplate(2027, template.toString('base64')), /superadministrador/);
  await assert.rejects(s.uploadHrTemplate(2026, template.toString('base64')), /es de 2027/);
  await s.uploadHrTemplate(2027, template.toString('base64'));
  await assert.rejects(
    new Service(repo, { id: 'chatgpt:a', role: 'team_admin', teams: ['A'] }).hrStatus(cid),
    /permiso/,
  );

  const status = await admin.hrStatus(cid);
  assert.equal(status.roster.length, 19);
  const d = await s.load(cid);
  const cycles = (await s.view(cid)).result.cycles;
  const [first, second] = d.members;
  await repo.batch([
    {
      sql: 'INSERT INTO awards(id,campaign_id,member_id,cycle_date) VALUES(?,?,?,?)',
      args: ['w1', cid, second.id, cycles[3].date],
    },
    {
      sql: 'INSERT INTO awards(id,campaign_id,member_id,cycle_date) VALUES(?,?,?,?)',
      args: ['w2', cid, first.id, cycles[45].date],
    },
  ]);
  await assert.rejects(admin.exportHrTeam(cid), /Cierra el equipo/);
  await s.mutate(cid, { action: 'close', version: (await s.load(cid)).campaign.version });
  await assert.rejects(
    admin.exportHrTeam(cid),
    (e: Error & { status?: number }) => e.status === 409 && /sin nombre de RRHH/.test(e.message),
  );

  await assert.rejects(admin.saveHrNames(cid, { [first.id]: 'NO EXISTE,NADIE' }), /no está en la hoja C/);
  await admin.saveHrNames(cid, { [first.id]: status.roster[0], [second.id]: status.roster[1] });
  const { name, bytes } = await admin.exportHrTeam(cid);
  assert.equal(name, '2027_LECS_Vac_C.xlsm');

  const book = await readHrWorkbook(bytes);
  const texts = await zipTexts(bytes),
    original = await zipTexts(new Uint8Array(template));
  const sheet = texts.get(book.paths.C)!;
  assert.ok(sheet.includes(`<c r="E11" s="2" t="inlineStr"><is><t xml:space="preserve">${status.roster[1]}</t>`));
  assert.ok(sheet.includes(`<c r="E53"`) && sheet.includes(status.roster[0]));
  for (const team of 'ABDEFGH') assert.equal(texts.get(book.paths[team]), original.get(book.paths[team]), team);
  const audit = await repo.all("SELECT * FROM audit WHERE action='hr_export'");
  assert.equal(audit.length, 1);
});

test('exportación global: solo superadministrador, rellena los equipos cerrados y avisa de los abiertos', async () => {
  const { repo, s, admin } = await setup();
  await s.uploadHrTemplate(2027, template.toString('base64'));
  await assert.rejects(admin.exportHrGlobal(2027), /superadministrador/);
  await assert.rejects(s.exportHrGlobal(2027), /ningún equipo cerrado/);

  const live = (await s.list()).campaigns.filter(
    (c: { year: number; scope_key: string }) => c.year === 2027 && c.scope_key === 'live',
  );
  const byTeam = (team: string) => live.find((c: { team_id: string }) => c.team_id === team).id;
  const award = async (team: string, i: number) => {
    const cid = byTeam(team);
    const d = await s.load(cid);
    const cycle = (await s.view(cid)).result.cycles[i].date;
    await repo.batch([
      {
        sql: 'INSERT INTO awards(id,campaign_id,member_id,cycle_date) VALUES(?,?,?,?)',
        args: [team + i, cid, d.members[0].id, cycle],
      },
    ]);
    await s.mutate(cid, { action: 'close', version: (await s.load(cid)).campaign.version });
    return { cid, member: d.members[0].id };
  };
  const a = await award('A', 0);
  const h = await award('H', 44);
  await assert.rejects(
    s.exportHrGlobal(2027),
    (e: Error & { status?: number }) =>
      e.status === 409 && /Equipo A: .*sin nombre/.test(e.message) && /Equipo H/.test(e.message),
  );
  for (const { cid, member } of [a, h]) {
    const roster = (await s.hrStatus(cid)).roster;
    await s.saveHrNames(cid, { [member]: roster[0] });
  }
  const { name, bytes, open } = await s.exportHrGlobal(2027);
  assert.equal(name, '2027_LECS_Vac_global.xlsm');
  assert.deepEqual(open, ['B', 'C', 'D', 'E', 'F', 'G']);
  const book = await readHrWorkbook(bytes);
  const texts = await zipTexts(bytes),
    original = await zipTexts(new Uint8Array(template));
  assert.match(texts.get(book.paths.A)!, /<c r="E8" s="2" t="inlineStr">/);
  assert.match(texts.get(book.paths.H)!, /<c r="E52" s="2" t="inlineStr">/);
  for (const team of 'BCDEFG') assert.equal(texts.get(book.paths[team]), original.get(book.paths[team]), team);
});

// Publishing 2027 needs a complete RRHH-valid allocation; the publish command only
// sets status='published' and published_run_id (server/service-commands.ts), so set that state here.
test('un equipo publicado cuenta como cerrado: se exporta, también en la global', async () => {
  const { repo, s, cid, admin } = await setup();
  await s.uploadHrTemplate(2027, template.toString('base64'));
  const d = await s.view(cid);
  const memberId = d.members[0].id;
  await s.mutate(cid, { action: 'award', version: d.campaign.version, memberId, date: d.result.cycles[2].date });
  await assert.rejects(admin.exportHrTeam(cid), /Cierra el equipo/);
  await repo.batch([{ sql: "UPDATE campaigns SET status='published' WHERE id=?", args: [cid] }]);

  const status = await admin.hrStatus(cid);
  assert.equal(status.closed, true);
  await admin.saveHrNames(cid, { [memberId]: status.roster[0] });
  const team = await admin.exportHrTeam(cid);
  const global = await s.exportHrGlobal(2027);
  assert.ok(!global.open.includes('C'));
  for (const bytes of [team.bytes, global.bytes]) {
    const book = await readHrWorkbook(bytes);
    assert.match((await zipTexts(bytes)).get(book.paths.C)!, /<c r="E10" s="2" t="inlineStr">/);
  }
});

test('exporta coincidencias exactas propuestas sin guardar, tanto por equipo como global', async () => {
  const { repo, s, cid, admin } = await setup();
  await s.uploadHrTemplate(2027, template.toString('base64'));
  const roster = (await admin.hrStatus(cid)).roster;
  const d = await s.view(cid);
  const member = d.members[0];
  await repo.batch([{ sql: 'UPDATE campaign_members SET label=? WHERE id=?', args: [roster[0], member.id] }]);
  await s.mutate(cid, {
    action: 'award',
    version: d.campaign.version,
    memberId: member.id,
    date: d.result.cycles[2].date,
  });
  await s.mutate(cid, { action: 'close', version: (await s.load(cid)).campaign.version });
  const status = await admin.hrStatus(cid);
  assert.deepEqual(status.members.find((m) => m.id === member.id)!.suggested, { name: roster[0], exact: true });
  assert.equal(status.members.find((m) => m.id === member.id)!.hrName, null);
  for (const bytes of [(await admin.exportHrTeam(cid)).bytes, (await s.exportHrGlobal(2027)).bytes]) {
    const book = await readHrWorkbook(bytes);
    assert.ok((await zipTexts(bytes)).get(book.paths.C)!.includes(roster[0]));
  }
  assert.equal((await repo.all('SELECT * FROM hr_names')).length, 0);
});

test('rechazar una propuesta («Sin asignar») impide que el servidor la use; las aproximadas solo con confirmación', async () => {
  const { repo, s, cid, admin } = await setup();
  await s.uploadHrTemplate(2027, template.toString('base64'));
  const roster = (await admin.hrStatus(cid)).roster;
  const d = await s.view(cid);
  const [exact, approx] = d.members;
  // Exact: same words. Approximate: an extra word ("Apodo") besides the RRHH name.
  await repo.batch([
    { sql: 'UPDATE campaign_members SET label=? WHERE id=?', args: [roster[0], exact.id] },
    { sql: 'UPDATE campaign_members SET label=? WHERE id=?', args: ['Apodo ' + roster[1], approx.id] },
  ]);
  let version = d.campaign.version;
  for (const [memberId, i] of [
    [exact.id, 2],
    [approx.id, 3],
  ] as const) {
    await s.mutate(cid, { action: 'award', version, memberId, date: d.result.cycles[i].date });
    version = (await s.load(cid)).campaign.version;
  }
  await s.mutate(cid, { action: 'close', version });

  let status = await admin.hrStatus(cid);
  const byId = (id: string) => status.members.find((m) => m.id === id)!;
  assert.deepEqual(byId(exact.id).suggested, { name: roster[0], exact: true });
  assert.deepEqual(byId(approx.id).suggested, { name: roster[1], exact: false });
  // Never reviewed: the exact match is used, the approximate one is not.
  await assert.rejects(
    admin.exportHrTeam(cid),
    (e: Error) => /sin nombre de RRHH/.test(e.message) && /Apodo/.test(e.message),
  );

  // The admin rejects the exact proposal and confirms the approximate one.
  status = await admin.saveHrNames(cid, { [exact.id]: '', [approx.id]: roster[1] });
  assert.equal(byId(exact.id).hrName, '');
  await assert.rejects(
    admin.exportHrTeam(cid),
    (e: Error) => /sin nombre de RRHH/.test(e.message) && e.message.includes(roster[0]) && !/Apodo/.test(e.message),
  );
  // Forgetting the decision (null) brings the exact proposal back.
  await admin.saveHrNames(cid, { [exact.id]: null });
  const { bytes } = await admin.exportHrTeam(cid);
  const sheet = (await zipTexts(bytes)).get((await readHrWorkbook(bytes)).paths.C)!;
  assert.ok(sheet.includes(roster[0]) && sheet.includes(roster[1]));
});
