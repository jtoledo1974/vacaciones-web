import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteRepo } from './sqlite-repo.ts';
import { Service } from '../server/service.ts';
import {
  importVaElection,
  mutateVaElection,
  vaElectionView,
  advanceVaElections,
  vaOrdinaryGuards,
} from '../server/va-election.ts';
import { loadVaQuotas } from '../server/va-quotas.ts';
import { importVaExternal } from '../server/va-external.ts';
import { vaCensus, vaLinkAccount, vaVisibility, myVa } from '../server/va-census.ts';
import type { Principal } from '../server/permissions.ts';
import type { Statement } from '../server/repository.ts';
import { decodePayload, encodePayload } from '../server/payload-codec.ts';

const admin: Principal = { id: 'admin', role: 'superadmin', teams: [] };
const vaAdmin: Principal = { id: 'va', role: 'team_admin', teams: ['va'] };
const p1: Principal = { id: 'chatgpt:p1', role: 'viewer', teams: [] };
const p2: Principal = { id: 'chatgpt:p2', role: 'viewer', teams: [] };
const source = { title: 'RRHH · fixture', sha256: 'a'.repeat(64), receivedAt: '2026-10-28' };
const d1 = '2026-08-01',
  d2 = '2026-08-02',
  d3 = '2026-09-01';
async function setup() {
  const repo = new SQLiteRepo();
  await new Service(repo, admin).init();
  repo.db.exec(`UPDATE people SET controller_number=1 WHERE id='A-1';
    UPDATE people SET controller_number=2,seniority='2006-01-01' WHERE id='A-2';
    INSERT INTO controller_accounts VALUES('A-1','chatgpt:p1',1),('A-2','chatgpt:p2',1);`);
  const body = { people: ['A-1', 'A-2'], source, action: 'preview' };
  const preview = await importVaElection(repo, vaAdmin, 2026, body);
  await importVaElection(repo, vaAdmin, 2026, { ...body, action: 'apply', reviewToken: preview.reviewToken });
  const days = { [d1]: 1, [d2]: 1, [d3]: 1 };
  const q = await loadVaQuotas(repo, vaAdmin, { action: 'preview', year: 2026, source, days });
  await loadVaQuotas(repo, vaAdmin, { action: 'apply', year: 2026, source, days, reviewToken: q.reviewToken });
  return repo;
}
async function mutate(repo: SQLiteRepo, actor: Principal, body: Parameters<typeof mutateVaElection>[3], time?: Date) {
  const view = await vaElectionView(repo, actor, 2026);
  return mutateVaElection(repo, actor, 2026, { ...body, version: view.version }, time);
}
const close = (repo: SQLiteRepo) => repo.db.exec("UPDATE campaigns SET status='closed',version=version+1");

test('VA: el censo conserva el orden explícito, exige vista previa y se congela al abrir', async () => {
  const repo = await setup();
  const body = { action: 'preview', people: ['A-2', 'A-1'], source };
  const preview = await importVaElection(repo, vaAdmin, 2026, body);
  assert.equal(preview.warnings.length, 1);
  assert.ok(preview.omitted.length > 0, 'la vista previa muestra personas con derecho omitidas');
  await assert.rejects(importVaElection(repo, vaAdmin, 2026, { ...body, action: 'apply' }), /Revisa/);
  await importVaElection(repo, vaAdmin, 2026, { ...body, action: 'apply', reviewToken: preview.reviewToken });
  await assert.rejects(mutate(repo, vaAdmin, { action: 'start' }), /Cierra/);
  close(repo);
  const view = await mutate(repo, vaAdmin, { action: 'start' });
  assert.equal(view.state?.turn, 'A-2');
  await assert.rejects(importVaElection(repo, vaAdmin, 2026, body), /congelado/);
});

test('VA: una baja o corrección maestra no cambia el derecho ni el acceso congelados', async () => {
  const repo = await setup();
  close(repo);
  await mutate(repo, vaAdmin, { action: 'start' });
  const before = await myVa(repo, p1);
  repo.db.exec("UPDATE people SET seniority='2025-01-01',controller_number=98765,active=0 WHERE id='A-1'");
  assert.deepEqual(await myVa(repo, p1), before);
  assert.equal((await vaVisibility(repo, p1)).entry, true);
  assert.deepEqual((await myVa(repo, vaAdmin, { team: 'A', code: before.me!.code })).me, before.me);
  const elected = await mutate(repo, p1, { action: 'choose', dates: [d1] });
  assert.equal(elected.state?.choices[0].personId, 'A-1');
  // Someone omitted from the frozen census must not acquire access from a later correction.
  repo.db.exec(
    "INSERT INTO controller_accounts VALUES('A-3','chatgpt:omitted',1); UPDATE people SET seniority='2000-01-01' WHERE id='A-3'",
  );
  const omitted: Principal = { id: 'chatgpt:omitted', role: 'viewer', teams: [] };
  assert.equal((await myVa(repo, omitted)).me, null);
  assert.equal((await vaVisibility(repo, omitted)).entry, false);
});

