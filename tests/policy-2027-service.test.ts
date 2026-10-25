import test from 'node:test';
import assert from 'node:assert/strict';
import {Service} from '../server/service.ts';
import {SQLiteRepo} from './sqlite-repo.ts';
import {OCCUPANCY_POLICY_2027,canComplete2027,evaluate2027Final} from '../domain/policy-2027.ts';
import {policyState2027} from '../domain/election-2027.ts';
import {expandAvailability} from '../domain/availability-2027.ts';

const owner={id:'chatgpt:owner',role:'superadmin' as const,teams:[]};

test('existing 2027 campaign and simulation use the same policy without losing saved preferences',async()=>{
 const repo=new SQLiteRepo(),service=new Service(repo,owner);
 await service.init();
 await service.createCampaigns(2027,null,null);
 let d=await service.view((await service.list()).campaigns.find((c:any)=>c.year===2027&&c.team_id==='A').id);
 const cid=d.campaign.id;
 const codes=Array.from({length:20},(_,i)=>'P'+String(i+1).padStart(2,'0'));
 d=await service.mutate(cid,{action:'import_roster',version:d.campaign.version,
  source:{format:'vacaciones-roster-v1',team:'A',year:2027,copySelections:false,
   rows:codes.map(code=>({code,label:'CTA '+code,seniority:''}))}});
 assert.equal(d.members.length,20);
 assert.equal(d.result.cycles.length,45);
 assert.equal(d.result.occupancyPolicyVersion,OCCUPANCY_POLICY_2027);
 const user=d.members[0].id,preferred=d.result.cycles.slice(0,3).map((c:any)=>c.date);
 d=await service.mutate(cid,{action:'config',version:d.campaign.version,
  config:{...d.config,previousScores:Object.fromEntries(codes.map((code,i)=>[code,200+i])),
   previousScoresSource:'Listado de puntuaciones de ensayo verificadas para 2027'}});
 await service.election().mutate(cid,{action:'preferences',version:d.campaign.version,
  memberId:user,dates:preferred,persistent:true});
 d=await service.view(cid);
 assert.deepEqual(d.election.preferences.find((p:any)=>p.member_id===user)?.dates,preferred);
 const simulation=await service.createSimulation(cid,{version:d.campaign.version,name:'Test normativa 2027'});
 const testView=await service.view(simulation.id);
 assert.equal(testView.campaign.year,2027);
 assert.equal(testView.result.occupancyPolicyVersion,OCCUPANCY_POLICY_2027);
 assert.equal(testView.result.cycles.length,45);
 // Simulation preferences are deliberately private and not copied.
 assert.equal(testView.election.preferences.length,0);
 // Creating a simulation cannot remove or modify the original preferences.
 d=await service.view(cid);
 assert.deepEqual(d.election.preferences.find((p:any)=>p.member_id===user)?.dates,preferred);
 await service.election().mutate(cid,{action:'start',version:d.campaign.version,
  rulesConfirmed:true,allowDeferral:true});
 d=await service.view(cid);
 assert.equal(d.election.occupancyPolicyVersion,OCCUPANCY_POLICY_2027);
 assert.equal(d.election.turn.memberId,user);
 const options=await service.election().options(cid,[]);
 assert.equal(options.policyVersion,OCCUPANCY_POLICY_2027);
 assert.ok(options.available.includes(preferred[0]));
 assert.deepEqual((await service.view(cid)).election.preferences.find((p:any)=>p.member_id===user)?.dates,preferred);
 // The ordinary 2027 election undo/redo must preserve the selected date,
 // cursor and the user's saved preferences under the new policy.
 d=await service.view(cid);
 const availability=await service.election().availability(cid);
 assert.equal(availability.version,d.campaign.version);
 assert.ok(availability.cycles[preferred[0]]);
 assert.equal(availability.policyVersion,OCCUPANCY_POLICY_2027);
 const baselineAvailability=d.election.cycleAvailability;
 const preflight=await service.election().previewImpact(cid,
  [{member_id:user,cycle_date:preferred[0]}],d.campaign.version);
 assert.equal(preflight.allowed,true);
 assert.ok(preflight.impact);
 await service.election().mutate(cid,{action:'choose',version:d.campaign.version,memberId:user,dates:[preferred[0]]});
 let chosen=await service.view(cid);
 const auditChoice=chosen.election.timeline.find((event:any)=>event.kind==='choice'&&
  event.choices.some((choice:any)=>choice.member_id===user&&choice.cycle_date===preferred[0]));
 assert.ok(auditChoice?.impact,'the impact was committed with the choice');
 // The timeline carries only the summary; the full snapshots stay in the audit.
 assert.equal(auditChoice.impact.availabilityBefore,undefined);
 const [auditRow]=await repo.all('SELECT after_json FROM audit WHERE id=?',[auditChoice.id]);
 const stored=JSON.parse(auditRow.after_json).impact;
 // The audit keeps the compact form; it expands to exactly the verified snapshots.
 assert.equal(stored.availabilityBefore.format,'availability-c1');
 const awardsAfter=chosen.awards,awardsBefore=awardsAfter.filter((a:any)=>!(a.member_id===user&&a.cycle_date===preferred[0]));
 const persisted={...stored,
  availabilityBefore:expandAvailability(stored.availabilityBefore,policyState2027(2027,'A',chosen.config,chosen.members,awardsBefore)),
  availabilityAfter:expandAvailability(stored.availabilityAfter,policyState2027(2027,'A',chosen.config,chosen.members,awardsAfter))};
 assert.ok(Array.isArray(JSON.parse(auditRow.after_json).warnings),'the policy warnings are committed with the choice');
 assert.deepEqual(persisted.availabilityBefore.cycles,baselineAvailability.cycles,
  'persist the complete availability previously verified before the choice');
 assert.deepEqual(persisted.availabilityAfter.cycles,chosen.election.cycleAvailability.cycles,
  'persist the verified availability immediately after the choice');
 assert.deepEqual(auditChoice.impact.changes,preflight.impact?.changes);
 await assert.rejects(service.election().previewImpact(cid,
  [{member_id:user,cycle_date:preferred[0]}],d.campaign.version),/cambió/i);
 assert.equal(chosen.awards.length,1);
 assert.equal(chosen.awards[0].cycle_date,preferred[0]);
 const undoId=chosen.election.undo;
 assert.ok(undoId);
 await service.election().mutate(cid,{action:'election_undo',version:chosen.campaign.version,historyId:undoId});
 const undone=await service.view(cid);
 assert.equal(undone.election.cycleAvailability.checked,0,
  'undo derives locally from the verified historical snapshot without a global solver');
 assert.deepEqual(undone.election.cycleAvailability.cycles,baselineAvailability.cycles,
  'undo must restore exact prior availability, not turn known places provisional');
 const undoApi=await service.election().availability(cid);
 assert.equal(undoApi.checked,0,'the availability endpoint must not run a new proof after undo');
 assert.deepEqual(undoApi.cycles,baselineAvailability.cycles);
 assert.equal(undone.election.cycleAvailability.policyVersion,OCCUPANCY_POLICY_2027);
 assert.equal(undone.awards.length,0);
 assert.equal(undone.election.turn.memberId,user);
 assert.deepEqual(undone.election.preferences.find((p:any)=>p.member_id===user)?.dates,preferred);
 assert.ok(undone.election.redo);
 await service.election().mutate(cid,{action:'election_redo',version:undone.campaign.version,historyId:undone.election.redo});
 chosen=await service.view(cid);
 assert.equal(chosen.election.cycleAvailability.checked,0,
  'redo must not rerun global feasibility either');
 assert.deepEqual(chosen.election.cycleAvailability.cycles,persisted.availabilityAfter.cycles,
  'redo must show the previously verified after-state');
 const redoApi=await service.election().availability(cid);
 assert.equal(redoApi.checked,0,'the availability endpoint must not run a new proof after redo');
 assert.deepEqual(redoApi.cycles,persisted.availabilityAfter.cycles);
 assert.equal(chosen.awards.length,1);
 assert.equal(chosen.awards[0].cycle_date,preferred[0]);
 assert.deepEqual(chosen.election.preferences.find((p:any)=>p.member_id===user)?.dates,preferred);
});

