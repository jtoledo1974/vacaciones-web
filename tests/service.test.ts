import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { Service, principal } from '../server/service.ts';
import { canWrite, type Principal } from '../server/permissions.ts';
import type { Repository, Statement } from '../server/repository.ts';
class SQLiteRepo implements Repository {
    db: DatabaseSync;
    constructor() { this.db = new DatabaseSync(':memory:'); this.db.exec('PRAGMA foreign_keys=ON;'); for(const migration of readdirSync('drizzle').filter(f=>f.endsWith('.sql')).sort())this.db.exec(readFileSync('drizzle/' + migration, 'utf8')); }
    async all<T = any>(sql: string, args: any[] = []): Promise<T[]> { return this.db.prepare(sql).all(...args) as T[]; }
    async batch(ss: Statement[]) { this.db.exec('BEGIN IMMEDIATE'); try {
        const results = ss.map(s => { const q = this.db.prepare(s.sql); return { results: q.columns().length ? q.all(...(s.args ?? []) as any[]) : (q.run(...(s.args ?? []) as any[]), []) }; });
        this.db.exec('COMMIT');
        return results;
    }
    catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
    } }
}
const superuser: Principal = { id: 'chatgpt:owner', role: 'superadmin', teams: [] };
async function setup() { const repo = new SQLiteRepo(), s = new Service(repo, superuser); await s.init(); const i = await s.list(), cid = i.campaigns.find((c: any) => c.team_id === 'C').id; return { repo, s, cid }; }
test('viewer y anónimo nunca pueden escribir, ni con identificador de otro equipo', async () => { const { repo, s, cid } = await setup(); for (const actor of [{ id: null, role: 'viewer', teams: [] }, { id: 'user', role: 'viewer', teams: ['C'] }]) {
    assert.equal(canWrite(actor as Principal, 'C'), false);
    const d = await s.view(cid);
    await assert.rejects(new Service(repo, actor as Principal).mutate(cid, { action: 'request', version: d.campaign.version, memberId: d.members[0].id, slot: 1, date: d.result.cycles[0].date }), /permiso/);
} });
test('team_admin no escribe en otro equipo, incluso con miembro ajeno', async () => { const { repo, s, cid } = await setup(); const teamA = new Service(repo, { id: 'chatgpt:a', role: 'team_admin', teams: ['A'] }); const d = await s.view(cid); await assert.rejects(teamA.mutate(cid, { version: d.campaign.version, action: 'request', memberId: d.members[0].id, slot: 1, date: d.result.cycles[0].date }), /permiso/); const teamC = new Service(repo, { id: 'chatgpt:c', role: 'team_admin', teams: ['C'] }); await assert.rejects(teamC.mutate(cid, { version: 1, action: 'request', memberId: 'foreign', slot: 1, date: d.result.cycles[0].date }), /ajeno/); await assert.rejects(teamC.mutate(cid, { version: 1, action: 'config', config: d.config }), /superadministrador/); });
test('solicitudes persistentes y conflicto de ediciones, sin perder cambios', async () => { const { repo, s, cid } = await setup(); const d = await s.view(cid); const b = { action: 'request', version: d.campaign.version, memberId: d.members[0].id, slot: 1, date: d.result.cycles[0].date }; await s.mutate(cid, b); await assert.rejects(s.mutate(cid, { ...b, date: d.result.cycles[1].date }), /cambió/); const fresh = await new Service(repo, superuser).view(cid); assert.equal(fresh.requests[0].cycle_date, b.date); assert.equal(fresh.campaign.version, 2); });
test('CAS fallida revierte el lote completo', async () => { const { repo, cid } = await setup(); await assert.rejects(repo.batch([{ sql: 'UPDATE campaigns SET version=version+1 WHERE id=? AND version=-1', args: [cid] }, { sql: "INSERT INTO transaction_assertions(id) VALUES(CASE WHEN changes()=1 THEN 'ok' ELSE NULL END)" }, { sql: "UPDATE teams SET name='ERROR' WHERE id='C'" }]), /NOT NULL/); assert.equal((await repo.all("SELECT name FROM teams WHERE id='C'"))[0].name, 'Equipo C'); });
test('revisión archivada inmutable y consulta actual sin antigüedad ni preferencias', async () => { const { repo, s, cid } = await setup(); let d = await s.view(cid); const memberId = d.members[0].id, date = d.result.cycles[0].date; d = await s.mutate(cid, { action: 'request', version: d.campaign.version, memberId, slot: 1, date }); d = await s.mutate(cid, { action: 'award', version: d.campaign.version, memberId, date }); d = await s.mutate(cid, { action: 'calculate', version: d.campaign.version }); d = await s.mutate(cid, { action: 'publish', version: d.campaign.version, runId: d.runs[0].id }); const reader = new Service(repo, { id: null, role: 'viewer', teams: [] }); const pub = await reader.view(cid); assert.equal(pub.awards.length, 1); assert.ok(!('seniority' in pub.members[0])); assert.deepEqual(pub.result.ordering,[]); assert.equal(pub.config, null); d = await s.mutate(cid, { action: 'reopen', version: d.campaign.version }); d = await s.mutate(cid, { action: 'delete_award', version: d.campaign.version, id: d.awards[0].id }); assert.equal((await reader.view(cid)).awards.length, 0); assert.equal((await reader.publishedView(cid))!.awards.length,1); assert.equal(d.awards.length, 0); });
test('campaña nueva no modifica histórico ni copia solicitudes', async () => { const { s, cid } = await setup(); const before = await s.load(cid); await s.createCampaigns(2027, 2026); assert.deepEqual(await s.load(cid), before); assert.equal((await s.list()).campaigns.length, 16); const next = (await s.list()).campaigns.find((c: any) => c.year === 2027 && c.team_id === 'C'); const d = await s.load(next.id); assert.equal(d.requests.length, 0); assert.equal(d.awards.length, 0); assert.equal(d.config.summerStart, '2027-06-01'); });
test('copia completa, rechazo de corrupción y restauración atómica', async () => { const { s, repo, cid } = await setup(); const backup = await s.backup(); const invalid = structuredClone(backup); invalid.payload.tables.teams[0].name = 'alterado'; await assert.rejects(s.restore(invalid, (await s.admin()).revision), /integridad/); let d = await s.view(cid); await s.mutate(cid, { action: 'request', version: d.campaign.version, memberId: d.members[0].id, slot: 1, date: d.result.cycles[0].date }); assert.equal((await s.view(cid)).requests.length, 1); await s.restore(backup, (await s.admin()).revision); assert.equal((await s.view(cid)).requests.length, 0); assert.deepEqual((await s.backup()).payload.tables.campaigns, backup.payload.tables.campaigns); const malformed = structuredClone(backup); malformed.payload.tables.awards = [{ id: 'x', campaign_id: cid, member_id: 'missing', cycle_date: '2026-01-07', version: 1 }]; const sha = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(malformed.payload))); malformed.sha256 = Array.from(new Uint8Array(sha)).map(b => b.toString(16).padStart(2, '0')).join(''); const before = (await s.backup()).payload.tables; await assert.rejects(s.restore(malformed, (await s.admin()).revision)); assert.deepEqual((await s.backup()).payload.tables, before); });
test('identidad, correo autorizado y delegación caducada', async () => { const { repo, s } = await setup(); assert.equal((await principal(repo, null, 'owner@example.test')).role, 'viewer'); assert.equal((await principal(repo, { provider: 'chatgpt', subject: 'owner', email: 'OWNER@example.test',emailVerified:true }, 'owner@example.test')).role, 'superadmin'); await s.configureUser({ subject: 'delegate@example.test', role: 'team_admin', teams: ['C'], version: 0 }); const p = await principal(repo, { provider: 'chatgpt', subject: 'different-uid', email: 'DELEGATE@example.test',emailVerified:true }, 'owner@example.test'); assert.ok(canWrite(p, 'C')); assert.ok(!canWrite(p, 'A')); await repo.batch([{ sql: "UPDATE grants SET expires_at='2000-01-01'" }]); assert.ok(!canWrite(await principal(repo, { provider: 'chatgpt', subject: 'different-uid', email: 'delegate@example.test',emailVerified:true }, ''), 'C')); });
test('cálculo antiguo no puede publicarse tras una edición', async () => { const { s, cid } = await setup(); let d = await s.view(cid); d = await s.mutate(cid, { action: 'calculate', version: d.campaign.version }); const runId = d.runs[0].id; d = await s.mutate(cid, { action: 'request', version: d.campaign.version, memberId: d.members[0].id, slot: 1, date: d.result.cycles[0].date }); await assert.rejects(s.mutate(cid, { action: 'publish', version: d.campaign.version, runId }), /actuales/); });