test('VA: adjudicaciones públicas y motivos administrativos privados', async () => {
  const repo = await setup();
  close(repo);
  await mutate(repo, vaAdmin, { action: 'start' });
  const reason = 'Motivo administrativo privado de prueba';
  await mutate(repo, vaAdmin, { action: 'defer', personId: 'A-1', targetId: 'A-2', reason });
  await mutate(repo, p2, { action: 'choose', dates: [d2] });
  const management = await vaElectionView(repo, vaAdmin, 2026);
  assert.equal(management.state?.choices.length, 1);
  assert.ok(JSON.stringify(management.state?.deferrals).includes(reason));
  for (const actor of [{ id: null, role: 'viewer' as const, teams: [] }, p1, p2]) {
    const view = await vaElectionView(repo, actor, 2026);
    assert.deepEqual(view.state?.deferrals, {});
    assert.ok(!JSON.stringify(view).includes(reason));
    assert.deepEqual(view.state?.choices, management.state?.choices, 'adjudicaciones consultables sin autenticación');
    assert.deepEqual(view.available, management.available, 'disponibilidad agregada sin perder precisión');
    assert.equal(view.available[d2], 0);
  }
});

test('VA: integridad ordinaria ignora ejercicios sin adjudicaciones VA y conserva el año anterior', async () => {
  const repo = await setup();
  const writes = [{ sql: 'UPDATE campaigns SET version=version+1', args: [] }];
  assert.deepEqual(await vaOrdinaryGuards(repo, writes), [], 'censo VA sin elecciones no añade comprobaciones');
  close(repo);
  await mutate(repo, vaAdmin, { action: 'start' });
  await mutate(repo, p1, { action: 'choose', dates: [d1] });
  const current = await vaOrdinaryGuards(repo, writes);
  assert.ok(current.length > 0);
  // Irrelevant historical calendars must not even be parsed. The previous year's
  // December cycles must still be protected against overlapping January VA.
  repo.db.exec(`INSERT INTO campaigns(id,team_id,year,created_at,scope_key)
    SELECT 'historic-'||id,team_id,2020,created_at,'live' FROM campaigns WHERE year=2026;
    INSERT INTO parameters(campaign_id,json)
    SELECT id,'invalid historical config' FROM campaigns WHERE year=2020;
    INSERT INTO campaigns(id,team_id,year,created_at,scope_key)
    SELECT 'previous-'||id,team_id,2025,created_at,'live' FROM campaigns WHERE year=2026;
    INSERT INTO parameters(campaign_id,json)
    SELECT 'previous-'||p.campaign_id,replace(p.json,'2026-','2025-') FROM parameters p JOIN campaigns c ON c.id=p.campaign_id WHERE c.year=2026;`);
  const related = await vaOrdinaryGuards(repo, writes);
  assert.equal(related.length, current.length * 2);
  const args = related.flatMap((s) => s.args ?? []);
  assert.ok(args.some((arg) => typeof arg === 'string' && arg.startsWith('previous-')));
  assert.ok(!args.some((arg) => typeof arg === 'string' && arg.startsWith('historic-')));
  repo.db.exec('DELETE FROM va_election_history; DELETE FROM va_campaigns');
  assert.deepEqual(await vaOrdinaryGuards(repo, writes), [], 'sin VA no se recorren calendarios históricos');
});

test('VA: dos rondas independientes, fechas únicas, cupos y confirmación de todo el saldo', async () => {
  const repo = await setup();
  close(repo);
  await mutate(repo, vaAdmin, { action: 'start' });
  await assert.rejects(mutate(repo, p2, { action: 'choose', dates: [d1] }), /turno/);
  await assert.rejects(mutate(repo, p1, { action: 'choose', dates: [d1, d2] }), /exactamente un día/);
  await mutate(repo, p1, { action: 'choose', dates: [d1] });
  await assert.rejects(mutate(repo, p2, { action: 'choose', dates: [d1] }), /completo/);
  await mutate(repo, p2, { action: 'choose', dates: [d2] });
  assert.equal((await vaElectionView(repo, p1, 2026)).state?.round, 2);
  const round2 = await vaElectionView(repo, vaAdmin, 2026);
  assert.deepEqual(round2.state?.queue, ['A-1']);
  await assert.rejects(mutate(repo, p1, { action: 'choose', dates: [d1] }), /ya está elegido/);
  const final = await mutate(repo, p1, { action: 'choose', dates: [d3] });
  assert.equal(final.state?.status, 'completed');
  assert.equal(final.state?.people.find((p) => p.id === 'A-1')?.balance, 0);
  assert.equal((await repo.all('SELECT * FROM awards')).length, 0, 'VA no escribe adjudicaciones ordinarias');
  assert.equal((await repo.all("SELECT * FROM audit WHERE action='va_election'")).length, 5);
});

