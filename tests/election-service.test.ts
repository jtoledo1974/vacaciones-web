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


test('Criterios 1.1 p.2: la elección guarda seis solicitudes de origen, que sobreviven una permuta posterior',async()=>{
 const {s,cid,d}=await setup(),[a,b]=d.members,dates=d.result.cycles.map((c:any)=>c.date);
 await act(s,cid,start(d));
 let next=await act(s,cid,{action:'choose',memberId:a.id,dates:[dates[0]]});
 assert.equal(next.requests.length,1);
 assert.equal(next.requests[0].cycle_date,dates[0]);
 await act(s,cid,{action:'pause'});
 next=await s.view(cid);
 next=await s.mutate(cid,{action:'delete_award',id:next.awards[0].id,version:next.campaign.version});
 assert.equal(next.awards.length,0);
 assert.equal(next.requests.length,1);
 assert.equal(next.result.ordering.find((p:any)=>p.id===a.id).score,d.result.cycles[0].score);
 next=await s.mutate(cid,{action:'award',memberId:a.id,date:dates[1],version:next.campaign.version});
 assert.equal(next.awards[0].cycle_date,dates[1]);
 assert.equal(next.requests[0].cycle_date,dates[0]);
});
test('Criterios 1.1 p.2: turno conjunto: servidor confirma todas las selecciones y solicitudes o ninguna',async()=>{
 const {s,cid,d}=await setup(),[a,b,c]=d.members,dates=d.result.cycles.map((c:any)=>c.date);
 await act(s,cid,{...start(d),jointGroups:[[a.id,c.id]]});
 let next=await s.view(cid);
 assert.equal(next.election.turn.memberId,b.id);
 next=await act(s,cid,{action:'choose',memberId:b.id,dates:[dates[0]]});
 assert.deepEqual(next.election.turn.participants,[a.id,c.id]);
 await assert.rejects(act(s,cid,{action:'choose_joint',entries:[{member_id:a.id,dates:[dates[1]]}]}),/todos sus participantes/);
 assert.equal((await s.view(cid)).awards.length,1);
 next=await act(s,cid,{action:'choose_joint',entries:[{member_id:a.id,dates:[dates[1]]},{member_id:c.id,dates:[dates[2]]}]});
 assert.equal(next.awards.length,3);
 assert.equal(next.requests.length,3);
 next=await act(s,cid,{action:'election_undo',historyId:next.election.undo});
 assert.equal(next.awards.length,1);
 assert.equal(next.requests.length,1);
});

test('empate pendiente bloquea elección, aplazamiento y automatismos; sorteo externo de tres se guarda y rota',async()=>{
 const {s,cid,d,person,repo}=await setup(),ids=d.members.map((m:any)=>m.id),date=d.result.cycles[0].date;
 await act(s,cid,{action:'link_account',memberId:ids[0],subject:'person',accountVersion:0});
 await act(s,cid,{action:'preferences',memberId:ids[0],dates:[date],automatic:true});
 let next=await act(s,cid,{...start(d),tieGroups:[ids]});
 assert.equal(next.election.turn.memberId,null);assert.deepEqual(next.election.turn.pendingTie,ids);assert.equal(next.awards.length,0);
 await assert.rejects(act(s,cid,{action:'choose',memberId:ids[0],dates:[date]}),/turno/);
 await assert.rejects(act(s,cid,{action:'defer',memberId:ids[0]}),/turno/);
 await assert.rejects(act(person,cid,{action:'resolve_tie',method:'external',order:ids}),/responsable/);
 await assert.rejects(act(s,cid,{action:'resolve_tie',method:'external',order:[ids[0],ids[0],ids[1]]}),/una vez/);
 const order=[ids[2],ids[1],ids[0]],version=(await s.load(cid)).campaign.version;
 next=await act(s,cid,{action:'resolve_tie',method:'external',order});
 assert.deepEqual(next.election.state.order,order);assert.equal(next.awards.length,0);assert.equal(next.election.state.tieResolutions[0].actor,owner.id);
 assert.deepEqual((await new Service(repo,owner).view(cid)).election.state.tieResolutions,next.election.state.tieResolutions);
 await assert.rejects(s.election().mutate(cid,{action:'resolve_tie',method:'random',version}),/cambió/);
 await assert.rejects(act(s,cid,{action:'resolve_tie',method:'random'}),/pendiente/);
 await act(s,cid,{action:'pause'});await assert.rejects(act(s,cid,start(d)),/orden/);await act(s,cid,{action:'resume'});
 await act(s,cid,{action:'preferences',memberId:ids[0],dates:[date],automatic:false});
 for(let i=0;i<3;i++)next=await act(s,cid,{action:'choose',memberId:order[i],dates:[d.result.cycles[i].date]});
 assert.equal(next.election.turn.round,2);assert.equal(next.election.turn.memberId,order[1]);
 const publicView:any=await new Service(repo,{id:null,role:'viewer',teams:[]}).view(cid);assert.equal(publicView.election.state.tieResolutions[0].actor,undefined);
});

test('sorteo aleatorio solo alcanza al grupo actual y no permite repetirlo',async()=>{
 const {s,cid,d}=await setup(),ids=d.members.map((m:any)=>m.id);
 let next=await act(s,cid,{...start(d),tieGroups:[[ids[1],ids[2]]]});
 assert.equal(next.election.turn.memberId,ids[0]);await assert.rejects(act(s,cid,{action:'resolve_tie',method:'random'}),/pendiente/);
 next=await act(s,cid,{action:'choose',memberId:ids[0],dates:[d.result.cycles[0].date]});
 next=await act(s,cid,{action:'resolve_tie',method:'random'});
 assert.equal(next.election.state.order[0],ids[0]);assert.deepEqual([...next.election.state.tieResolutions[0].order].sort(),ids.slice(1).sort());assert.equal(next.election.state.tieResolutions[0].method,'random');
 await assert.rejects(act(s,cid,{action:'resolve_tie',method:'random'}),/pendiente/);
});

test('puntuaciones guardadas detectan empates sin depender del cliente y rechazan orden incorrecto o datos ausentes',async()=>{
 const {s,cid,d}=await setup(),ids=d.members.map((m:any)=>m.id);
 let next=await s.mutate(cid,{action:'config',version:d.campaign.version,config:{...d.config,previousScores:{AA:10,BB:20,CC:20},previousScoresSource:'Histórico ficticio para pruebas'}});
 await assert.rejects(act(s,cid,start(next,[ids[1],ids[0],ids[2]])),/puntuaciones/);
 next=await act(s,cid,start(next));assert.deepEqual(next.election.state.pendingTieGroups,[ids.slice(1)]);
 await act(s,cid,{action:'pause'});next=await s.view(cid);
 next=await s.mutate(cid,{action:'config',version:next.campaign.version,config:{...next.config,previousScores:{AA:10,BB:20}}});
 await assert.rejects(act(s,cid,start(next)),/Faltan puntuaciones/);
});