test('2027 administrative roster edits cannot strand existing awards; denial is atomic',async()=>{
 const repo=new SQLiteRepo(),service=new Service(repo,owner);
 await service.init();
 await service.createCampaigns(2027,null,null);
 const cid=(await service.list()).campaigns.find((c:any)=>c.year===2027&&c.team_id==='A').id;
 let d=await service.view(cid);
 const roster=Array.from({length:20},(_,i)=>'CTA'+String(i+1).padStart(2,'0'));
 d=await service.mutate(cid,{action:'import_roster',version:d.campaign.version,
  source:{format:'vacaciones-roster-v1',team:'A',year:2027,copySelections:false,
   rows:roster.map(code=>({code,label:'Ensayo '+code,seniority:''}))}});
 // A valid first award still leaves a completion for the ordinary 20 CTAs.
 const date=d.result.cycles[0].date;
 d=await service.mutate(cid,{action:'award',version:d.campaign.version,memberId:d.members[0].id,date});
 const beforeVersion=d.campaign.version,beforeMembers=d.members.length,beforeAwards=d.awards.length;
 const additions=Array.from({length:30},(_,i)=>({code:'NEW'+String(i+1).padStart(2,'0'),label:'Controlador de prueba',seniority:''}));
 await assert.rejects(
  service.mutate(cid,{action:'bulk_members',version:beforeVersion,rows:additions}),
  /plazas físicas|plazas autorizadas|completación|capacidad|vacaciones restantes/i);
 const after=await service.view(cid);
 assert.equal(after.campaign.version,beforeVersion);
 assert.equal(after.members.length,beforeMembers);
 assert.equal(after.awards.length,beforeAwards);
 assert.equal(after.awards[0].cycle_date,date);
});