test('VA: listas privadas, orden de preferencia, aplicación inmediata y espera sin navegador', async () => {
  const repo = await setup();
  const start = new Date('2026-10-28T10:00:00Z');
  await mutate(repo, p1, { action: 'preferences', dates: [d2, d1, d3], mode: 'immediate', waitMinutes: 0 });
  await mutate(repo, p2, { action: 'preferences', dates: [d2, d1], mode: 'after_wait', waitMinutes: 10 });
  const publicView = await vaElectionView(repo, { id: null, role: 'viewer', teams: [] }, 2026);
  assert.equal(publicView.preference, null);
  assert.equal(publicView.census, undefined);
  assert.ok(publicView.state?.people.every((p) => p.label === '' && p.days === null && p.balance === null));
  assert.ok(!JSON.stringify(publicView).includes('after_wait'));
  close(repo);
  let view = await mutate(repo, vaAdmin, { action: 'start' }, start);
  assert.deepEqual(
    view.state?.choices.map((c) => c.date),
    [d2],
  );
  assert.equal(view.state?.turn, 'A-2');
  assert.equal((await advanceVaElections(repo, new Date('2026-10-28T10:09:59Z'))).applied, 0);
  assert.equal((await advanceVaElections(repo, new Date('2026-10-28T10:10:00Z'))).applied, 1);
  view = await vaElectionView(repo, vaAdmin, 2026);
  assert.equal(view.state?.choices.find((c) => c.round === 2)?.date, d3);
  assert.equal(view.state?.status, 'completed');
});

test('VA: pause conserva la espera, aplazar y saltar requieren administración y motivo', async () => {
  const repo = await setup();
  close(repo);
  await mutate(repo, p1, { action: 'preferences', dates: [d1], mode: 'after_wait', waitMinutes: 10 });
  await mutate(repo, vaAdmin, { action: 'start' }, new Date('2026-10-28T10:00:00Z'));
  await assert.rejects(mutate(repo, p1, { action: 'pause' }), /administrador/);
  await mutate(repo, vaAdmin, { action: 'pause' }, new Date('2026-10-28T10:05:00Z'));
  assert.equal((await advanceVaElections(repo, new Date('2026-10-28T11:00:00Z'))).applied, 0);
  await mutate(repo, vaAdmin, { action: 'resume' }, new Date('2026-10-28T11:00:00Z'));
  assert.equal((await advanceVaElections(repo, new Date('2026-10-28T11:04:59Z'))).applied, 0);
  await assert.rejects(mutate(repo, vaAdmin, { action: 'skip' }), /motivo/);
  const deferred = await mutate(
    repo,
    vaAdmin,
    { action: 'defer', personId: 'A-1', targetId: 'A-2', reason: 'Elección conjunta' },
    new Date('2026-10-28T11:04:59Z'),
  );
  assert.deepEqual(deferred.state?.queue, ['A-2', 'A-1']);
});

