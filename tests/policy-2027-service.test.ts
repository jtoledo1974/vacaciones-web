import test from 'node:test';
import assert from 'node:assert/strict';
import {Service} from '../server/service.ts';
import {SQLiteRepo} from './sqlite-repo.ts';
import {OCCUPANCY_POLICY_2027} from '../domain/policy-2027.ts';

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
 await service.election().mutate(cid,{action:'choose',version:d.campaign.version,memberId:user,dates:[preferred[0]]});
 let chosen=await service.view(cid);
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
