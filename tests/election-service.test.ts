import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Service} from '../server/service.ts';
import {SQLiteRepo} from './sqlite-repo.ts';
const owner={id:'chatgpt:owner',role:'superadmin' as const,teams:[]},visitor={id:'chatgpt:person',role:'viewer' as const,teams:[]};
async function setup(){const repo=new SQLiteRepo(),s=new Service(repo,owner);await s.init();const cid=(await s.list()).campaigns.find(c=>c.team_id==='C').id;let d=await s.view(cid);d=await s.mutate(cid,{action:'import_roster',version:d.campaign.version,source:{format:'vacaciones-roster-v1',team:'C',year:2026,copySelections:false,rows:[{code:'AA',label:'Nombre privado A',seniority:''},{code:'BB',label:'Nombre privado B',seniority:''},{code:'CC',label:'Nombre privado C',seniority:''}]}});return {repo,s,cid,d,person:new Service(repo,visitor)};}
async function act(s:Service,cid:string,body:any){await s.election().mutate(cid,{...body,version:(await s.load(cid)).campaign.version});return s.view(cid);}
const start=(d:any,order=d.members.map((m:any)=>m.id))=>({action:'start',order,source:'Orden histórico confirmado por administrador',rulesConfirmed:true,allowDeferral:true});
test('listas propias y administración delegada, con turno y permisos comprobados en servidor',async()=>{
 const {s,cid,d,person}=await setup(),[a,b]=d.members,date=d.result.cycles[0].date;
 await assert.rejects(act(person,cid,{action:'preferences',memberId:a.id,dates:[date],automatic:true}),/vinculada/);
 await act(s,cid,{action:'link_account',memberId:a.id,subject:'person',accountVersion:0});
 await act(person,cid,{action:'preferences',memberId:a.id,dates:[date],automatic:true});
 await assert.rejects(act(person,cid,{action:'preferences',memberId:b.id,dates:[date],automatic:true}),/propias/);
 let result=await act(s,cid,start(d,[b.id,a.id,d.members[2].id]));assert.equal(result.awards.length,0);
 await assert.rejects(act(person,cid,{action:'choose',memberId:a.id,dates:[date]}),/turno/);
 result=await act(s,cid,{action:'choose',memberId:b.id,dates:[date]});assert.equal(result.awards.length,2);assert.ok(result.awards.some((x:any)=>x.member_id===a.id));
 const mine=await person.view(cid);assert.equal(mine.election.preferences.length,1);assert.equal(mine.election.myMemberId,a.id);assert.equal(mine.election.accounts.length,0);assert.equal(mine.editable,false);assert.equal(mine.config,null);
});
test('consulta anónima ve elecciones actuales, baremos y ocupación, sin preferencias o datos personales',async()=>{
 const {repo,s,cid,d}=await setup(),[a,b]=d.members,date=d.result.cycles[0].date;await act(s,cid,{action:'preferences',memberId:b.id,dates:[date],automatic:false});await act(s,cid,start(d));await act(s,cid,{action:'choose',memberId:a.id,dates:[date]});
 const publicView=await new Service(repo,{id:null,role:'viewer',teams:[]}).view(cid);assert.equal(publicView.awards.length,1);assert.equal(publicView.result.cycles[0].occupied,1);assert.ok(Number.isFinite(publicView.result.cycles[0].score));assert.deepEqual(publicView.election.preferences,[]);assert.equal(publicView.election.state.source,undefined);assert.ok(!JSON.stringify(publicView).includes('Nombre privado'));assert.equal(publicView.requests.length,0);
});
test('undo y redo recuperan cola, preferencias y ocupación; una versión obsoleta no pierde datos',async()=>{
 const {s,cid,d}=await setup(),a=d.members[0],date=d.result.cycles[0].date;await act(s,cid,start(d));let next=await act(s,cid,{action:'choose',memberId:a.id,dates:[date]});const before=next.election.state;
 await assert.rejects(s.election().mutate(cid,{action:'choose',memberId:d.members[1].id,dates:[date],version:1}),/cambió/);
 next=await act(s,cid,{action:'election_undo',historyId:next.election.undo});assert.equal(next.awards.length,0);assert.equal(next.election.turn.memberId,a.id);
 next=await act(s,cid,{action:'election_redo',historyId:next.election.redo});assert.equal(next.awards.length,1);assert.deepEqual(next.election.state,before);
});
test('cerrar un equipo bloquea preferencias, elecciones y correcciones y permite seguir consultando',async()=>{
 const {s,cid,d,person}=await setup(),a=d.members[0],date=d.result.cycles[0].date;await act(s,cid,{action:'link_account',memberId:a.id,subject:'person',accountVersion:0});await act(s,cid,start(d));let next=await s.view(cid);next=await s.mutate(cid,{action:'close',version:next.campaign.version});assert.equal(next.election.state.status,'paused');
 await assert.rejects(act(person,cid,{action:'preferences',memberId:a.id,dates:[date],automatic:true}),/cerrada/);await assert.rejects(act(s,cid,{action:'choose',memberId:a.id,dates:[date]}),/cerrada/);await assert.rejects(s.mutate(cid,{action:'delete_award',id:'x',version:next.campaign.version}),/cerrada/);assert.equal((await s.view(cid)).campaign.status,'closed');
});
test('simulaciones repetibles no alteran la campaña real ni se exponen a usuarios',async()=>{
 const {s,cid,d,person}=await setup();await act(s,cid,{action:'link_account',memberId:d.members[0].id,subject:'person',accountVersion:0});const baseline=await s.load(cid);
 const one=await s.createSimulation(cid,{name:'Escenario uno',version:baseline.campaign.version,copyPreferences:true}),two=await s.createSimulation(cid,{name:'Escenario dos',version:baseline.campaign.version});assert.notEqual(one.id,two.id);let sim=await s.view(one.id);assert.equal(sim.awards.length,0);assert.equal(sim.members.length,3);await act(s,one.id,start(sim));sim=await s.view(one.id);await act(s,one.id,{action:'choose',memberId:sim.members[0].id,dates:sim.result.cycles[0].date?[sim.result.cycles[0].date]:[]});
 assert.deepEqual(await s.load(cid),baseline);assert.equal((await s.view(two.id)).awards.length,0);assert.equal((await person.list()).campaigns.some(c=>c.id===one.id),false);await assert.rejects(person.view(one.id),/reservada/);await assert.rejects(person.publishedView(one.id),/reservada/);await assert.rejects(act(person,one.id,{action:'advance'}),/reservada/);
 await s.createCampaigns(2027,2026);assert.equal((await s.list()).campaigns.filter(c=>c.year===2027&&c.scope_key==='live').length,8);
});
test('backup y restauración incluyen listas, cuentas, cola y simulaciones; admiten copias antiguas',async()=>{
 const {s,cid,d}=await setup(),a=d.members[0],date=d.result.cycles[0].date;await act(s,cid,{action:'link_account',memberId:a.id,subject:'person',accountVersion:0});await act(s,cid,{action:'preferences',memberId:a.id,dates:[date],automatic:false});await act(s,cid,start(d));await act(s,cid,{action:'defer',memberId:a.id});const snapshot=await s.backup();
 let current=await s.view(cid);await act(s,cid,{action:'pause'});current=await s.view(cid);await s.mutate(cid,{action:'reset_vacations',confirmation:'C-2026',version:current.campaign.version});await s.restore(snapshot,(await s.admin()).revision);const restored=await s.view(cid);assert.equal(restored.election.state.credits[a.id],1);assert.equal(restored.election.preferences.length,1);assert.equal(restored.election.accounts.length,1);
 const legacy=structuredClone(snapshot);for(const table of ['preferences','election_states','controller_accounts'])delete (legacy.payload.tables as any)[table];for(const c of legacy.payload.tables.campaigns){delete c.scope_key;delete c.simulation_name;}const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(legacy.payload)));legacy.sha256=Array.from(new Uint8Array(hash)).map(b=>b.toString(16).padStart(2,'0')).join('');await s.restore(legacy,(await s.admin()).revision);assert.equal((await s.view(cid)).election.state,null);assert.equal((await s.load(cid)).campaign.scope_key,'live');
});

test('el segundo ciclo se valida contra el primero y las opciones no modifican la campaña',async()=>{
 const {repo,s,cid,d,person}=await setup(),[a,b,c]=d.members,dates=d.result.cycles.map(c=>c.date);await act(s,cid,{action:'link_account',memberId:a.id,subject:'person',accountVersion:0});await act(s,cid,start(d));await act(s,cid,{action:'defer',memberId:a.id});await act(s,cid,{action:'choose',memberId:b.id,dates:[dates[0]]});await act(s,cid,{action:'choose',memberId:c.id,dates:[dates[1]]});const before=await s.load(cid),options=await person.election().options(cid,[dates[0]]);assert.equal(options.available.includes(dates[0]),false);assert.equal(options.available.includes(dates[1]),true);assert.deepEqual(await s.load(cid),before);await assert.rejects(new Service(repo,{id:'chatgpt:other',role:'viewer',teams:[]}).election().options(cid,[dates[0]]),/turno/);
});