test('VA: segunda ronda agota el saldo, sin parciales manuales, delegados ni automáticos', async () => {
  const repo = await setup();
  // Three days of entitlement, but only two automatic preferences for round 2.
  repo.db.exec("UPDATE people SET seniority='1996-01-01' WHERE id='A-1'");
  const body = { action: 'preview', people: ['A-1'], source };
  const preview = await importVaElection(repo, vaAdmin, 2026, body);
  await importVaElection(repo, vaAdmin, 2026, { ...body, action: 'apply', reviewToken: preview.reviewToken });
  await mutate(repo, p1, { action: 'preferences', dates: [d1, d3], mode: 'immediate' });
  close(repo);
  await mutate(repo, vaAdmin, { action: 'start' });
  const second = await vaElectionView(repo, vaAdmin, 2026);
  assert.equal(second.state?.status, 'running');
  assert.equal(second.state?.choices.length, 1);
  await assert.rejects(mutate(repo, p1, { action: 'choose', dates: [d3] }), /todos los días de tu saldo/);
  // Old clients cannot bypass the rule with the removed partial-acceptance flag.
  const legacyChoice = { action: 'choose', personId: 'A-1', dates: [d3], acceptUnused: true };
  for (const actor of [p1, vaAdmin, admin])
    await assert.rejects(mutate(repo, actor, legacyChoice), /todos los días de tu saldo/);
  const unchanged = await vaElectionView(repo, vaAdmin, 2026);
  assert.equal(unchanged.version, second.version);
  assert.deepEqual(unchanged.state, second.state);
  const final = await mutate(repo, p1, { action: 'choose', dates: [d2, d3] });
  assert.equal(final.state?.status, 'completed');
  assert.equal(final.state?.people[0].balance, 0);
  // Reconstruction uses the same exact-count rule; failures leave its draft untouched.
  await mutate(repo, vaAdmin, { action: 'reconstruct_start' });
  const draft = await mutate(repo, vaAdmin, { action: 'reconstruct_step', personId: 'A-1', dates: [d1] });
  assert.equal(draft.state?.round, 2);
  const legacyStep = { ...legacyChoice, action: 'reconstruct_step' };
  await assert.rejects(mutate(repo, vaAdmin, legacyStep), /todos los días de tu saldo/);
  assert.deepEqual((await vaElectionView(repo, vaAdmin, 2026)).state, draft.state);
  const reconstructed = await mutate(repo, vaAdmin, { action: 'reconstruct_step', personId: 'A-1', dates: [d2, d3] });
  assert.equal(reconstructed.state?.status, 'completed');
  assert.equal(reconstructed.state?.people[0].balance, 0);
  await mutate(repo, vaAdmin, { action: 'reconstruct_cancel' });
});

test('VA: rechaza identidades ajenas, versiones antiguas y actualizaciones concurrentes sin aplicar nada', async () => {
  const repo = await setup();
  close(repo);
  const view = await mutate(repo, vaAdmin, { action: 'start' });
  await assert.rejects(mutate(repo, p2, { action: 'choose', personId: 'A-1', dates: [d1] }), /Solo puedes/);
  await assert.rejects(
    mutateVaElection(repo, p1, 2026, { action: 'choose', dates: [d1], version: view.version - 1 }),
    /cambió/,
  );
  // Inject a quota correction between reads and the transactional write.
  const batch = repo.batch.bind(repo);
  let intercept = true;
  repo.batch = async (ops) => {
    if (intercept && ops.some((o) => o.sql.startsWith('UPDATE va_campaigns'))) {
      intercept = false;
      repo.db.exec('UPDATE va_quota_sources SET version=version+1');
    }
    return batch(ops);
  };
  await assert.rejects(mutate(repo, p1, { action: 'choose', dates: [d1] }), /cambiaron/);
  assert.equal((await vaElectionView(repo, p1, 2026)).state?.choices.length, 0);
});

test('VA: una corrección de cupos no invalida elecciones ya confirmadas', async () => {
  const repo = await setup();
  close(repo);
  await mutate(repo, vaAdmin, { action: 'start' });
  await mutate(repo, p1, { action: 'choose', dates: [d1] });
  const body = { action: 'preview', year: 2026, source, days: { [d2]: 1, [d3]: 1 } };
  const report = await loadVaQuotas(repo, vaAdmin, body);
  await assert.rejects(
    loadVaQuotas(repo, vaAdmin, { ...body, action: 'apply', reviewToken: report.reviewToken }),
    /calendario cambió/,
  );
  assert.equal((await vaElectionView(repo, p1, 2026)).quotas?.[d1], 1);
});

test('VA: ordinarias y VA se protegen en ambos sentidos dentro de la transacción', async () => {
  const repo = await setup();
  close(repo);
  const campaign = (await repo.all("SELECT * FROM campaigns WHERE team_id='A'"))[0];
  const member = (
    await repo.all("SELECT * FROM campaign_members WHERE campaign_id=? AND person_id='A-1'", [campaign.id])
  )[0];
  const loaded = await new Service(repo, admin).view(campaign.id);
  const cycle = loaded.result.cycles[0];
  const days = { [cycle.date]: 1, [cycle.end]: 1, [d3]: 1 };
  const body = { action: 'preview', year: 2026, source, days };
  const q = await loadVaQuotas(repo, vaAdmin, body);
  await loadVaQuotas(repo, vaAdmin, { ...body, action: 'apply', reviewToken: q.reviewToken });
  const award: Statement = {
    sql: 'INSERT INTO awards(id,campaign_id,member_id,cycle_date) VALUES(?,?,?,?)',
    args: ['test-award', campaign.id, member.id, cycle.date],
  };
  await repo.batch([award]);
  await mutate(repo, vaAdmin, { action: 'start' });
  await assert.rejects(mutate(repo, p1, { action: 'choose', dates: [cycle.end] }), /ordinarias/);
  repo.db.exec("DELETE FROM awards WHERE id='test-award'");
  await mutate(repo, p1, { action: 'choose', dates: [cycle.end] });
  await assert.rejects(repo.batch([award, ...(await vaOrdinaryGuards(repo, [award]))]), /va_ordinary_overlap/);
  await assert.rejects(new Service(repo, admin).commit([award]), /días de VA ya elegidos/);
  assert.equal((await repo.all('SELECT * FROM awards')).length, 0);
});

