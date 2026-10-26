import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Service} from '../server/service.ts';
import {SQLiteRepo} from './sqlite-repo.ts';
const owner={id:'chatgpt:owner',role:'superadmin' as const,teams:[]},visitor={id:'chatgpt:person',emailKey:'chatgpt-email:person@example.test',role:'viewer' as const,teams:[]};
async function setup(){const repo=new SQLiteRepo(),s=new Service(repo,owner);await s.init();const cid=(await s.list()).campaigns.find(c=>c.team_id==='C').id;let d=await s.view(cid);d=await s.mutate(cid,{action:'import_roster',version:d.campaign.version,source:{format:'vacaciones-roster-v1',team:'C',year:2026,copySelections:false,rows:[{code:'AA',label:'Nombre privado A',seniority:''},{code:'BB',label:'Nombre privado B',seniority:''},{code:'CC',label:'Nombre privado C',seniority:''}]}});d=await s.mutate(cid,{action:'config',version:d.campaign.version,config:{...d.config,previousScores:{AA:10,BB:20,CC:30},previousScoresSource:'Puntuaciones de ensayo verificadas'}});return {repo,s,cid,d,person:new Service(repo,visitor)};}
async function setScores(s:Service,cid:string,scores:Record<string,number>){const d=await s.view(cid);return s.mutate(cid,{action:'config',version:d.campaign.version,config:{...d.config,previousScores:scores,previousScoresSource:'Clasificación ficticia verificada para tests'}});}
// actOne exercises the atomic API operation; act mimics the browser draining pending turns.
async function actOne(s:Service,cid:string,body:any){
 await s.election().mutate(cid,{...body,version:(await s.load(cid)).campaign.version});
 return s.view(cid);
}
async function act(s:Service,cid:string,body:any){
 let next=await actOne(s,cid,body);
 if(!['election_undo','election_redo','pause','link_account','resolve_tie'].includes(body.action))
  for(let step=0;step<100&&next.election.pendingAutomatic;step++)next=await actOne(s,cid,{action:'advance'});
 return next;
}
const start=(d:any,order=d.members.map((m:any)=>m.id))=>({action:'start',order,source:'Orden histórico confirmado por administrador',rulesConfirmed:true,allowDeferral:true});
test('listas propias y administración delegada, con turno y permisos comprobados en servidor',async()=>{
 const {s,cid,d,person}=await setup(),[a,b]=d.members,date=d.result.cycles[0].date;
 await assert.rejects(act(person,cid,{action:'preferences',memberId:a.id,dates:[date],automatic:true}),/vinculada/);
 await act(s,cid,{action:'link_account',memberId:a.id,subject:'person@example.test',accountVersion:0});
 await act(person,cid,{action:'preferences',memberId:a.id,dates:[date],automatic:true});
 await assert.rejects(act(person,cid,{action:'preferences',memberId:b.id,dates:[date],automatic:true}),/propias/);
 await setScores(s,cid,{AA:20,BB:10,CC:30});
 let result=await act(s,cid,start(d,[b.id,a.id,d.members[2].id]));assert.equal(result.awards.length,0);
 await assert.rejects(act(person,cid,{action:'choose',memberId:a.id,dates:[date]}),/turno/);
 result=await act(s,cid,{action:'choose',memberId:b.id,dates:[date]});assert.equal(result.awards.length,2);assert.ok(result.awards.some((x:any)=>x.member_id===a.id));
 const mine=await person.view(cid);assert.equal(mine.election.preferences.length,1);assert.equal(mine.election.myMemberId,a.id);assert.equal(mine.election.accounts.length,0);assert.equal(mine.editable,false);assert.equal(mine.config,null);
});
test('guardar preferencias durante el propio turno adjudica de inmediato sin casilla de autorización',async()=>{
 const {s,cid,d}=await setup(),[a,b]=d.members,date=d.result.cycles[0].date;
 await act(s,cid,start(d));
 const result=await act(s,cid,{action:'preferences',memberId:a.id,dates:[date]});
 assert.deepEqual(result.awards.filter((award:any)=>award.member_id===a.id).map((award:any)=>award.cycle_date),[date]);
 assert.equal(result.election.turn.memberId,b.id);
 assert.equal(result.election.preferences.find((p:any)=>p.member_id===a.id).automatic,true);
});
test('una lista heredada con automatic=false también se aplica sin regrabarla',async()=>{
 const {repo,s,cid,d}=await setup(),a=d.members[0],date=d.result.cycles[0].date;
 await act(s,cid,{action:'preferences',memberId:a.id,dates:[date]});
 await repo.batch([{sql:'UPDATE preferences SET automatic=0 WHERE member_id=?',args:[a.id]}]);
 const result=await act(s,cid,start(d));
 assert.deepEqual(result.awards.filter((award:any)=>award.member_id===a.id).map((award:any)=>award.cycle_date),[date]);
 assert.equal(result.election.preferences.find((p:any)=>p.member_id===a.id).automatic,false);
});
test('consulta anónima ve también adjudicaciones automáticas sin exponer preferencias o datos personales',async()=>{
 const {repo,s,cid,d}=await setup(),[a,b]=d.members,dates=d.result.cycles.map((c:any)=>c.date);await act(s,cid,{action:'preferences',memberId:b.id,dates:[dates[1]]});await act(s,cid,start(d));await act(s,cid,{action:'choose',memberId:a.id,dates:[dates[0]]});
 const publicView=await new Service(repo,{id:null,role:'viewer',teams:[]}).view(cid);assert.equal(publicView.awards.length,2);assert.equal(publicView.result.cycles[0].occupied,1);assert.ok(Number.isFinite(publicView.result.cycles[0].score));assert.deepEqual(publicView.election.preferences,[]);assert.equal(publicView.election.state.source,undefined);assert.ok(!JSON.stringify(publicView).includes('Nombre privado'));assert.equal(publicView.requests.length,0);
 const publicEvents=publicView.election.timeline;
 assert.equal(publicEvents.length,2);
 const automatic=publicEvents.find((item:any)=>item.automatic);
 assert.ok(automatic,'La adjudicación por lista debe identificarse como automática');
 assert.deepEqual(automatic.choices,[{member_id:b.id,cycle_date:dates[1]}]);
 assert.deepEqual(Object.keys(automatic).sort(),['automatic','choices','deferredTurns','id','kind','memberIds','round']);
 assert.ok(!JSON.stringify(publicEvents).includes('before_json'));
 assert.ok(!JSON.stringify(publicEvents).includes('impact'));
 assert.ok(!JSON.stringify(publicEvents).includes('warnings'));
 const managerEvents=(await s.view(cid)).election.timeline;
 assert.ok(managerEvents.some((item:any)=>item.id===automatic.id&&typeof item.createdAt==='string'));
 assert.ok(managerEvents.every((item:any)=>'ties' in item));
});
test('undo y redo recuperan cola, preferencias y ocupación; una versión obsoleta no pierde datos',async()=>{
 const {s,cid,d}=await setup(),a=d.members[0],date=d.result.cycles[0].date;await act(s,cid,start(d));let next=await act(s,cid,{action:'choose',memberId:a.id,dates:[date]});const before=next.election.state;
 await assert.rejects(s.election().mutate(cid,{action:'choose',memberId:d.members[1].id,dates:[date],version:1}),/cambió/);
 next=await act(s,cid,{action:'election_undo',historyId:next.election.undo});assert.equal(next.awards.length,0);assert.equal(next.election.turn.memberId,a.id);
 next=await act(s,cid,{action:'election_redo',historyId:next.election.redo});assert.equal(next.awards.length,1);assert.deepEqual(next.election.state,before);
});
test('varios undo y redo pueden intercalarse; una elección alternativa crea rama nueva',async()=>{
 const {s,cid,d}=await setup(),ids=d.members.map((m:any)=>m.id),dates=d.result.cycles.map((c:any)=>c.date);
 await act(s,cid,start(d));
 const first=await act(s,cid,{action:'choose',memberId:ids[0],dates:[dates[0]]});
 const second=await act(s,cid,{action:'choose',memberId:ids[1],dates:[dates[1]]});
 const third=await act(s,cid,{action:'choose',memberId:ids[2],dates:[dates[2]]});
 const snapshot=(v:any)=>({
  state:v.election.state?(({automaticPaused,...state}:any)=>state)(v.election.state):null,
  awards:v.awards.map((a:any)=>a.member_id+'|'+a.cycle_date).sort(),
  requests:v.requests.map((a:any)=>a.member_id+'|'+a.cycle_date).sort(),
 });
 const original=snapshot(third);
 let current=await act(s,cid,{action:'election_undo',historyId:third.election.undo});
 assert.deepEqual(snapshot(current),snapshot(second));
 current=await act(s,cid,{action:'election_undo',historyId:current.election.undo});
 assert.deepEqual(snapshot(current),snapshot(first));
 current=await act(s,cid,{action:'election_redo',historyId:current.election.redo});
 assert.deepEqual(snapshot(current),snapshot(second));
 current=await act(s,cid,{action:'election_undo',historyId:current.election.undo});
 assert.deepEqual(snapshot(current),snapshot(first));
 current=await act(s,cid,{action:'election_redo',historyId:current.election.redo});
 current=await act(s,cid,{action:'election_redo',historyId:current.election.redo});
 assert.deepEqual(snapshot(current),original);
 current=await act(s,cid,{action:'election_undo',historyId:current.election.undo});
 current=await act(s,cid,{action:'choose',memberId:ids[2],dates:[dates[3]]});
 assert.equal(current.election.redo,null);
 assert.deepEqual(current.awards.filter((a:any)=>a.member_id===ids[2]).map((a:any)=>a.cycle_date),[dates[3]]);
 current=await act(s,cid,{action:'election_undo',historyId:current.election.undo});
 assert.equal(current.election.turn.memberId,ids[2]);
 current=await act(s,cid,{action:'election_redo',historyId:current.election.redo});
 assert.equal(current.awards.length,3);
 assert.deepEqual(current.awards.filter((a:any)=>a.member_id===ids[2]).map((a:any)=>a.cycle_date),[dates[3]]);
});
test('una preferencia siguiente turno se consume y puede recuperarse con undo/redo',async()=>{
 const {s,cid,d}=await setup(),[a,b,c]=d.members,dates=d.result.cycles.map((c:any)=>c.date);
 await act(s,cid,{action:'preferences',memberId:b.id,dates:[dates[1]],persistent:false});
 await act(s,cid,start(d));
 let current=await act(s,cid,{action:'choose',memberId:a.id,dates:[dates[0]]});
 assert.deepEqual(current.awards.filter((x:any)=>x.member_id===b.id).map((x:any)=>x.cycle_date),[dates[1]]);
 assert.equal(current.election.preferences.find((p:any)=>p.member_id===b.id).active,false);
 const completed=current;
 current=await act(s,cid,{action:'election_undo',historyId:current.election.undo});
 assert.equal(current.election.preferences.find((p:any)=>p.member_id===b.id).active,true);
 assert.equal(current.election.state.automaticPaused,true);
 assert.deepEqual(current.awards.map((x:any)=>x.member_id),[a.id]);
 assert.equal(current.election.turn.memberId,b.id);
 current=await act(s,cid,{action:'election_redo',historyId:current.election.redo});
 assert.equal(current.election.preferences.find((p:any)=>p.member_id===b.id).active,false);
 assert.deepEqual(current.awards.map((a:any)=>a.member_id+'|'+a.cycle_date).sort(),completed.awards.map((a:any)=>a.member_id+'|'+a.cycle_date).sort());
});

