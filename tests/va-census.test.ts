import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteRepo } from './sqlite-repo.ts';
import { Service, principal } from '../server/service.ts';
import { myVa, vaCensus, vaLinkAccount, vaVisibility } from '../server/va-census.ts';
import { vaDays, vaYears } from '../domain/va-entitlement.ts';
import type { Principal } from '../server/permissions.ts';

const superadmin: Principal = { id: 'test-admin', role: 'superadmin', teams: [] };
const vaAdmin: Principal = { id: 'chatgpt:va', role: 'viewer', teams: [], vaAdmin: true };
const teamAdmin: Principal = { id: 'chatgpt:resp', role: 'team_admin', teams: ['A'] };
// Demo seed: 2026 campaigns, A-1…A-16 with seniority 2001…2016, so 25…10 years.
async function setup() {
  const repo = new SQLiteRepo();
  await new Service(repo, superadmin).init();
  return repo;
}

test('derecho: 1 día a los 20 años y uno más cada 5, sin tope, contados en el año de las VA', () => {
  assert.deepEqual(
    [19, 20, 24, 25, 30, 35, 40, 45].map((y) => vaDays(y)),
    [0, 1, 1, 2, 3, 4, 5, 6],
  );
  assert.equal(vaDays(null), 0);
  // Quien pide en 2026 para 2027 por segunda vez cumplió 20 en 2026.
  assert.equal(vaYears('2006-09-15', 2027), 21);
  assert.equal(vaDays(vaYears('2006-09-15', 2027)), 1);
  assert.equal(vaYears('', 2027), null);
});

test('el censo es del administrador de VA o superadministrador, no del responsable de equipo', async () => {
  const repo = await setup();
  await assert.rejects(vaCensus(repo, teamAdmin), /administrador de VA/);
  const census = await vaCensus(repo, vaAdmin);
  assert.equal(census.year, 2026);
  // Six entitled per team (2001…2006), the 2001 one with two days.
  assert.equal(census.people.length, 48);
  assert.equal(census.totalDays, 56);
  assert.equal(census.notEntitled, 80);
  assert.ok(census.people.every((p) => p.status === 'entitled' && p.account === null));
  assert.deepEqual(await vaCensus(repo, superadmin), census);
});

test('una ficha sin fecha aparece como pendiente, sin derecho calculado', async () => {
  const repo = await setup();
  repo.db.exec("UPDATE people SET seniority='' WHERE id='B-16'");
  const row = (await vaCensus(repo, vaAdmin)).people.find((p) => p.personId === 'B-16');
  assert.equal(row?.status, 'missing_date');
  assert.equal(row?.days, 0);
});

test('vincula, cambia y quita el acceso con control de versión y auditoría', async () => {
  const repo = await setup();
  const link = (body: object) => vaLinkAccount(repo, vaAdmin, { personId: 'C-1', ...body });
  await assert.rejects(link({ subject: 'no-es-correo', accountVersion: 0 }), /correo válido/);
  await assert.rejects(
    vaLinkAccount(repo, vaAdmin, { personId: 'C-16', subject: 'x@y.es', accountVersion: 0 }),
    /censo/,
  );
  await assert.rejects(vaLinkAccount(repo, teamAdmin, { personId: 'C-1', subject: 'x@y.es', accountVersion: 0 }), /VA/);
  await link({ subject: 'Ana@Ejemplo.es', accountVersion: 0 });
  let row = (await vaCensus(repo, vaAdmin)).people.find((p) => p.personId === 'C-1');
  assert.deepEqual(row?.account, { provider: 'chatgpt', subject: 'ana@ejemplo.es', version: 1 });
  await assert.rejects(link({ subject: 'otra@ejemplo.es', accountVersion: 0 }), /cambió/);
  await link({ provider: 'firebase', subject: 'uid123', accountVersion: 1 });
  await link({ subject: '', accountVersion: 2 });
  row = (await vaCensus(repo, vaAdmin)).people.find((p) => p.personId === 'C-1');
  assert.equal(row?.account, null);
  const audit = await repo.all("SELECT * FROM audit WHERE action='va_account' ORDER BY rowid");
  assert.equal(audit.length, 3);
  assert.equal(JSON.parse(audit[0].after_json).account, 'chatgpt-email:ana@ejemplo.es');
});

test('el controlador ve su propio derecho y la entrada de menú solo si participa', async () => {
  const repo = await setup();
  const me: Principal = { id: 'chatgpt:x', role: 'viewer', teams: [], emailKey: 'chatgpt-email:yo@ejemplo.es' };
  assert.deepEqual(await vaVisibility(repo, me), { year: 2026, entry: false, admin: false });
  await vaLinkAccount(repo, vaAdmin, { personId: 'D-2', subject: 'yo@ejemplo.es', accountVersion: 0 });
  const mine = await myVa(repo, me);
  assert.deepEqual(mine.me, {
    code: 'D02',
    seniority: '2002-01-01',
    controllerNumber: null,
    years: 24,
    days: 1,
    status: 'entitled',
    firstYear: 2022,
  });
  assert.equal((await vaVisibility(repo, me)).entry, true);
  assert.equal((await vaVisibility(repo, vaAdmin)).entry, true);
  assert.equal((await vaVisibility(repo, { id: null, role: 'viewer', teams: [] })).entry, false);
});

test('el rol de administrador de VA lo asigna un superadministrador y se suma al de equipo', async () => {
  const repo = await setup();
  const admin = new Service(repo, superadmin);
  await admin.configureUser({ subject: 'va@ejemplo.es', role: 'team_admin', teams: ['A'], vaAdmin: true, version: 0 });
  const identity = { provider: 'chatgpt', subject: 'sub-va', email: 'va@ejemplo.es', emailVerified: true };
  const p = await principal(repo, identity, '');
  assert.equal(p.role, 'team_admin');
  assert.deepEqual(p.teams, ['A']);
  assert.equal(p.vaAdmin, true);
  const user = (await repo.all("SELECT * FROM users WHERE subject='email:va@ejemplo.es'"))[0];
  await admin.configureUser({
    id: user.id,
    subject: 'va@ejemplo.es',
    role: 'team_admin',
    teams: ['A'],
    version: user.version,
  });
  assert.equal((await principal(repo, identity, '')).vaAdmin, false);
});