test('VA: copia de seguridad conserva campaña, preferencias y decisiones', async () => {
  const repo = await setup();
  await mutate(repo, p1, { action: 'preferences', dates: [d1], mode: 'manual' });
  const service = new Service(repo, admin),
    backup = await service.backup();
  assert.equal(backup.payload.tables.va_campaigns.length, 1);
  const revision = (await repo.all("SELECT revision FROM app_state WHERE id='main'"))[0].revision;
  await service.restore(backup, revision);
  assert.deepEqual((await vaElectionView(repo, p1, 2026)).preference?.dates, [d1]);
});

test('VA: los grupos aplazados admiten como máximo tres personas', async () => {
  const repo = await setup();
  repo.db.exec(
    "UPDATE people SET controller_number=3 WHERE id='A-3'; UPDATE people SET controller_number=4 WHERE id='A-4'",
  );
  const body = { action: 'preview', people: ['A-1', 'A-2', 'A-3', 'A-4'], source };
  const preview = await importVaElection(repo, vaAdmin, 2026, body);
  await importVaElection(repo, vaAdmin, 2026, { ...body, action: 'apply', reviewToken: preview.reviewToken });
  close(repo);
  await mutate(repo, vaAdmin, { action: 'start' });
  await mutate(repo, vaAdmin, { action: 'defer', personId: 'A-1', targetId: 'A-4', reason: 'Grupo' });
  await mutate(repo, vaAdmin, { action: 'defer', personId: 'A-2', targetId: 'A-4', reason: 'Grupo' });
  await assert.rejects(
    mutate(repo, vaAdmin, { action: 'defer', personId: 'A-3', targetId: 'A-4', reason: 'Grupo' }),
    /máximo tres/,
  );
  assert.deepEqual((await vaElectionView(repo, vaAdmin, 2026)).state?.queue, ['A-3', 'A-4', 'A-2', 'A-1']);
});

test('VA: no acepta modos o esperas de preferencias de tipos incorrectos', async () => {
  const repo = await setup();
  await assert.rejects(mutate(repo, p1, { action: 'preferences', dates: [d1], mode: ['manual'] }), /Modo/);
  await assert.rejects(
    mutate(repo, p1, { action: 'preferences', dates: [d1], mode: 'after_wait', waitMinutes: '10' }),
    /espera/,
  );
});

test('VA: usa el nick de la campaña, aunque la ficha maestra conserve un código interno', async () => {
  const repo = await setup();
  repo.db.exec(
    "UPDATE people SET code='internal-id' WHERE id='A-1'; UPDATE campaign_members SET code='ALIAS',label='Nombre visible' WHERE person_id='A-1'",
  );
  const body = { action: 'preview', people: ['A-1'], source };
  const preview = await importVaElection(repo, vaAdmin, 2026, body);
  assert.equal(preview.people[0].code, 'ALIAS');
  assert.equal(preview.people[0].label, 'Nombre visible');
  await importVaElection(repo, vaAdmin, 2026, { ...body, action: 'apply', reviewToken: preview.reviewToken });
  assert.equal((await vaElectionView(repo, p1, 2026)).state?.people[0].code, 'ALIAS');
});