test('reinicio reversible conserva plantilla, configuración, publicación y otros equipos',async()=>{
 const {s,repo,cid}=await setup();let d=await s.view(cid);const memberId=d.members[0].id,date=d.result.cycles[0].date;
 d=await s.mutate(cid,{action:'request',version:d.campaign.version,memberId,slot:1,date});
 d=await s.mutate(cid,{action:'award',version:d.campaign.version,memberId,date});
 d=await s.mutate(cid,{action:'calculate',version:d.campaign.version});d=await s.mutate(cid,{action:'publish',version:d.campaign.version,runId:d.runs[0].id});d=await s.mutate(cid,{action:'reopen',version:d.campaign.version});
 const baseline=await s.load(cid),other=(await s.list()).campaigns.find(c=>c.team_id==='A'),otherBefore=await s.load(other.id);
 await assert.rejects(s.mutate(cid,{action:'reset_vacations',version:d.campaign.version,confirmation:'A-2026'}),/Confirma/);
 await assert.rejects(new Service(repo,{id:null,role:'viewer',teams:[]}).mutate(cid,{action:'reset_vacations',version:d.campaign.version,confirmation:'C-2026'}),/permiso/);
 d=await s.mutate(cid,{action:'reset_vacations',version:d.campaign.version,confirmation:'C-2026'});assert.equal(d.requests.length,0);assert.equal(d.awards.length,0);assert.equal(d.undo.action,'reset_vacations');assert.deepEqual(d.members,baseline.members);assert.deepEqual(d.config,baseline.config);assert.deepEqual(await s.load(other.id),otherBefore);
 const publicView=await new Service(repo,{id:null,role:'viewer',teams:[]}).view(cid);assert.equal(publicView.awards.length,0);assert.equal((await new Service(repo,{id:null,role:'viewer',teams:[]}).publishedView(cid))!.awards.length,1);assert.equal('undo' in publicView,false);
 const undoId=d.undo.id;d=await s.mutate(cid,{action:'undo_vacations',version:d.campaign.version,undoId});assert.deepEqual(d.requests,baseline.requests);assert.deepEqual(d.awards,baseline.awards);assert.equal(d.undo,null);await assert.rejects(s.mutate(cid,{action:'undo_vacations',version:d.campaign.version,undoId}),/deshacer/);
});
test('deshacer edición y eliminación restaura valores; una operación posterior invalida la opción',async()=>{
 const {s,cid}=await setup();let d=await s.view(cid);const memberId=d.members[0].id,date=d.result.cycles[0].date;
 d=await s.mutate(cid,{action:'request',version:d.campaign.version,memberId,slot:1,date});const initial=d.requests;
 d=await s.mutate(cid,{action:'request',version:d.campaign.version,memberId,slot:1,date:d.result.cycles[1].date});d=await s.mutate(cid,{action:'undo_vacations',version:d.campaign.version,undoId:d.undo.id});assert.deepEqual(d.requests,initial);
 d=await s.mutate(cid,{action:'delete_request',version:d.campaign.version,id:d.requests[0].id});d=await s.mutate(cid,{action:'undo_vacations',version:d.campaign.version,undoId:d.undo.id});assert.deepEqual(d.requests,initial);
 d=await s.mutate(cid,{action:'request',version:d.campaign.version,memberId,slot:1,date:d.result.cycles[1].date});const undoId=d.undo.id;d=await s.mutate(cid,{action:'calculate',version:d.campaign.version});assert.equal(d.undo,null);await assert.rejects(s.mutate(cid,{action:'undo_vacations',version:d.campaign.version,undoId}),/deshacer/);
});
test('undo y redo alternan el reinicio y una edición nueva descarta redo',async()=>{
 const {s,cid}=await setup();let d=await s.view(cid);const memberId=d.members[0].id,date=d.result.cycles[0].date;
 d=await s.mutate(cid,{action:'request',version:d.campaign.version,memberId,slot:1,date});const original=d.requests;
 d=await s.mutate(cid,{action:'reset_vacations',version:d.campaign.version,confirmation:'C-2026'});const stale=d.undo.id;
 d=await s.mutate(cid,{action:'undo_vacations',version:d.campaign.version,undoId:d.undo.id});assert.deepEqual(d.requests,original);assert.ok(d.redo);assert.equal(d.undo,null);
 await assert.rejects(s.mutate(cid,{action:'redo_vacations',version:d.campaign.version,undoId:stale}),/deshacer/);
 d=await s.mutate(cid,{action:'redo_vacations',version:d.campaign.version,undoId:d.redo.id});assert.equal(d.requests.length,0);assert.ok(d.undo);assert.equal(d.redo,null);
 d=await s.mutate(cid,{action:'undo_vacations',version:d.campaign.version,undoId:d.undo.id});assert.deepEqual(d.requests,original);const redoId=d.redo.id;
 d=await s.mutate(cid,{action:'request',version:d.campaign.version,memberId,slot:2,date:d.result.cycles[1].date});assert.equal(d.redo,null);await assert.rejects(s.mutate(cid,{action:'redo_vacations',version:d.campaign.version,undoId:redoId}),/deshacer/);assert.equal(d.requests.length,2);
});




