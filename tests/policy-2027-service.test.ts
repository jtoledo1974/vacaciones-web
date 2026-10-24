import test from 'node:test';
import assert from 'node:assert/strict';
import {Service} from '../server/service.ts';
import {SQLiteRepo} from './sqlite-repo.ts';
import {OCCUPANCY_POLICY_2027,canComplete2027,evaluate2027Final} from '../domain/policy-2027.ts';
import {policyState2027} from '../domain/election-2027.ts';

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
 const preflight=await service.election().previewImpact(cid,
  [{member_id:user,cycle_date:preferred[0]}],d.campaign.version);
 assert.equal(preflight.allowed,true);
 assert.ok(preflight.impact);
 await service.election().mutate(cid,{action:'choose',version:d.campaign.version,memberId:user,dates:[preferred[0]]});
 let chosen=await service.view(cid);
 const auditChoice=chosen.election.timeline.find((event:any)=>event.kind==='choice'&&
  event.choices.some((choice:any)=>choice.member_id===user&&choice.cycle_date===preferred[0]));
 assert.ok(auditChoice?.impact,'the impact was committed with the choice');
 assert.deepEqual(auditChoice.impact.changes,preflight.impact?.changes);
 await assert.rejects(service.election().previewImpact(cid,
  [{member_id:user,cycle_date:preferred[0]}],d.campaign.version),/cambió/i);
 assert.equal(chosen.awards.length,1);
 assert.equal(chosen.awards[0].cycle_date,preferred[0]);
 const undoId=chosen.election.undo;
 assert.ok(undoId);
 await service.election().mutate(cid,{action:'election_undo',version:chosen.campaign.version,historyId:undoId});
 const undone=await service.view(cid);
 assert.equal(undone.awards.length,0);
 assert.equal(undone.election.turn.memberId,user);
 assert.deepEqual(undone.election.preferences.find((p:any)=>p.member_id===user)?.dates,preferred);
 assert.ok(undone.election.redo);
 await service.election().mutate(cid,{action:'election_redo',version:undone.campaign.version,historyId:undone.election.redo});
 chosen=await service.view(cid);
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
  /plazas físicas|completación|capacidad|vacaciones restantes/i);
 const after=await service.view(cid);
 assert.equal(after.campaign.version,beforeVersion);
 assert.equal(after.members.length,beforeMembers);
 assert.equal(after.awards.length,beforeAwards);
 assert.equal(after.awards[0].cycle_date,date);
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
 await service.election().mutate(cid,{action:'reconstruction_step',kind:'choose_joint',mode:'original',version:d.campaign.version});
 d=await service.view(cid);
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
 const initial=completion.witness!;
 const count=(list:typeof initial,date:string)=>list.filter(a=>a.cycle_date===date);
 const candidates=[initial];
 let shifted:typeof initial|null=null;
 if(!policy.cycles.some(c=>c.period===1&&count(initial,c.date).length===3)){
  for(const post of policy.cycles.filter(c=>c.period===2&&count(initial,c.date).length===3)){
   for(const summer of policy.cycles.filter(c=>c.period===1&&count(initial,c.date).length===2)){
    const moving=count(initial,post.date).find(a=>!count(initial,summer.date).some(b=>b.member_id===a.member_id));
    if(moving){
     const redistributed=initial.map(a=>a===moving?{...a,cycle_date:summer.date}:a);
     if(evaluate2027Final({...policy,awards:redistributed}).valid)candidates.push(redistributed);
    }
   }
  }
 }
 for(const baseline of candidates){
  for(const target of policy.cycles.filter(c=>c.period===0&&!c.fourthExcluded&&count(baseline,c.date).length===3)){
   for(const source of policy.cycles.filter(c=>c.period===1&&count(baseline,c.date).length===3)){
    const moving=count(baseline,source.date).find(a=>!count(baseline,target.date).some(b=>b.member_id===a.member_id));
    if(!moving)continue;
    const candidate=baseline.map(a=>a===moving?{...a,cycle_date:target.date}:a);
    const final=evaluate2027Final({...policy,awards:candidate});
    if(final.valid&&final.warnings.some(w=>w.code==='CROSS_PERIOD_FLEXIBILITY')){shifted=candidate;break;}
   }
   if(shifted)break;
  }
  if(shifted)break;
 }
  assert.ok(shifted,'A valid provisional cross-period allocation must be constructible');
 const final=evaluate2027Final({...policy,awards:shifted!});
 assert.equal(final.valid,true,JSON.stringify(final.issues));
 assert.ok(final.warnings.some(w=>w.code==='CROSS_PERIOD_FLEXIBILITY'));
 await repo.batch(shifted!.map((award,i)=>({
  sql:'INSERT INTO awards(id,campaign_id,member_id,cycle_date,version) VALUES(?,?,?,?,1)',
  args:['fixture-award-'+i,cid,award.member_id,award.cycle_date]
 })));
 d=await service.view(cid);
 assert.equal(d.result.issues.length,0);
 assert.equal(d.result.policyWarnings.some((w:any)=>w.code==='CROSS_PERIOD_FLEXIBILITY'),true);
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
 await assert.rejects(service.mutate(cid,{action:'publish',version:d.campaign.version,runId}),
  /Confirma expresamente los avisos/);
 assert.equal((await service.load(cid)).campaign.status,'open');
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