test('VA: protege también el ciclo ordinario de diciembre que termina en enero del siguiente ejercicio', async () => {
  const repo = await setup(),
    service = new Service(repo, admin);
  await service.createCampaigns(2027, 2026);
  repo.db.exec("UPDATE people SET controller_number=11 WHERE id='C-1'");
  const census = { action: 'preview', people: ['C-1'], source };
  const review = await importVaElection(repo, vaAdmin, 2027, census);
  await importVaElection(repo, vaAdmin, 2027, { ...census, action: 'apply', reviewToken: review.reviewToken });
  const quotas = { action: 'preview', year: 2027, source, days: { '2027-01-01': 1 } };
  const qr = await loadVaQuotas(repo, vaAdmin, quotas);
  await loadVaQuotas(repo, vaAdmin, { ...quotas, action: 'apply', reviewToken: qr.reviewToken });
  const c = (await repo.all("SELECT id FROM campaigns WHERE year=2026 AND team_id='C' AND scope_key='live'"))[0];
  const member = (await repo.all("SELECT id FROM campaign_members WHERE campaign_id=? AND person_id='C-1'", [c.id]))[0];
  const cycle = (await service.view(c.id)).result.cycles.at(-1);
  assert.equal(cycle.end, '2027-01-01');
  const award: Statement = {
    sql: 'INSERT INTO awards(id,campaign_id,member_id,cycle_date) VALUES(?,?,?,?)',
    args: ['year-boundary', c.id, member.id, cycle.date],
  };
  await repo.batch([award]);
  close(repo);
  const change = async (body: Parameters<typeof mutateVaElection>[3]) =>
    mutateVaElection(repo, vaAdmin, 2027, { ...body, version: (await vaElectionView(repo, vaAdmin, 2027)).version });
  await change({ action: 'start' });
  await assert.rejects(change({ action: 'choose', personId: 'C-1', dates: ['2027-01-01'] }), /ordinarias/);
  repo.db.exec("DELETE FROM awards WHERE id='year-boundary'");
  await change({ action: 'choose', personId: 'C-1', dates: ['2027-01-01'] });
  await assert.rejects(service.commit([award]), /días de VA ya elegidos/);
});

test('VA: undo y redo cruzan la frontera de ronda y conservan las preferencias posteriores', async () => {
  const repo = await setup();
  close(repo);
  await mutate(repo, vaAdmin, { action: 'start' });
  await mutate(repo, p1, { action: 'choose', dates: [d1] });
  await mutate(repo, p2, { action: 'choose', dates: [d2] });
  assert.equal((await vaElectionView(repo, vaAdmin, 2026)).state?.round, 2);
  await mutate(repo, p1, { action: 'preferences', dates: [d3], mode: 'manual' });
  let v = await mutate(repo, vaAdmin, { action: 'undo' });
  assert.equal(v.state?.round, 1);
  assert.equal(v.state?.turn, 'A-2');
  assert.equal(v.state?.choices.length, 1);
  assert.equal(v.state?.automaticPaused, true);
  assert.deepEqual((await vaElectionView(repo, p1, 2026)).preference?.dates, [d3]);
  v = await mutate(repo, vaAdmin, { action: 'redo' });
  assert.equal(v.state?.round, 2);
  assert.equal(v.state?.turn, 'A-1');
  assert.equal(v.state?.choices.length, 2);
  await mutate(repo, vaAdmin, { action: 'undo' });
  await mutate(repo, p2, { action: 'choose', dates: [d3] });
  await assert.rejects(mutate(repo, vaAdmin, { action: 'redo' }), /No hay cambios/);
  await mutate(repo, p1, { action: 'choose', dates: [d2] });
  v = await mutate(repo, vaAdmin, { action: 'undo' });
  assert.equal(v.state?.status, 'running');
  assert.equal(v.state?.round, 2);
  assert.equal(v.state?.turn, 'A-1');
});

test('VA: deshacer revierte también los automatismos derivados y no los dispara al consultar', async () => {
  const repo = await setup();
  await mutate(repo, p2, { action: 'preferences', dates: [d2], mode: 'immediate' });
  close(repo);
  await mutate(repo, vaAdmin, { action: 'start' });
  await mutate(repo, p1, { action: 'choose', dates: [d1] });
  let v = await mutate(repo, vaAdmin, { action: 'undo' });
  assert.equal(v.state?.choices.length, 0);
  assert.equal(v.state?.turn, 'A-1');
  const revision = v.version;
  v = await mutate(repo, p2, { action: 'advance' });
  assert.equal(v.version, revision);
  assert.equal(v.state?.choices.length, 0);
  v = await mutate(repo, vaAdmin, { action: 'redo' });
  assert.equal(v.state?.choices.length, 2);
  assert.equal(v.state?.round, 2);
  assert.equal(v.state?.automaticPaused, true);
});