test('roles ChatGPT por correo autenticado, sin heredar permisos entre proveedores',async()=>{
 const {repo,s}=await setup();
 await s.configureUser({provider:'chatgpt',subject:'ADMIN@EXAMPLE.TEST',role:'team_admin',teams:['B'],version:0});
 const verified=await principal(repo,{provider:'chatgpt',subject:'unrelated-opaque-id',email:'admin@example.test',emailVerified:true},'');
 assert.equal(verified.emailKey,'chatgpt-email:admin@example.test');
 assert.ok(canWrite(verified,'B'));
 const fakeFirebase=await principal(repo,{provider:'firebase',subject:'some-uid',email:'admin@example.test',emailVerified:false},'');
 assert.equal(fakeFirebase.role,'viewer');
 assert.equal(fakeFirebase.emailKey,undefined);
 await assert.rejects(s.configureUser({provider:'chatgpt',subject:'not-an-email',role:'team_admin',teams:['B'],version:0}),/válidos/);
});

test('borrar una simulación elimina sus dependencias sin tocar la campaña real y exige superadministrador y versión',async()=>{
 const {s,repo,cid}=await setup();
 const realBefore=await s.load(cid);
 const peopleBefore=(await repo.all<{n:number}>('SELECT COUNT(*) AS n FROM people'))[0].n;
 const created=await s.createSimulation(cid,{name:'Borrado seguro',version:realBefore.campaign.version});
 let d=await s.view(created.id);
 const member=d.members[0],date=d.result.cycles[0].date;
 d=await s.mutate(created.id,{action:'request',version:d.campaign.version,memberId:member.id,slot:1,date});
 d=await s.mutate(created.id,{action:'award',version:d.campaign.version,memberId:member.id,date});
 d=await s.mutate(created.id,{action:'calculate',version:d.campaign.version});
 await repo.batch([
  {sql:'INSERT INTO preferences(member_id,campaign_id,dates_json,automatic,persistent,active) VALUES(?,?,?,?,?,?)',args:[member.id,created.id,JSON.stringify([date]),0,0,1]},
  {sql:'INSERT INTO election_states(campaign_id,json) VALUES(?,?)',args:[created.id,'{}']}
 ]);
 const teamAdmin=new Service(repo,{id:'chatgpt:team-admin',role:'team_admin',teams:['C']});
 await assert.rejects(teamAdmin.deleteSimulation(created.id,{version:d.campaign.version}),/superadministrador/);
 await assert.rejects(s.deleteSimulation(cid,{version:realBefore.campaign.version}),/campaña real/);
 await assert.rejects(s.deleteSimulation(created.id,{version:d.campaign.version-1}),/cambió/);
 assert.equal((await repo.all('SELECT * FROM runs WHERE campaign_id=?',[created.id])).length,1);
 const temporaryPerson=crypto.randomUUID();
 await repo.batch([
  {sql:'INSERT INTO people(id,team_id,code,seniority) VALUES(?,?,?,?)',args:[temporaryPerson,'C','C_SIM_ONLY','']},
  {sql:'INSERT INTO campaign_members(id,campaign_id,person_id,code,seniority) VALUES(?,?,?,?,?)',args:[crypto.randomUUID(),created.id,temporaryPerson,'SIM_ONLY','']}
 ]);
 await s.deleteSimulation(created.id,{version:d.campaign.version});
 for(const table of ['campaigns','parameters','campaign_members','requests','awards','runs','preferences','election_states','audit']){
  const column=table==='campaigns'?'id':'campaign_id';
  assert.equal((await repo.all(`SELECT * FROM ${table} WHERE ${column}=?`,[created.id])).length,0,table);
 }
 assert.equal((await repo.all<{n:number}>('SELECT COUNT(*) AS n FROM people'))[0].n,peopleBefore);
 assert.deepEqual(await s.load(cid),realBefore);
 assert.equal((await s.list()).campaigns.some((c:any)=>c.id===created.id),false);
 assert.equal((await repo.all("SELECT * FROM audit WHERE action='simulation_deleted' AND campaign_id IS NULL")).length,1);
});

