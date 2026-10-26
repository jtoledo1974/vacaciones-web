import test from 'node:test';
import assert from 'node:assert/strict';
import {Service} from '../server/service.ts';
import {SQLiteRepo} from './sqlite-repo.ts';
import {registerPolicy,occupancyFor,policyFor} from '../domain/policy.ts';
import {POLICY_2099,POLICY_2099_VERSION,POLICY_2099_MAX} from './policy-2099.ts';

const owner={id:'chatgpt:owner',role:'superadmin' as const,teams:[]};
const visitor={id:'chatgpt:person',emailKey:'chatgpt-email:person@example.test',role:'viewer' as const,teams:[]};

/** Nothing from 2027 may leak into a campaign governed by another policy. */
function assertNo2027(label:string,value:unknown){
  const text=JSON.stringify(value),version=occupancyFor(2027)!.version;
  assert.ok(!text.includes(version),label+': aparece la versión '+version);
  assert.ok(!/lecs-2027/i.test(text),label+': aparece una versión lecs-2027');
  assert.ok(!/RRHH 2027|normas 2027/.test(text),label+': aparece un texto de las normas 2027');
}

test('registerPolicy plugs a year and its undo restores the previous resolution',()=>{
  assert.equal(occupancyFor(2099),null);
  const unregister=registerPolicy(2099,POLICY_2099);
  try{assert.equal(occupancyFor(2099)?.version,POLICY_2099_VERSION);}
  finally{unregister();}
  assert.equal(occupancyFor(2099),null);
  const before=policyFor(2027);
  registerPolicy(2027,POLICY_2099)();
  assert.equal(policyFor(2027),before,'undoing an override restores the production policy');
});

test('a fictitious 2099 policy runs the whole generic election flow without 2027 rules',async t=>{
  t.after(registerPolicy(2099,POLICY_2099));
  const repo=new SQLiteRepo(),service=new Service(repo,owner);
  await service.init();
  await service.createCampaigns(2099,null,null);
  let d=await service.view((await service.list()).campaigns.find((c:any)=>c.year===2099&&c.team_id==='A').id);
  const cid=d.campaign.id;
  const codes=Array.from({length:8},(_,i)=>'P'+String(i+1).padStart(2,'0'));
  d=await service.mutate(cid,{action:'import_roster',version:d.campaign.version,
    source:{format:'vacaciones-roster-v1',team:'A',year:2099,copySelections:false,
      rows:codes.map(code=>({code,label:'CTA '+code,seniority:''}))}});
  assert.equal(d.members.length,8);
  assert.equal(d.result.occupancyPolicyVersion,POLICY_2099_VERSION);
  assert.ok(d.result.cycles.every((c:any)=>c.max===POLICY_2099_MAX));
  d=await service.mutate(cid,{action:'config',version:d.campaign.version,
    config:{...d.config,previousScores:Object.fromEntries(codes.map((code,i)=>[code,200+i])),
      previousScoresSource:'Listado de puntuaciones ficticias para el ejercicio 2099'}});
  await service.election().mutate(cid,{action:'start',version:d.campaign.version,rulesConfirmed:true,allowDeferral:true});
  d=await service.view(cid);
  assertNo2027('vista',d);
  assert.equal(d.election.occupancyPolicyVersion,POLICY_2099_VERSION);
  assert.equal(d.election.cycleAvailability.policyVersion,POLICY_2099_VERSION);
  const user=d.election.turn.memberId;
  assert.ok(user);

  const options=await service.election().options(cid,[]);
  assertNo2027('opciones',options);
  assert.equal(options.policyVersion,POLICY_2099_VERSION);
  const date=options.available[0];
  assert.ok(date);

  const preview=await service.election().previewImpact(cid,[{member_id:user,cycle_date:date}],d.campaign.version);
  assertNo2027('impacto',preview);
  assert.equal(preview.allowed,true);
  assert.ok(preview.impact?.changes.some((c:any)=>c.cycle===date&&c.kind==='directOccupancy'));

  await service.election().mutate(cid,{action:'choose',version:d.campaign.version,memberId:user,dates:[date]});
  let chosen=await service.view(cid);
  assertNo2027('vista tras elegir',chosen);
  assert.deepEqual(chosen.awards.map((a:any)=>[a.member_id,a.cycle_date]),[[user,date]]);
  assert.equal(chosen.election.cycleAvailability.cycles[date].occupied,1);
  const choice=chosen.election.timeline.find((e:any)=>e.kind==='choice');
  assert.ok(choice?.impact,'the impact is committed with the choice');
  const [audit]=await repo.all('SELECT after_json FROM audit WHERE id=?',[choice.id]);
  assertNo2027('auditoría',audit);
  assert.equal(JSON.parse(audit.after_json).impact.availabilityAfter.policyVersion,POLICY_2099_VERSION);

  await service.election().mutate(cid,{action:'election_undo',version:chosen.campaign.version,historyId:chosen.election.undo});
  const undone=await service.view(cid);
  assertNo2027('vista tras deshacer',undone);
  assert.equal(undone.awards.length,0);
  assert.equal(undone.election.turn.memberId,user);
  assert.equal(undone.election.cycleAvailability.cycles[date].occupied,0);
  await service.election().mutate(cid,{action:'election_redo',version:undone.campaign.version,historyId:undone.election.redo});
  chosen=await service.view(cid);
  assert.equal(chosen.awards.length,1);
  assert.equal(chosen.election.cycleAvailability.cycles[date].occupied,1);

  // The engine, not a 2027 constant, rejects a cycle beyond its maximum.
  const full=d.result.cycles.find((c:any)=>c.date!==date).date;
  const rules=occupancyFor(2099)!,state=rules.state({year:2099,team:'A',config:chosen.config},chosen.members,
    chosen.members.slice(0,POLICY_2099_MAX).map((m:any)=>({member_id:m.id,cycle_date:full})));
  assert.equal(rules.evaluateCandidate(state,[{member_id:chosen.members[POLICY_2099_MAX].id,cycle_date:full}]).allowed,false);

  const publicView=await new Service(repo,visitor).view(cid);
  assertNo2027('vista pública',publicView);
  assert.equal(publicView.editable,false);
  assert.equal(publicView.config,null);
  assert.equal(publicView.result.occupancyPolicyVersion,POLICY_2099_VERSION);
  assert.equal(publicView.election.cycleAvailability.cycles[date].occupied,1);
});