test('VA: rehacer no restaura adjudicaciones que ya no caben en los cupos actuales', async () => {
  const repo = await setup();
  close(repo);
  await mutate(repo, vaAdmin, { action: 'start' });
  await mutate(repo, p1, { action: 'choose', dates: [d1] });
  await mutate(repo, vaAdmin, { action: 'undo' });
  const body = { action: 'preview', year: 2026, source, days: { [d1]: 0, [d2]: 1, [d3]: 1 } };
  const preview = await loadVaQuotas(repo, vaAdmin, body);
  await loadVaQuotas(repo, vaAdmin, { ...body, action: 'apply', reviewToken: preview.reviewToken });
  await assert.rejects(mutate(repo, vaAdmin, { action: 'redo' }), /cupo suficiente/);
  const v = await vaElectionView(repo, vaAdmin, 2026);
  assert.equal(v.state?.choices.length, 0);
  assert.equal(v.control?.canRedo, true);
});

test('VA: reconstrucción privada, pasos reversibles, aplicación y undo de la reconstrucción', async () => {
  const repo = await setup();
  close(repo);
  await mutate(repo, vaAdmin, { action: 'start' });
  await mutate(repo, p1, { action: 'choose', dates: [d1] });
  await mutate(repo, p2, { action: 'choose', dates: [d2] });
  const original = (await vaElectionView(repo, vaAdmin, 2026)).state?.choices;
  let adminView = await mutate(repo, vaAdmin, { action: 'reconstruct_start' });
  assert.equal(adminView.state?.choices.length, 0);
  const publicView = await vaElectionView(repo, p1, 2026);
  assert.deepEqual(publicView.state?.choices, original);
  assert.equal(publicView.control, null);
  await assert.rejects(mutate(repo, p1, { action: 'choose', dates: [d3] }), /reconstruye/);
  await mutate(repo, vaAdmin, { action: 'reconstruct_step', personId: 'A-1', dates: [d3] });
  await mutate(repo, vaAdmin, { action: 'reconstruct_back' });
  assert.equal((await vaElectionView(repo, vaAdmin, 2026)).state?.choices.length, 0);
  await mutate(repo, vaAdmin, { action: 'reconstruct_step', personId: 'A-1', dates: [d3] });
  await mutate(repo, vaAdmin, { action: 'reconstruct_step', personId: 'A-2', dates: [d2] });
  adminView = await mutate(repo, vaAdmin, { action: 'reconstruct_finish' });
  assert.equal(adminView.reconstructing, false);
  assert.equal(adminView.state?.round, 2);
  assert.deepEqual(
    adminView.state?.choices.map((c) => c.date),
    [d3, d2],
  );
  const restored = await mutate(repo, vaAdmin, { action: 'undo' });
  assert.deepEqual(restored.state?.choices, original);
  await mutate(repo, vaAdmin, { action: 'reconstruct_start' });
  const canceled = await mutate(repo, vaAdmin, { action: 'reconstruct_cancel' });
  assert.deepEqual(canceled.state?.choices, original);
  assert.equal(canceled.reconstructing, false);
});

test('VA: TCA, jefes de sala y pasillo se dan de alta y eligen sin equipo ni campaña ordinaria propia', async () => {
  const repo = await setup();
  const beforeTeams = (await repo.all('SELECT id FROM teams')).length;
  const beforeCampaigns = (await repo.all('SELECT id FROM campaigns')).length;
  const entries = (['tca', 'jefe_sala', 'pasillo'] as const).map((category, i) => ({
    code: 'EXT' + i,
    label: 'Ficticio ' + category,
    seniority: '2000-01-01',
    employeeNumber: 9900 + i,
    category,
  }));
  const body = { action: 'preview', entries, source };
  await assert.rejects(importVaExternal(repo, p1, body), /administrador/);
  const preview = await importVaExternal(repo, vaAdmin, body);
  const legacy = {
    ...body,
    entries: entries.map(({ employeeNumber, ...entry }) => ({ ...entry, controllerNumber: employeeNumber })),
  };
  assert.equal((await importVaExternal(repo, vaAdmin, legacy)).reviewToken, preview.reviewToken);
  await assert.rejects(
    importVaExternal(repo, vaAdmin, {
      ...body,
      entries: [{ ...entries[0], controllerNumber: entries[0].employeeNumber + 1 }],
    }),
    /no coinciden/,
  );
  await assert.rejects(importVaExternal(repo, vaAdmin, { ...body, action: 'apply' }), /Revisa/);
  await importVaExternal(repo, vaAdmin, { ...body, action: 'apply', reviewToken: preview.reviewToken });
  // Only the reserved team va appears; no ordinary team or campaign is created.
  assert.equal((await repo.all("SELECT id FROM teams WHERE kind='ordinary'")).length, beforeTeams);
  assert.deepEqual((await repo.all("SELECT id,team_id FROM people WHERE team_id='va'")).length, body.entries.length);
  assert.equal((await repo.all('SELECT id FROM campaigns')).length, beforeCampaigns);
  const census = await vaCensus(repo, vaAdmin);
  assert.equal(census.people.filter((p) => p.team === '').length, 3);
  const id = preview.rows[0].id;
  await vaLinkAccount(repo, vaAdmin, { personId: id, subject: 'externo@sites.test', accountVersion: 0 });
  const external: Principal = {
    id: 'chatgpt:external',
    emailKey: 'chatgpt-email:externo@sites.test',
    role: 'viewer',
    teams: [],
  };
  assert.equal((await vaVisibility(repo, external)).entry, true);
  assert.equal((await myVa(repo, external)).me?.code, 'EXT0');
  const order = { action: 'preview', people: [id, 'A-1', 'A-2'], source };
  const review = await importVaElection(repo, vaAdmin, 2026, order);
  await importVaElection(repo, vaAdmin, 2026, { ...order, action: 'apply', reviewToken: review.reviewToken });
  close(repo);
  await mutate(repo, vaAdmin, { action: 'start' });
  const frozenMe = await myVa(repo, external);
  repo.db.exec(`UPDATE people SET seniority='2025-01-01',active=0 WHERE id='${id}'`);
  assert.deepEqual(await myVa(repo, external), frozenMe);
  assert.equal((await vaVisibility(repo, external)).entry, true);
  const elected = await mutate(repo, external, { action: 'choose', dates: [d1] });
  assert.equal(elected.state?.choices[0].personId, id);
  await assert.rejects(
    vaLinkAccount(repo, vaAdmin, { personId: 'A-1', subject: 'externo@sites.test', accountVersion: 1 }),
    /ya está vinculada/,
  );
  const backup = await new Service(repo, admin).backup();
  const revision = (await repo.all("SELECT revision FROM app_state WHERE id='main'"))[0].revision;
  await new Service(repo, admin).restore(backup, revision);
  assert.equal((await vaElectionView(repo, external, 2026)).me, id);
});