test('vista como controlador: solo superadmin, datos de un miembro y campaña real de lectura', async () => {
 const {repo,s,cid}=await setup();
 const {resolveControllerPreview}=await import('../server/controller-preview.ts');
 const d=await s.load(cid),member=d.members[0];
 await assert.rejects(resolveControllerPreview(repo,{id:'cta',role:'viewer',teams:[]},cid,member.code),/superadministrador/);
 await assert.rejects(resolveControllerPreview(repo,superuser,cid,'INEXISTENTE'),/no encontrado/);
 const preview=await resolveControllerPreview(repo,superuser,cid,member.code.toLowerCase());
 assert.equal(preview.writable,false);
 assert.equal(preview.actor.role,'viewer');
 const service=new Service(repo,preview.actor);
 const view=await service.view(cid);
 assert.equal(view.preview.code,member.code);
 assert.equal(view.election.myMemberId,member.id);
 assert.deepEqual(view.election.preferenceMemberIds,[member.id]);
 assert.equal(view.election.canManage,false);
 assert.equal(view.editable,false);
 await assert.rejects(service.election().mutate(cid,{action:'preferences',memberId:member.id,dates:[],version:d.campaign.version}),/no permite guardar/);
});
test('vista como controlador: guarda preferencias propias solo en simulación sin tocar la campaña real', async () => {
 const {repo,s,cid}=await setup();
 const {resolveControllerPreview}=await import('../server/controller-preview.ts');
 const live=await s.load(cid);
 const created=await s.createSimulation(cid,{version:live.campaign.version,name:'Prueba UX',copyPreferences:true});
 const sim=await s.load(created.id),member=sim.members[0],other=sim.members[1];
 const preview=await resolveControllerPreview(repo,superuser,created.id,member.code);
 assert.equal(preview.writable,true);
 const service=new Service(repo,preview.actor);
 const dates=[(await service.view(created.id)).result.cycles[0].date];
 await service.election().mutate(created.id,{action:'preferences',memberId:member.id,dates,version:sim.campaign.version});
 const view=await service.view(created.id);
 assert.deepEqual(view.election.preferences.map((p:any)=>p.member_id),[member.id]);
 assert.deepEqual(view.election.preferences[0].dates,dates);
 assert.equal((await s.load(cid)).campaign.version,live.campaign.version);
 await assert.rejects(service.election().mutate(created.id,{action:'preferences',memberId:other.id,dates,version:view.campaign.version}),/Solo puedes modificar tus propias preferencias/);
});