test('2027 administrative undo and redo restore saved awards without any expensive global proof',async()=>{
 const repo=new SQLiteRepo(),service=new Service(repo,owner);
 await service.init();
 await service.createCampaigns(2027,null,null);
 const cid=(await service.list()).campaigns.find((c:any)=>c.year===2027&&c.team_id==='A').id;
 let d=await service.view(cid);
 const codes=Array.from({length:20},(_,i)=>'UNDO'+i);
 d=await service.mutate(cid,{action:'import_roster',version:d.campaign.version,
  source:{format:'vacaciones-roster-v1',year:2027,team:'A',copySelections:false,
   rows:codes.map(code=>({code,label:'Controlador '+code,seniority:''}))}});
 const date=d.result.cycles[0].date,memberId=d.members[0].id;
 const beforeAvailability=d.election.cycleAvailability;
 d=await service.mutate(cid,{action:'award',version:d.campaign.version,memberId,date});
 const afterAvailability=d.election.cycleAvailability;
 assert.equal(d.awards.length,1);
 assert.ok(d.undo?.id);
 d=await service.mutate(cid,{action:'undo_vacations',version:d.campaign.version,undoId:d.undo.id});
 assert.equal(d.awards.length,0);
 assert.equal(d.election.cycleAvailability.checked,0);
 assert.deepEqual(d.election.cycleAvailability.cycles,beforeAvailability.cycles,
  'admin undo recovers the exact previously certified per-cycle values');
 assert.ok(d.redo?.id);
 d=await service.mutate(cid,{action:'redo_vacations',version:d.campaign.version,undoId:d.redo.id});
 assert.equal(d.awards.length,1);
 assert.equal(d.election.cycleAvailability.checked,0);
 assert.deepEqual(d.election.cycleAvailability.cycles,afterAvailability.cycles,
  'admin redo recovers the exact previously certified per-cycle values');
 assert.equal(d.awards[0].cycle_date,date);
});