test('cada adjudicación automática tiene un undo propio, no arrastra el turno manual previo',async()=>{
 const {s,cid,d}=await setup(),[a,b,c]=d.members,dates=d.result.cycles.map((x:any)=>x.date);
 await actOne(s,cid,{action:'preferences',memberId:b.id,dates:[dates[1]],persistent:false});
 await actOne(s,cid,{action:'preferences',memberId:c.id,dates:[dates[2]],persistent:false});
 await actOne(s,cid,start(d));
 let current=await actOne(s,cid,{action:'choose',memberId:a.id,dates:[dates[0]]});
 assert.deepEqual(current.awards.map((x:any)=>x.member_id),[a.id]);
 assert.equal(current.election.pendingAutomatic,true);
 current=await actOne(s,cid,{action:'advance'});
 assert.deepEqual(current.awards.map((x:any)=>x.member_id).sort(),[a.id,b.id].sort());
 assert.equal(current.election.turn.memberId,c.id);
 current=await actOne(s,cid,{action:'advance'});
 assert.deepEqual(current.awards.map((x:any)=>x.member_id).sort(),[a.id,b.id,c.id].sort());
 assert.equal(current.election.preferences.find((p:any)=>p.member_id===c.id).active,false);
 current=await actOne(s,cid,{action:'election_undo',historyId:current.election.undo});
 assert.deepEqual(current.awards.map((x:any)=>x.member_id).sort(),[a.id,b.id].sort());
 assert.equal(current.election.turn.memberId,c.id);
 assert.equal(current.election.preferences.find((p:any)=>p.member_id===c.id).active,true);
 assert.equal(current.election.state.automaticPaused,true);
 assert.equal(current.election.pendingAutomatic,false);
 const beforeVersion=current.campaign.version;
 await actOne(s,cid,{action:'advance'}); // Paused: no change and no extra audit.
 assert.equal((await s.view(cid)).campaign.version,beforeVersion);
 const alternative=dates[4];
 current=await actOne(s,cid,{action:'choose',memberId:c.id,dates:[alternative]});
 assert.deepEqual(current.awards.filter((x:any)=>x.member_id===c.id).map((x:any)=>x.cycle_date),[alternative]);
 assert.equal(current.election.redo,null);
 assert.equal(current.election.state.automaticPaused,true);
 current=await actOne(s,cid,{action:'election_undo',historyId:current.election.undo});
 assert.equal(current.election.turn.memberId,c.id);
 assert.equal(current.election.state.automaticPaused,true);
 current=await actOne(s,cid,{action:'election_redo',historyId:current.election.redo});
 assert.deepEqual(current.awards.filter((x:any)=>x.member_id===c.id).map((x:any)=>x.cycle_date),[alternative]);
});
test('deshacer automáticas sucesivas y rehacerlas intercaladas restaura preferencias y cupos',async()=>{
 const {s,cid,d}=await setup(),[a,b,c]=d.members,dates=d.result.cycles.map((x:any)=>x.date);
 await actOne(s,cid,{action:'preferences',memberId:b.id,dates:[dates[1]],persistent:false});
 await actOne(s,cid,{action:'preferences',memberId:c.id,dates:[dates[2]],persistent:false});
 await actOne(s,cid,start(d));
 await actOne(s,cid,{action:'choose',memberId:a.id,dates:[dates[0]]});
 const bChoice=await actOne(s,cid,{action:'advance'});
 const cChoice=await actOne(s,cid,{action:'advance'});
 let current=await actOne(s,cid,{action:'election_undo',historyId:cChoice.election.undo});
 current=await actOne(s,cid,{action:'election_undo',historyId:current.election.undo});
 assert.deepEqual(current.awards.map((x:any)=>x.member_id),[a.id]);
 assert.equal(current.election.turn.memberId,b.id);
 assert.equal(current.election.preferences.find((p:any)=>p.member_id===b.id).active,true);
 current=await actOne(s,cid,{action:'election_redo',historyId:current.election.redo});
 assert.deepEqual(current.awards.map((x:any)=>x.member_id).sort(),[a.id,b.id].sort());
 assert.equal(current.election.preferences.find((p:any)=>p.member_id===b.id).active,false);
 current=await actOne(s,cid,{action:'election_undo',historyId:current.election.undo});
 assert.deepEqual(current.awards.map((x:any)=>x.member_id),[a.id]);
 current=await actOne(s,cid,{action:'election_redo',historyId:current.election.redo});
 current=await actOne(s,cid,{action:'election_redo',historyId:current.election.redo});
 assert.deepEqual(current.awards.map((x:any)=>x.member_id).sort(),[a.id,b.id,c.id].sort());
 assert.equal(current.requests.length,3);
 assert.equal(current.election.preferences.find((p:any)=>p.member_id===c.id).active,false);
 assert.equal(current.election.state.automaticPaused??false,false);
 assert.notEqual(bChoice.election.undo,cChoice.election.undo);
});
test('solo administradores reanudan automatismos; reanudar permite adjudicar tras revisar',async()=>{
 const {repo,s,cid,d,person}=await setup(),[a,b]=d.members,dates=d.result.cycles.map((x:any)=>x.date);
 await actOne(s,cid,{action:'preferences',memberId:a.id,dates:[dates[0]],persistent:true});
 await actOne(s,cid,start(d));
 let current=await actOne(s,cid,{action:'advance'});
 assert.equal(current.awards.length,1);
 current=await actOne(s,cid,{action:'election_undo',historyId:current.election.undo});
 assert.equal(current.election.state.automaticPaused,true);
 await assert.rejects(actOne(person,cid,{action:'resume_automatic'}),/vinculada|responsable/);
 current=await actOne(s,cid,{action:'resume_automatic'});
 assert.equal(current.election.state.automaticPaused,false);
 assert.equal(current.election.pendingAutomatic,true);
 current=await actOne(s,cid,{action:'advance'});
 assert.equal(current.awards.length,1);
 assert.equal(current.awards[0].cycle_date,dates[0]);
});
test('aplazar no consume una lista que se guarda antes del siguiente turno efectivo',async()=>{
 const {s,cid,d}=await setup(),[a,b,c]=d.members,dates=d.result.cycles.map((c:any)=>c.date);
 await act(s,cid,start(d));
 let current=await act(s,cid,{action:'defer',memberId:a.id});
 await act(s,cid,{action:'preferences',memberId:a.id,dates});
 assert.equal((await s.view(cid)).election.preferences.find((p:any)=>p.member_id===a.id).active,true);
 current=await act(s,cid,{action:'choose',memberId:b.id,dates:[dates[2]]});
 assert.equal(current.election.turn.memberId,c.id);
 const candidate=await s.election().read(cid);
 assert.equal(candidate.preferences.find(p=>p.member_id===a.id)?.active,true);
 current=await act(s,cid,{action:'choose',memberId:c.id,dates:[dates[3]]});
 assert.equal(current.election.turn.memberId===a.id||current.awards.some((award:any)=>award.member_id===a.id),true);
 assert.equal(current.awards.filter((award:any)=>award.member_id===a.id).length,2);
 assert.equal(current.election.preferences.find((p:any)=>p.member_id===a.id).active,false);
});
test('el administrador del equipo puede deshacer y rehacer elecciones, pero no otro equipo',async()=>{
 const {repo,s,cid,d}=await setup(),member=d.members[0],date=d.result.cycles[0].date;
 const delegate=new Service(repo,{id:'chatgpt:delegate',role:'team_admin',teams:['C']});
 const outsider=new Service(repo,{id:'chatgpt:outsider',role:'team_admin',teams:['B']});
 await act(s,cid,{action:'link_account',memberId:member.id,subject:'person@example.test',accountVersion:0});
 await act(s,cid,start(d));
 let next=await act(s,cid,{action:'choose',memberId:member.id,dates:[date]});
 assert.equal((await delegate.view(cid)).election.canManage,true);
 await assert.rejects(act(outsider,cid,{action:'election_undo',historyId:next.election.undo}),/vinculada|responsable/);
 next=await act(delegate,cid,{action:'election_undo',historyId:next.election.undo});
 assert.equal(next.awards.length,0);
 assert.equal(next.election.turn.memberId,member.id);
 next=await act(delegate,cid,{action:'election_redo',historyId:next.election.redo});
 assert.equal(next.awards.length,1);
 assert.equal(next.awards[0].member_id,member.id);
});
test('el administrador de equipo no puede deshacer preferencias privadas vinculadas',async()=>{
 const {repo,s,cid,d}=await setup(),member=d.members[0],date=d.result.cycles[0].date;
 const delegate=new Service(repo,{id:'chatgpt:delegate',role:'team_admin',teams:['C']});
 await act(s,cid,{action:'link_account',memberId:member.id,subject:'person@example.test',accountVersion:0});
 const next=await act(s,cid,{action:'preferences',memberId:member.id,dates:[date],persistent:false});
 await assert.rejects(act(delegate,cid,{action:'election_undo',historyId:next.election.undo}),/restaurar preferencias/);
 assert.equal((await s.view(cid)).election.preferences.length,1);
 const undone=await act(s,cid,{action:'election_undo',historyId:next.election.undo});
 assert.equal(undone.election.preferences.length,0);
});
test('el delegado deshace la última adjudicación aunque después un titular haya editado su lista',async()=>{
 const {repo,s,cid,d,person}=await setup(),a=d.members[0],dates=d.result.cycles.map((c:any)=>c.date);
 const delegate=new Service(repo,{id:'chatgpt:delegate',role:'team_admin',teams:['C']});
 await act(s,cid,{action:'link_account',memberId:a.id,subject:'person@example.test',accountVersion:0});
 await act(s,cid,start(d));
 const chosen=await act(s,cid,{action:'choose',memberId:a.id,dates:[dates[0]]});
 await actOne(person,cid,{action:'preferences',memberId:a.id,dates:[dates[2]],persistent:false});
 const edited=await delegate.view(cid),owned=await s.view(cid);
 // The superadministrator may still undo the list edit; the delegate skips it.
 assert.notEqual(owned.election.undo,chosen.election.undo);
 assert.equal(edited.election.undo,chosen.election.undo);
 let current=await act(delegate,cid,{action:'election_undo',historyId:edited.election.undo});
 assert.equal(current.awards.length,0);
 assert.equal(current.election.turn.memberId,a.id);
 const list=async()=>(await s.view(cid)).election.preferences.find((p:any)=>p.member_id===a.id);
 assert.deepEqual((await list()).dates,[dates[2]],'Deshacer conserva la lista guardada después por su titular');
 current=await act(delegate,cid,{action:'election_redo',historyId:current.election.redo});
 assert.equal(current.awards.length,1);
 assert.deepEqual((await list()).dates,[dates[2]],'Rehacer tampoco la sustituye');
});
test('deshacer una adjudicación que consumió una lista ya editada conserva la versión nueva',async()=>{
 const {repo,s,cid,d,person}=await setup(),a=d.members[0],dates=d.result.cycles.map((c:any)=>c.date);
 const delegate=new Service(repo,{id:'chatgpt:delegate',role:'team_admin',teams:['C']});
 await act(s,cid,{action:'link_account',memberId:a.id,subject:'person@example.test',accountVersion:0});
 await actOne(person,cid,{action:'preferences',memberId:a.id,dates:[dates[0]],persistent:false});
 let current=await act(s,cid,start(d));
 assert.equal(current.awards.filter((x:any)=>x.member_id===a.id).length,1);
 await actOne(person,cid,{action:'preferences',memberId:a.id,dates:[dates[1],dates[2]],persistent:false});
 current=await delegate.view(cid);
 current=await act(delegate,cid,{action:'election_undo',historyId:current.election.undo});
 assert.equal(current.awards.filter((x:any)=>x.member_id===a.id).length,0);
 const list=(await s.view(cid)).election.preferences.find((p:any)=>p.member_id===a.id);
 assert.deepEqual(list.dates,[dates[1],dates[2]]);
 assert.equal(list.active,true);
});
test('el delegado puede deshacer y rehacer una elección que consume preferencias ajenas sin cambiar su lista',async()=>{
 const {repo,s,cid,d}=await setup(),a=d.members[0],date=d.result.cycles[0].date;
 const delegate=new Service(repo,{id:'chatgpt:delegate',role:'team_admin',teams:['C']});
 await act(s,cid,{action:'link_account',memberId:a.id,subject:'person@example.test',accountVersion:0});
 let current=await act(s,cid,{action:'preferences',memberId:a.id,dates:[date],persistent:false});
 assert.equal(current.election.preferences.find((p:any)=>p.member_id===a.id).active,true);
 current=await act(s,cid,start(d));
 assert.equal(current.awards.filter((x:any)=>x.member_id===a.id).length,1);
 assert.equal(current.election.preferences.find((p:any)=>p.member_id===a.id).active,false);
 current=await act(delegate,cid,{action:'election_undo',historyId:current.election.undo});
 assert.equal(current.awards.filter((x:any)=>x.member_id===a.id).length,0);
 assert.equal(current.election.preferences.find((p:any)=>p.member_id===a.id),undefined);
 assert.equal((await s.view(cid)).election.preferences.find((p:any)=>p.member_id===a.id).active,true);
 current=await act(delegate,cid,{action:'election_redo',historyId:current.election.redo});
 assert.equal(current.awards.filter((x:any)=>x.member_id===a.id).length,1);
 assert.equal(current.election.preferences.find((p:any)=>p.member_id===a.id),undefined);
 assert.equal((await s.view(cid)).election.preferences.find((p:any)=>p.member_id===a.id).active,false);
});
test('cerrar un equipo bloquea preferencias, elecciones y correcciones y permite seguir consultando',async()=>{
 const {s,cid,d,person}=await setup(),a=d.members[0],date=d.result.cycles[0].date;await act(s,cid,{action:'link_account',memberId:a.id,subject:'person@example.test',accountVersion:0});await act(s,cid,start(d));let next=await s.view(cid);next=await s.mutate(cid,{action:'close',version:next.campaign.version});assert.equal(next.election.state.status,'paused');
 await assert.rejects(act(person,cid,{action:'preferences',memberId:a.id,dates:[date],automatic:true}),/cerrada/);await assert.rejects(act(s,cid,{action:'choose',memberId:a.id,dates:[date]}),/cerrada/);await assert.rejects(s.mutate(cid,{action:'delete_award',id:'x',version:next.campaign.version}),/cerrada/);assert.equal((await s.view(cid)).campaign.status,'closed');
});
test('simulaciones repetibles no alteran la campaña real ni se exponen a usuarios',async()=>{
 const {s,cid,d,person}=await setup();await act(s,cid,{action:'link_account',memberId:d.members[0].id,subject:'person@example.test',accountVersion:0});const baseline=await s.load(cid);
 const one=await s.createSimulation(cid,{name:'Escenario uno',version:baseline.campaign.version,copyPreferences:true}),two=await s.createSimulation(cid,{name:'Escenario dos',version:baseline.campaign.version});assert.notEqual(one.id,two.id);let sim=await s.view(one.id);assert.equal(sim.awards.length,0);assert.equal(sim.members.length,3);await act(s,one.id,start(sim));sim=await s.view(one.id);await act(s,one.id,{action:'choose',memberId:sim.members[0].id,dates:sim.result.cycles[0].date?[sim.result.cycles[0].date]:[]});
 assert.deepEqual(await s.load(cid),baseline);assert.equal((await s.view(two.id)).awards.length,0);assert.equal((await person.list()).campaigns.some(c=>c.id===one.id),false);await assert.rejects(person.view(one.id),/reservada/);await assert.rejects(person.publishedView(one.id),/reservada/);await assert.rejects(act(person,one.id,{action:'advance'}),/reservada/);
 await s.createCampaigns(2027,2026);assert.equal((await s.list()).campaigns.filter(c=>c.year===2027&&c.scope_key==='live').length,8);
});
test('backup y restauración incluyen listas, cuentas, cola y simulaciones; admiten copias antiguas',async()=>{
 const {s,cid,d}=await setup(),a=d.members[0],date=d.result.cycles[0].date;await act(s,cid,{action:'link_account',memberId:a.id,subject:'person@example.test',accountVersion:0});await act(s,cid,{action:'preferences',memberId:d.members[1].id,dates:[date]});await act(s,cid,start(d));await act(s,cid,{action:'defer',memberId:a.id});const snapshot=await s.backup();
 let current=await s.view(cid);await act(s,cid,{action:'pause'});current=await s.view(cid);await s.mutate(cid,{action:'reset_vacations',confirmation:'C-2026',version:current.campaign.version});await s.restore(snapshot,(await s.admin()).revision);const restored=await s.view(cid);assert.equal(restored.election.state.credits[a.id],1);assert.equal(restored.election.preferences.length,1);assert.equal(restored.election.accounts.length,1);
 const legacy=structuredClone(snapshot);for(const table of ['preferences','election_states','controller_accounts'])delete (legacy.payload.tables as any)[table];for(const c of legacy.payload.tables.campaigns){delete c.scope_key;delete c.simulation_name;}const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(legacy.payload)));legacy.sha256=Array.from(new Uint8Array(hash)).map(b=>b.toString(16).padStart(2,'0')).join('');await s.restore(legacy,(await s.admin()).revision);assert.equal((await s.view(cid)).election.state,null);assert.equal((await s.load(cid)).campaign.scope_key,'live');
});

