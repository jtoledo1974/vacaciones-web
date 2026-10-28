import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteRepo } from './sqlite-repo.ts';
import { Service } from '../server/service.ts';
import { masterSeniority } from '../server/master-seniority.ts';
import type { Principal } from '../server/permissions.ts';

const actor: Principal = { id: 'test-admin', role: 'superadmin', teams: [] };
async function setup() {
  const repo = new SQLiteRepo();
  await new Service(repo, actor).init();
  repo.db.exec(
    "UPDATE people SET seniority=''; UPDATE campaign_members SET seniority=''; UPDATE campaigns SET status='closed'",
  );
  const people = await repo.all('SELECT id FROM people ORDER BY id LIMIT 2');
  const body = {
    action: 'preview',
    source: { title: 'Escalafón de prueba', sha256: 'a'.repeat(64), asOf: '2025-12-31' },
    entries: people.map((p, i) => ({ personId: p.id, date: '2004-10-25', controllerNumber: 2500 + i, page: 23 })),
  };
  return { repo, body };
}
test('carga fichas maestras con auditoría sin tocar campañas cerradas, elecciones o preferencias', async () => {
  const { repo, body } = await setup();
  const tables = ['campaigns', 'campaign_members', 'election_states', 'preferences', 'requests', 'awards'];
  const before = await Promise.all(tables.map((t) => repo.all('SELECT * FROM ' + t)));
  const review = await masterSeniority(repo, actor, body);
  assert.equal(review.changed, 2);
  assert.equal(
    (await masterSeniority(repo, actor, { ...body, action: 'apply', reviewToken: review.reviewToken })).updated,
    2,
  );
  assert.deepEqual(await Promise.all(tables.map((t) => repo.all('SELECT * FROM ' + t))), before);
  assert.equal((await repo.all("SELECT id FROM people WHERE seniority='2004-10-25'")).length, 2);
  const audit = (await repo.all("SELECT * FROM audit WHERE action='master_seniority'"))[0];
  assert.equal(audit.campaign_id, null);
  assert.equal(JSON.parse(audit.after_json).source.sha256, body.source.sha256);
  const repeat = await masterSeniority(repo, actor, body);
  assert.equal(repeat.changed, 0);
  assert.equal(
    (await masterSeniority(repo, actor, { ...body, action: 'apply', reviewToken: repeat.reviewToken })).updated,
    0,
  );
});
test('solo superadministrador; no aplica sin revisión ni con versión obsoleta', async () => {
  const { repo, body } = await setup();
  await assert.rejects(
    masterSeniority(repo, { id: 'team-admin', role: 'team_admin', teams: ['A'] }, body),
    /superadministrador/,
  );
  await assert.rejects(masterSeniority(repo, actor, { ...body, action: 'apply' }), /Revisa/);
  const review = await masterSeniority(repo, actor, body);
  repo.db.prepare('UPDATE people SET version=version+1 WHERE id=?').run(body.entries[0].personId);
  await assert.rejects(
    masterSeniority(repo, actor, { ...body, action: 'apply', reviewToken: review.reviewToken }),
    /Revisa/,
  );
  assert.equal((await repo.all("SELECT id FROM people WHERE seniority<>''")).length, 0);
});
test('no sobrescribe fechas existentes ni admite datos imposibles o CTA repetidos', async () => {
  const { repo, body } = await setup();
  await assert.rejects(
    masterSeniority(repo, actor, { ...body, entries: [{ ...body.entries[0], date: '2004-02-31' }] }),
    /no válida/,
  );
  await assert.rejects(
    masterSeniority(repo, actor, { ...body, entries: [body.entries[0], body.entries[0]] }),
    /duplicados/,
  );
  repo.db.prepare('UPDATE people SET seniority=? WHERE id=?').run('2000-01-01', body.entries[1].personId);
  await assert.rejects(masterSeniority(repo, actor, body), /distinta/);
  assert.equal(
    (await repo.all('SELECT seniority FROM people WHERE id=?', [body.entries[0].personId]))[0].seniority,
    '',
  );
});
test('un conflicto durante la escritura revierte todo el lote', async () => {
  const { repo, body } = await setup();
  const review = await masterSeniority(repo, actor, body);
  const original = repo.batch.bind(repo);
  repo.batch = async (ops) => {
    // Only the write batch: reads use batch() too.
    if (ops[0].sql.startsWith('UPDATE'))
      repo.db.prepare('UPDATE people SET version=version+1 WHERE id=?').run(body.entries[1].personId);
    return original(ops);
  };
  await assert.rejects(
    masterSeniority(repo, actor, { ...body, action: 'apply', reviewToken: review.reviewToken }),
    /han cambiado/,
  );
  assert.equal((await repo.all("SELECT id FROM people WHERE seniority<>''")).length, 0);
  assert.equal((await repo.all("SELECT id FROM audit WHERE action='master_seniority'")).length, 0);
});
test('el número CTA se guarda y no puede repetirse en una carga posterior', async () => {
  const { repo, body } = await setup();
  const review = await masterSeniority(repo, actor, body);
  await masterSeniority(repo, actor, { ...body, action: 'apply', reviewToken: review.reviewToken });
  assert.equal(
    (await repo.all('SELECT controller_number FROM people WHERE id=?', [body.entries[0].personId]))[0]
      .controller_number,
    2500,
  );
  const other = (
    await repo.all('SELECT id FROM people WHERE active=1 AND id NOT IN (?,?) LIMIT 1', [
      body.entries[0].personId,
      body.entries[1].personId,
    ])
  )[0];
  const later = {
    ...body,
    entries: [{ personId: other.id, date: '2004-10-25', controllerNumber: 2500, page: 24 }],
  };
  await assert.rejects(masterSeniority(repo, actor, later), /ya pertenece a otra ficha/);
  const renumber = { ...body, entries: [{ ...body.entries[0], controllerNumber: 2600 }] };
  await assert.rejects(masterSeniority(repo, actor, renumber), /número CTA distinto/);
});
test('un lote grande se lee en bloques, sin una consulta por ficha', async () => {
  const { repo, body } = await setup();
  const people = await repo.all('SELECT id FROM people WHERE active=1 ORDER BY id LIMIT 300');
  assert.ok(people.length > 100, 'la semilla debe superar un bloque');
  const large = {
    ...body,
    entries: people.map((p, i) => ({ personId: p.id, date: '2004-10-25', controllerNumber: 3000 + i, page: 1 })),
  };
  let reads = 0;
  const all = repo.all.bind(repo),
    batch = repo.batch.bind(repo);
  repo.all = async (...args) => (reads++, all(...args));
  repo.batch = async (ops) => (reads++, batch(ops));
  const review = await masterSeniority(repo, actor, large);
  assert.ok(reads <= Math.ceil(people.length / 100), 'lecturas: ' + reads);
  assert.equal(
    (await masterSeniority(repo, actor, { ...large, action: 'apply', reviewToken: review.reviewToken })).updated,
    people.length,
  );
});