test('2027 guided reconstruction previews and replays a joint award through the same atomic evaluator',async()=>{
 const repo=new SQLiteRepo(),service=new Service(repo,owner);
 await service.init();
 await service.createCampaigns(2027,null,null);
 const cid=(await service.list()).campaigns.find((c:any)=>c.year===2027&&c.team_id==='A').id;
 let d=await service.view(cid);
 const codes=Array.from({length:20},(_,i)=>'J'+String(i+1).padStart(2,'0'));
 d=await service.mutate(cid,{action:'import_roster',version:d.campaign.version,
  source:{format:'vacaciones-roster-v1',team:'A',year:2027,copySelections:false,
   rows:codes.map(code=>({code,label:'Prueba conjunta '+code,seniority:''}))}});
 d=await service.mutate(cid,{action:'config',version:d.campaign.version,
  config:{...d.config,previousScores:Object.fromEntries(codes.map((code,i)=>[code,10+i])),
   previousScoresSource:'Puntuaciones conjuntas certificadas para ensayo 2027'}});
 const ids=d.members.slice(0,2).map((m:any)=>m.id);
 const dates=d.result.cycles.slice(0,2).map((c:any)=>c.date);
 await service.election().mutate(cid,{action:'start',version:d.campaign.version,rulesConfirmed:true,allowDeferral:true});
 d=await service.view(cid);
 await service.election().mutate(cid,{action:'register_joint',round:1,members:ids,version:d.campaign.version});
 d=await service.view(cid);
 assert.deepEqual(d.election.turn.participants,ids);
 await service.election().mutate(cid,{action:'choose_joint',version:d.campaign.version,
  entries:ids.map((member_id:string,i:number)=>({member_id,dates:[dates[i]]}))});
 d=await service.view(cid);
 assert.equal(d.awards.length,2);
 const originalJoint=d.election.timeline.find((item:any)=>
  item.kind==='choice'&&item.choices.length===2);
 assert.ok(originalJoint?.impact,'the joint award must produce one atomic impact');
 assert.equal(originalJoint.impact.policyVersion,OCCUPANCY_POLICY_2027);
 const target=d.election.reconstruction.candidates.find((item:any)=>item.action==='choose_joint');
 assert.ok(target);
 await service.election().mutate(cid,{action:'reconstruction_start',version:d.campaign.version,historyId:target.id});
 d=await service.view(cid);
 assert.equal(d.awards.length,0);
 assert.equal(d.election.reconstruction.current.originalAction,'choose_joint');
 assert.equal(d.election.reconstruction.current.originalPossible,true);
 const unassignedAvailability=d.election.cycleAvailability;
 await service.election().mutate(cid,{action:'reconstruction_step',kind:'choose_joint',mode:'original',version:d.campaign.version});
 d=await service.view(cid);
 assert.equal(d.awards.length,2);
 assert.equal(d.election.reconstruction.status,'review');
 const steppedAvailability=d.election.cycleAvailability;
 await service.election().mutate(cid,{action:'reconstruction_back',version:d.campaign.version});
 d=await service.view(cid);
 assert.equal(d.election.cycleAvailability.checked,0);
 assert.deepEqual(d.election.cycleAvailability.cycles,unassignedAvailability.cycles,
  'reconstruction back must replay the saved before-state availability');
 assert.equal(d.awards.length,0);
 await service.election().mutate(cid,{action:'reconstruction_forward',version:d.campaign.version});
 d=await service.view(cid);
 assert.deepEqual(d.election.cycleAvailability.cycles,steppedAvailability.cycles,
  'reconstruct forward must recover the original verified availability');
 assert.equal(d.awards.length,2);
 assert.equal(d.election.reconstruction.status,'review');
 await service.election().mutate(cid,{action:'reconstruction_finish',version:d.campaign.version});
 d=await service.view(cid);
 assert.equal(d.election.reconstruction.status,'completed');
 const reconstructed=d.election.timeline.filter((event:any)=>event.kind==='choice');
 assert.equal(reconstructed.length,1,'historically replaced joint decision is not current');
 assert.equal(reconstructed[0].choices.length,2);
 assert.ok(reconstructed[0].impact,'guided reconstruction keeps its own atomic impact');
 assert.deepEqual(reconstructed[0].impact.changes,originalJoint.impact.changes);
 assert.deepEqual(d.awards.map((a:any)=>a.member_id+'|'+a.cycle_date).sort(),ids.map((id:string,i:number)=>id+'|'+dates[i]).sort());
});

