import test from 'node:test';
import assert from 'node:assert/strict';
import {runElectionCommand} from '../app/election-command.ts';

const view=(version:number,pendingAutomatic=false)=>({campaign:{id:'local-campaign',version},election:{pendingAutomatic}});

test('publishes each confirmed automatic step before requesting the next and uses its version',async()=>{
 const events:string[]=[];
 const result=await runElectionCommand(async body=>{
  events.push('request:'+body.action+':'+body.version);
  return view(Number(body.version)+1,Number(body.version)<12);
 },{action:'choose',memberId:'member',dates:['2027-01-01']},11,next=>events.push('confirmed:'+next.campaign.version));
 assert.deepEqual(events,['request:choose:11','confirmed:12','request:advance:12','confirmed:13']);
 assert.equal(result.result.campaign.version,13);
});

test('a failed automatic continuation returns the committed result and does not repeat the choice',async()=>{
 const failure=new Error('connection lost'),commands:string[]=[],confirmed:number[]=[];
 const result=await runElectionCommand(async body=>{
  commands.push(body.action);
  if(body.action==='advance')throw failure;
  return view(5,true);
 },{action:'choose'},4,next=>confirmed.push(next.campaign.version));
 assert.equal(result.result.campaign.version,5);
 assert.equal(result.continuationError,failure);
 assert.deepEqual(commands,['choose','advance']);
 assert.deepEqual(confirmed,[5]);
});

test('a rejected initial command is not presented as committed',async()=>{
 const failure=new Error('stale campaign version');
 let confirmed=0;
 await assert.rejects(runElectionCommand(async()=>{throw failure;},{action:'choose'},4,()=>confirmed++),error=>error===failure);
 assert.equal(confirmed,0);
});

test('administrative pause, undo and reconstruction never trigger automatic continuation',async()=>{
 for(const action of ['election_undo','election_redo','pause','link_account','resolve_tie','reconstruction_finish']){
  let requests=0;
  await runElectionCommand(async()=>{requests++;return view(2,true);},{action},1,()=>{});
  assert.equal(requests,1,action);
 }
});