test('VA: historial y pasos se guardan comprimidos y los datos anteriores en claro siguen funcionando', async () => {
  const repo = await setup();
  close(repo);
  await mutate(repo, vaAdmin, { action: 'start' });
  await mutate(repo, p1, { action: 'choose', dates: [d1] });
  const rows = repo.db.prepare('SELECT before_json,after_json FROM va_election_history').all() as {
    before_json: string;
    after_json: string;
  }[];
  assert.ok(rows.length && rows.every((r) => r.before_json.startsWith('gz1:') && r.after_json.startsWith('gz1:')));
  // Legacy rows written before compression stay valid for undo/redo.
  const plain = (stored: string) => decodePayload(stored);
  for (const r of rows)
    repo.db
      .prepare('UPDATE va_election_history SET before_json=?,after_json=? WHERE before_json=?')
      .run(plain(r.before_json), plain(r.after_json), r.before_json);
  let v = await mutate(repo, vaAdmin, { action: 'undo' });
  assert.equal(v.state?.choices.length, 0);
  v = await mutate(repo, vaAdmin, { action: 'redo' });
  assert.deepEqual(
    v.state?.choices.map((c) => c.date),
    [d1],
  );
  // A reconstruction mixing a legacy plain step with a new compressed one.
  await mutate(repo, vaAdmin, { action: 'reconstruct_start' });
  await mutate(repo, vaAdmin, { action: 'reconstruct_step', personId: 'A-1', dates: [d3] });
  const [{ steps_json }] = repo.db.prepare('SELECT steps_json FROM va_reconstructions').all() as {
    steps_json: string;
  }[];
  const steps = JSON.parse(steps_json) as string[];
  assert.ok(steps[0].startsWith('gz1:'));
  repo.db.prepare('UPDATE va_reconstructions SET steps_json=?').run(JSON.stringify([plain(steps[0])]));
  await mutate(repo, vaAdmin, { action: 'reconstruct_step', personId: 'A-2', dates: [d2] });
  await mutate(repo, vaAdmin, { action: 'reconstruct_back' });
  assert.deepEqual(
    (await vaElectionView(repo, vaAdmin, 2026)).state?.choices.map((c) => c.date),
    [d3],
  );
  await mutate(repo, vaAdmin, { action: 'reconstruct_back' });
  assert.equal((await vaElectionView(repo, vaAdmin, 2026)).state?.choices.length, 0);
});

test('payload-codec: ida y vuelta exacta y paso directo de JSON sin prefijo', () => {
  const json = JSON.stringify({ a: [1, null, 'ñ'], b: { c: true } });
  assert.equal(decodePayload(encodePayload(json)), json);
  assert.equal(decodePayload(json), json);
});