test('2027 publication refuses unreviewed allowed warnings and retains the reviewed policy audit',async()=>{
 const repo=new SQLiteRepo(),service=new Service(repo,owner);
 await service.init();
 await service.createCampaigns(2027,null,null);
 const cid=(await service.list()).campaigns.find((c:any)=>c.year===2027&&c.team_id==='A').id;
 let d=await service.view(cid);
 const codes=Array.from({length:20},(_,i)=>'V'+String(i+1).padStart(2,'0'));
 d=await service.mutate(cid,{action:'import_roster',version:d.campaign.version,
  source:{format:'vacaciones-roster-v1',team:'A',year:2027,copySelections:false,
   rows:codes.map(code=>({code,label:'Validación '+code,seniority:''}))}});
 const policy=policyState2027(2027,'A',d.config,d.members,[]);
 const completion=canComplete2027(policy,{maxChecks:1200});
 assert.equal(completion.status,'possible',completion.reason);
 const shifted=completion.witness!;
 const final=evaluate2027Final({...policy,awards:shifted});
 assert.equal(final.valid,true,JSON.stringify(final.issues));
 assert.equal(final.warnings.some(w=>w.code==='CROSS_PERIOD_FLEXIBILITY'),false);
 await repo.batch(shifted!.map((award,i)=>({
  sql:'INSERT INTO awards(id,campaign_id,member_id,cycle_date,version) VALUES(?,?,?,?,1)',
  args:['fixture-award-'+i,cid,award.member_id,award.cycle_date]
 })));
 d=await service.view(cid);
 assert.equal(d.result.issues.length,0);
 assert.equal(d.result.policyWarnings.some((w:any)=>w.code==='CROSS_PERIOD_FLEXIBILITY'),false);
 d=await service.mutate(cid,{action:'calculate',version:d.campaign.version});
 const runId=d.runs[0].id;
 // An old computed snapshot must not be republished under policy v2,
 // even if its campaign version still matches.
 const originalRun=(await repo.all('SELECT result_json FROM runs WHERE id=?',[runId]))[0].result_json as string;
 const legacy=JSON.parse(originalRun);
 legacy.result.occupancyPolicyVersion='lecs-2027-occupancy-v1';
 await repo.batch([{sql:'UPDATE runs SET result_json=? WHERE id=?',args:[JSON.stringify(legacy),runId]}]);
 await assert.rejects(service.mutate(cid,{action:'publish',version:d.campaign.version,runId}),/otra versión de normas 2027/);
 assert.equal((await service.load(cid)).campaign.status,'open');
 await repo.batch([{sql:'UPDATE runs SET result_json=? WHERE id=?',args:[originalRun,runId]}]);
 if(final.warnings.length){
  await assert.rejects(service.mutate(cid,{action:'publish',version:d.campaign.version,runId}),/Confirma expresamente los avisos/);
  assert.equal((await service.load(cid)).campaign.status,'open');
 }
 const expected=final.warnings.map(w=>w.code);
 d=await service.mutate(cid,{action:'publish',version:d.campaign.version,runId,reviewedWarnings:expected});
 assert.equal(d.campaign.status,'published');
 const published=await service.publishedView(cid);
 assert.equal(published?.awards.length,120);
 assert.deepEqual(published?.result.policyWarnings?.map((w:any)=>w.code).sort(),expected.sort());
 const audit=await repo.all('SELECT after_json FROM audit WHERE campaign_id=? AND action=? ORDER BY rowid DESC LIMIT 1',[cid,'publish']);
 const review=JSON.parse(audit[0].after_json).review;
 assert.equal(review.policyVersion,OCCUPANCY_POLICY_2027);
 assert.equal(review.actor,owner.id);
 assert.ok(typeof review.at==='string'&&review.at.length>10);
 assert.deepEqual(review.warnings.map((w:any)=>w.code).sort(),expected.sort());
});