test('el segundo ciclo se valida contra el primero y las opciones no modifican la campaña',async()=>{
 const {repo,s,cid,d,person}=await setup(),[a,b,c]=d.members,dates=d.result.cycles.map(c=>c.date);await act(s,cid,{action:'link_account',memberId:a.id,subject:'person@example.test',accountVersion:0});await act(s,cid,start(d));await act(s,cid,{action:'defer',memberId:a.id});await act(s,cid,{action:'choose',memberId:b.id,dates:[dates[0]]});await act(s,cid,{action:'choose',memberId:c.id,dates:[dates[1]]});const before=await s.load(cid),options=await person.election().options(cid,[dates[0]]);assert.equal(options.available.includes(dates[0]),false);assert.equal(options.available.includes(dates[1]),true);assert.deepEqual(await s.load(cid),before);await assert.rejects(new Service(repo,{id:'chatgpt:other',role:'viewer',teams:[]}).election().options(cid,[dates[0]]),/turno/);
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
test('el resumen de ciclos y puntos contabiliza solo adjudicaciones, aunque existan solicitudes distintas',async()=>{
 const {s,cid,d}=await setup(),[a,b,c]=d.members;
 const [aAwarded,aExtra,bRequested,bAwarded,bSecond,cRequested]=d.result.cycles.slice(0,6).map((cycle:any)=>cycle.date);
 const score=(date:string)=>d.result.cycles.find((cycle:any)=>cycle.date===date).score;
 let current=d;
 const change=async(body:Record<string,unknown>)=>{
  current=await s.mutate(cid,{...body,version:current.campaign.version});
 };
 // Dos solicitudes, una adjudicación: el resumen no debe sumar la solicitud extra.
 await change({action:'request',memberId:a.id,slot:1,date:aAwarded});
 await change({action:'request',memberId:a.id,slot:2,date:aExtra});
 await change({action:'award',memberId:a.id,date:aAwarded});
 // La adjudicación permutada también debe puntuar según el ciclo adjudicado.
 await change({action:'request',memberId:b.id,slot:1,date:bRequested});
 await change({action:'award',memberId:b.id,date:bAwarded});
 // Varias adjudicaciones de una misma persona se suman.
 await change({action:'award',memberId:b.id,date:bSecond});
 // Sin adjudicación no hay puntos en el resumen, aunque haya solicitudes.
 await change({action:'request',memberId:c.id,slot:1,date:cRequested});
 const summary=(memberId:string)=>current.election.points.find((p:any)=>p.member_id===memberId);
 assert.deepEqual(summary(a.id),{member_id:a.id,cycles:1,points:score(aAwarded)});
 assert.deepEqual(summary(b.id),{member_id:b.id,cycles:2,points:score(bAwarded)+score(bSecond)});
 assert.deepEqual(summary(c.id),{member_id:c.id,cycles:0,points:0});
 // El baremo histórico conserva las solicitudes originales y su puntuación.
 assert.deepEqual(current.requests.filter((r:any)=>r.member_id===a.id).map((r:any)=>r.cycle_date).sort(),[aAwarded,aExtra].sort());
 const historicalA=current.result.ordering.find((m:any)=>m.id===a.id).score;
 // Mismo índice que calculate() en domain/vacations.ts: weights[(slot+4)%6].
 const weight=(slot:number)=>d.config.weights[(slot+4)%6];
 assert.equal(historicalA,score(aAwarded)*weight(1)+score(aExtra)*weight(2));
});

test('Criterios 1.1 p.2: turno conjunto: servidor confirma todas las selecciones y solicitudes o ninguna',async()=>{
 const {s,cid,d}=await setup(),[a,b,c]=d.members,dates=d.result.cycles.map((c:any)=>c.date);
 await act(s,cid,start(d));
 await act(s,cid,{action:'register_joint',round:1,members:[a.id,c.id]});
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
 await act(s,cid,{action:'link_account',memberId:ids[0],subject:'person@example.test',accountVersion:0});
 await act(s,cid,{action:'preferences',memberId:ids[0],dates:[date],automatic:true});
 await setScores(s,cid,{AA:10,BB:10,CC:10});
 let next=await act(s,cid,start(d));
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
 await act(s,cid,{action:'preferences',memberId:ids[0],dates:[]});
 for(let i=0;i<3;i++)next=await act(s,cid,{action:'choose',memberId:order[i],dates:[d.result.cycles[i].date]});
 assert.equal(next.election.turn.round,2);assert.equal(next.election.turn.memberId,order[1]);
 const publicView:any=await new Service(repo,{id:null,role:'viewer',teams:[]}).view(cid);assert.equal(publicView.election.state.tieResolutions[0].actor,undefined);
});

test('sorteo aleatorio solo alcanza al grupo actual y no permite repetirlo',async()=>{
 const {s,cid,d}=await setup(),ids=d.members.map((m:any)=>m.id);
 await setScores(s,cid,{AA:10,BB:20,CC:20});
 let next=await act(s,cid,start(d));
 assert.equal(next.election.turn.memberId,ids[0]);await assert.rejects(act(s,cid,{action:'resolve_tie',method:'random'}),/pendiente/);
 next=await act(s,cid,{action:'choose',memberId:ids[0],dates:[d.result.cycles[0].date]});
 next=await act(s,cid,{action:'resolve_tie',method:'random'});
 assert.equal(next.election.state.order[0],ids[0]);assert.deepEqual([...next.election.state.tieResolutions[0].order].sort(),ids.slice(1).sort());assert.equal(next.election.state.tieResolutions[0].method,'random');
 await assert.rejects(act(s,cid,{action:'resolve_tie',method:'random'}),/pendiente/);
});

test('puntuaciones guardadas detectan empates sin depender del cliente y rechazan orden incorrecto o datos ausentes',async()=>{
 const {s,cid,d}=await setup(),ids=d.members.map((m:any)=>m.id);
 let next=await s.mutate(cid,{action:'config',version:d.campaign.version,config:{...d.config,previousScores:{AA:10,BB:20,CC:20},previousScoresSource:'Histórico ficticio para pruebas'}});
 next=await act(s,cid,start(next,[ids[1],ids[0],ids[2]]));assert.deepEqual(next.election.state.order,ids);assert.deepEqual(next.election.state.pendingTieGroups,[ids.slice(1)]);
 await act(s,cid,{action:'pause'});next=await s.view(cid);
 await assert.rejects(s.mutate(cid,{action:'config',version:next.campaign.version,config:{...next.config,previousScores:{AA:10,BB:20}}}),/congeladas/);
});

test('simulaciones remapean empates pendientes, turnos conjuntos y actas sin referencias a miembros reales',async()=>{
 const {s,cid,d}=await setup(),ids=d.members.map((m:any)=>m.id);
 await setScores(s,cid,{AA:10,BB:10,CC:10});
 let next=await act(s,cid,start(d));
 let clone=await s.createSimulation(cid,{name:'Pending draw',version:next.campaign.version});
 let copy=await s.view(clone.id);assert.equal(copy.election.state.status,'paused');
 assert.ok(copy.election.state.pendingTieGroups[0].every((id:string)=>!ids.includes(id)));
 copy=await act(s,clone.id,{action:'resume'});assert.equal(copy.election.turn.pendingTie.length,3);
 next=await act(s,cid,{action:'resolve_tie',method:'external',order:[...ids].reverse()});
 next=await act(s,cid,{action:'register_joint',round:1,members:[ids[0],ids[1]]});
 clone=await s.createSimulation(cid,{name:'Resolved draw',version:next.campaign.version});copy=await s.view(clone.id);
 assert.equal(copy.election.state.tieResolutions.length,0);assert.ok(copy.election.state.pendingTieGroups[0].every((id:string)=>!ids.includes(id)));
 copy=await act(s,clone.id,{action:'resume'});assert.equal(copy.election.turn.pendingTie.length,3);
 assert.deepEqual((await s.view(cid)).election.state,next.election.state);
});

test('preferencias privadas: administrador delegado solo gestiona controladores sin cuenta vinculada',async()=>{
 const {repo,s,cid,d,person}=await setup(),[a,b,c]=d.members,dates=d.result.cycles.map((x:any)=>x.date);
 const delegate=new Service(repo,{id:'chatgpt:delegate',role:'team_admin',teams:['C']});
 const ownDelegate=new Service(repo,{...visitor,role:'team_admin',teams:['C']});
 const firebaseOwner=new Service(repo,{id:'firebase:uid-b',role:'viewer',teams:[]});
 const outsider=new Service(repo,{id:'chatgpt:outsider',role:'viewer',teams:[]});
 await act(s,cid,{action:'link_account',memberId:a.id,provider:'chatgpt',subject:'person@example.test',accountVersion:0});
 await act(s,cid,{action:'link_account',memberId:b.id,provider:'firebase',subject:'uid-b',accountVersion:0});
 await act(s,cid,{action:'preferences',memberId:a.id,dates:[dates[0]],automatic:false});
 await act(s,cid,{action:'preferences',memberId:b.id,dates:[dates[1]],automatic:true});
 await act(s,cid,{action:'preferences',memberId:c.id,dates:[dates[2]],automatic:false});
 const delegated=await delegate.view(cid);
 assert.deepEqual(delegated.election.preferenceMemberIds,[c.id]);
 assert.deepEqual(delegated.election.preferences.map((p:any)=>p.member_id),[c.id]);
 assert.equal(delegated.election.accounts.length,2);
 assert.equal(JSON.stringify(delegated.election.preferences).includes(a.id),false);
 assert.equal(JSON.stringify(delegated.election.preferences).includes(b.id),false);
 for(const linked of [a,b]){
  await assert.rejects(act(delegate,cid,{action:'preferences',memberId:linked.id,dates:[dates[4]],automatic:false}),/vinculada/);
 }
 await act(delegate,cid,{action:'preferences',memberId:c.id,dates:[dates[3]],automatic:true});
 assert.deepEqual((await s.view(cid)).election.preferences.map((p:any)=>p.member_id).sort(),[a.id,b.id,c.id].sort());
 assert.deepEqual((await person.view(cid)).election.preferences.map((p:any)=>p.member_id),[a.id]);
 assert.deepEqual((await firebaseOwner.view(cid)).election.preferences.map((p:any)=>p.member_id),[b.id]);
 assert.deepEqual((await outsider.view(cid)).election.preferences,[]);
 assert.deepEqual((await ownDelegate.view(cid)).election.preferenceMemberIds,[a.id,c.id]);
 await act(ownDelegate,cid,{action:'preferences',memberId:a.id,dates:[dates[5]],automatic:false});
 await assert.rejects(act(ownDelegate,cid,{action:'preferences',memberId:b.id,dates:[],automatic:false}),/vinculada/);
 await act(s,cid,{action:'link_account',memberId:c.id,provider:'firebase',subject:'uid-c',accountVersion:0});
 assert.deepEqual((await delegate.view(cid)).election.preferences,[]);
 assert.deepEqual((await delegate.view(cid)).election.preferenceMemberIds,[]);
 await assert.rejects(act(delegate,cid,{action:'preferences',memberId:c.id,dates:[],automatic:false}),/vinculada/);
 await act(s,cid,{action:'link_account',memberId:b.id,provider:'firebase',subject:'',accountVersion:1});
 assert.deepEqual((await delegate.view(cid)).election.preferenceMemberIds,[b.id]);
 await act(delegate,cid,{action:'preferences',memberId:b.id,dates:[dates[6]],automatic:false});
});
test('deshacer un reinicio no permite a un administrador delegado restaurar preferencias vinculadas',async()=>{
 const {repo,s,cid,d}=await setup(),member=d.members[0],date=d.result.cycles[0].date;
 const delegate=new Service(repo,{id:'chatgpt:delegate',role:'team_admin',teams:['C']});
 await act(s,cid,{action:'link_account',memberId:member.id,provider:'chatgpt',subject:'person@example.test',accountVersion:0});
 await act(s,cid,{action:'preferences',memberId:member.id,dates:[date],automatic:false,mode:'wait',waitMinutes:30,labels:{[date]:'Verano 1'}});
 const reset=await s.mutate(cid,{action:'reset_vacations',version:(await s.load(cid)).campaign.version,confirmation:'C-2026'});
 assert.deepEqual(reset.election.preferences,[]);
 const view=await delegate.view(cid);
 await assert.rejects(delegate.mutate(cid,{action:'undo_vacations',version:view.campaign.version,undoId:view.undo.id}),/restaurar preferencias/);
 assert.deepEqual((await delegate.view(cid)).election.preferences,[]);
 const restored=await s.mutate(cid,{action:'undo_vacations',version:reset.campaign.version,undoId:reset.undo.id});
 assert.deepEqual(restored.election.preferences.map((p:any)=>p.member_id),[member.id]);
 const list=restored.election.preferences[0];
 assert.deepEqual([list.mode,list.waitMinutes,list.labels],['wait',30,{[date]:'Verano 1'}],'Deshacer el reinicio conserva plazo y nombres de la lista');
});


test('vinculación por correo ChatGPT: distinta cuenta no obtiene acceso y se rechazan ambigüedades',async()=>{
 const {repo,s,cid,d,person}=await setup(),[a,b]=d.members;
 await act(s,cid,{action:'link_account',memberId:a.id,subject:'PERSON@EXAMPLE.TEST',accountVersion:0});
 assert.equal((await person.view(cid)).election.myMemberId,a.id);
 assert.deepEqual((await person.list()).myCampaignIds.includes(cid),true);
 const other=new Service(repo,{id:'chatgpt:other',emailKey:'chatgpt-email:other@example.test',role:'viewer',teams:[]});
 assert.equal((await other.view(cid)).election.myMemberId,null);
 await assert.rejects(act(s,cid,{action:'link_account',memberId:b.id,subject:'PERSON@example.test',accountVersion:0}),/ya existe/);
 // Historical UID mapping remains valid, but ambiguous UID/email combinations grant neither identity.
 await repo.batch([{sql:'INSERT INTO controller_accounts(person_id,principal_key,version) VALUES(?,?,1)',args:[b.person_id,'chatgpt:person']}]);
 assert.equal((await person.view(cid)).election.myMemberId,null);
 const legacyOnly=new Service(repo,{id:'chatgpt:person',role:'viewer',teams:[]});
 assert.equal((await legacyOnly.view(cid)).election.myMemberId,b.id);
});


test('resolver empate futuro no adelanta el turno y habilita inmediatamente los turnos conjuntos',async()=>{
 const {s,cid,d,person}=await setup(),ids=d.members.map((m:any)=>m.id);
 await setScores(s,cid,{AA:10,BB:20,CC:20});
 let next=await act(s,cid,start(d));
 assert.equal(next.election.turn.memberId,ids[0]);
 assert.deepEqual(next.election.state.pendingTieGroups,[ids.slice(1)]);
 await assert.rejects(actOne(s,cid,{action:'register_joint',round:1,members:[ids[0],ids[1]]}),/empate/);
 await assert.rejects(actOne(person,cid,{action:'resolve_tie',method:'random',groupMemberIds:ids.slice(1)}),/vinculada|responsable/);
 await assert.rejects(actOne(s,cid,{action:'resolve_tie',method:'random',groupMemberIds:[ids[0],ids[1]]}),/pendiente/);
 const order=[ids[2],ids[1]],beforeVersion=next.campaign.version;
 next=await actOne(s,cid,{action:'resolve_tie',method:'external',groupMemberIds:ids.slice(1),order});
 assert.equal(next.campaign.version,beforeVersion+1);
 assert.equal(next.election.state.cursor,0);
 assert.equal(next.election.turn.memberId,ids[0]);
 assert.deepEqual(next.election.state.order,[ids[0],...order]);
 assert.deepEqual(next.election.state.pendingTieGroups,[]);
 assert.equal(next.awards.length,0);
 assert.equal(next.election.state.tieResolutions[0].anticipated,true);
 assert.equal(next.election.timeline.find((e:any)=>e.kind==='tie')?.anticipated,true);
 await assert.rejects(actOne(s,cid,{action:'resolve_tie',method:'external',groupMemberIds:ids.slice(1),order}),/pendiente/);
 next=await actOne(s,cid,{action:'register_joint',round:1,members:[ids[0],ids[1]]});
 assert.equal(next.election.turn.memberId,ids[2]);
 assert.equal(next.election.state.jointAgreements.length,1);
});
test('el administrador puede sortear anticipadamente otro grupo incluso si la elección está pausada',async()=>{
 const {s,cid,d}=await setup(),ids=d.members.map((m:any)=>m.id);
 await setScores(s,cid,{AA:10,BB:20,CC:20});
 await act(s,cid,start(d));
 let next=await actOne(s,cid,{action:'pause'});
 assert.equal(next.election.state.status,'paused');
 next=await actOne(s,cid,{action:'resolve_tie',method:'random',groupMemberIds:ids.slice(1)});
 assert.equal(next.election.state.status,'paused');
 assert.equal(next.election.state.cursor,0);
 assert.equal(next.election.state.pendingTieGroups.length,0);
 assert.deepEqual([...next.election.state.tieResolutions[0].order].sort(),ids.slice(1).sort());
});
test('el controlador sabe cuántos de los que van delante tienen preferencias activas, sin ver cuáles',async()=>{
 const {s,cid,d,person}=await setup(),[a,b,c]=d.members,date=d.result.cycles[3].date;
 await act(s,cid,{action:'link_account',memberId:c.id,subject:'person@example.test',accountVersion:0});
 await act(s,cid,{action:'preferences',memberId:b.id,dates:[date],automatic:true});
 await act(s,cid,start(d,[a.id,b.id,c.id]));
 const mine=(await person.view(cid)).election;
 assert.equal(mine.myMemberId,c.id);
 assert.equal(mine.automaticAhead,1);
 assert.deepEqual(mine.preferences,[]);
 await act(s,cid,{action:'pause'});
 assert.equal((await person.view(cid)).election.automaticAhead,null);
 assert.equal((await s.view(cid)).election.automaticAhead,null);
});