test('2027 automatic preference transient responses skip solver table but final/manual responses remain complete',async()=>{
 const repo=new SQLiteRepo(),service=new Service(repo,owner);
 await service.init();
 await service.createCampaigns(2027,null,null);
 const cid=(await service.list()).campaigns.find((c:any)=>c.year===2027&&c.team_id==='A').id;
 let d=await service.view(cid);
 const codes=Array.from({length:20},(_,i)=>'FAST'+String(i+1).padStart(2,'0'));
 d=await service.mutate(cid,{action:'import_roster',version:d.campaign.version,
  source:{format:'vacaciones-roster-v1',team:'A',year:2027,copySelections:false,
   rows:codes.map(code=>({code,label:'Ficticio '+code,seniority:''}))}});
 d=await service.mutate(cid,{action:'config',version:d.campaign.version,
  config:{...d.config,previousScores:Object.fromEntries(codes.map((code,i)=>[code,i+1])),
   previousScoresSource:'Orden ficticio para comprobar la optimización de 2027'}});
 const first=d.members[0].id,date=d.result.cycles[0].date;
 await service.election().mutate(cid,{action:'preferences',version:d.campaign.version,
  memberId:first,dates:[date]});
 d=await service.view(cid);
 await service.election().mutate(cid,{action:'start',version:d.campaign.version,
  rulesConfirmed:true,allowDeferral:true});
 const intermediate=await service.view(cid,{skipAvailabilityForPendingAutomatic:true});
 assert.equal(intermediate.election.pendingAutomatic,true);
 assert.deepEqual(intermediate.election.available,[]);
 assert.equal(intermediate.election.cycleAvailability,null);
 assert.equal(intermediate.awards.length,0);
 const ordinary=await service.view(cid);
 assert.equal(ordinary.election.pendingAutomatic,true);
 assert.ok(ordinary.election.cycleAvailability?.cycles[date]);
 assert.ok(ordinary.election.available.includes(date));
 await service.election().mutate(cid,{action:'advance',version:intermediate.campaign.version});
 const final=await service.view(cid,{skipAvailabilityForPendingAutomatic:true});
 assert.equal(final.election.pendingAutomatic,false);
 assert.ok(final.election.cycleAvailability?.cycles[date]);
 assert.ok(final.election.available.length>0);
 assert.deepEqual(final.awards.filter((a:any)=>a.member_id===first).map((a:any)=>a.cycle_date),[date]);
});

test('2027 joint turn of three, each recovering two deferrals, previews and commits nine awards',async()=>{
 const repo=new SQLiteRepo(),service=new Service(repo,owner);
 await service.init();
 await service.createCampaigns(2027,null,null);
 let d=await service.view((await service.list()).campaigns.find((c:any)=>c.year===2027&&c.team_id==='A').id);
 const cid=d.campaign.id,codes=Array.from({length:20},(_,i)=>'P'+String(i+1).padStart(2,'0'));
 d=await service.mutate(cid,{action:'import_roster',version:d.campaign.version,
  source:{format:'vacaciones-roster-v1',team:'A',year:2027,copySelections:false,
   rows:codes.map(code=>({code,label:'CTA '+code,seniority:''}))}});
 d=await service.mutate(cid,{action:'config',version:d.campaign.version,
  config:{...d.config,previousScores:Object.fromEntries(codes.map((code,i)=>[code,200+i])),
   previousScoresSource:'Listado de puntuaciones de ensayo verificadas para 2027'}});
 await service.election().mutate(cid,{action:'start',version:d.campaign.version,rulesConfirmed:true,allowDeferral:true});
 d=await service.view(cid);
 const trio=d.election.state.order.slice(0,3),dates=d.result.cycles.map((c:any)=>c.date);
 await service.election().mutate(cid,{action:'register_joint',version:d.campaign.version,members:trio,round:3});
 // Rounds 1 and 2: the trio defers, everybody else spreads over the year.
 let step=0;
 for(d=await service.view(cid);d.election.turn.round<3;d=await service.view(cid),step++){
  const member=d.election.turn.memberId;
  if(trio.includes(member))await service.election().mutate(cid,{action:'defer',version:d.campaign.version,memberId:member});
  else await service.election().mutate(cid,{action:'choose',version:d.campaign.version,memberId:member,dates:[dates[(step*7)%dates.length]]});
 }
 assert.deepEqual(d.election.turn.participants,trio);
 assert.deepEqual(trio.map((id:string)=>d.election.turn.requiredByMember[id]),[3,3,3]);
 const load=(date:string)=>d.awards.filter((a:any)=>a.cycle_date===date).length;
 const free=[...dates].sort((a,b)=>load(a)-load(b)||a.localeCompare(b)).slice(0,9);
 const choices=trio.flatMap((id:string,i:number)=>free.slice(i*3,i*3+3).map(cycle_date=>({member_id:id,cycle_date})));
 assert.equal(choices.length,9);
 const preview=await service.election().previewImpact(cid,choices,d.campaign.version);
 assert.equal(preview.allowed,true);
 const before=d.awards.length;
 await service.election().mutate(cid,{action:'choose_joint',version:d.campaign.version,
  entries:trio.map((id:string,i:number)=>({member_id:id,dates:free.slice(i*3,i*3+3)}))});
 assert.equal((await service.view(cid)).awards.length,before+9);
});
