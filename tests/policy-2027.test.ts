import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultConfig} from '../domain/defaults.ts';
import {calendar} from '../domain/calendar.ts';
import {HR_2027, hr2027Period, hr2027FourthExcluded} from '../domain/hr-2027.ts';
import {OCCUPANCY_POLICY_2027,canComplete2027,evaluate2027Candidate,evaluate2027Final,immediate2027Issues,type PolicyState} from '../domain/policy-2027.ts';

test('2027 RRHH calendar: every team has exact cycle count and boundary',()=>{
  for(const team of 'ABCDEFGH'){
    const expected=HR_2027[team], cycles=calendar(2027,team,defaultConfig(2027));
    assert.equal(cycles.length,expected.count,team);
    assert.equal(cycles[0].date,expected.first,team);
    assert.equal(cycles.find(c=>c.period===1)?.date,expected.summerFirst,team);
    assert.equal(cycles.filter(c=>c.period===1).at(-1)?.date,expected.summerLast,team);
    for(const red of expected.red)assert.ok(cycles.some(c=>c.date===red),team+' '+red);
  }
  assert.equal(hr2027Period('A','2027-09-29'),2);
  assert.equal(hr2027Period('D','2027-09-24'),2);
  assert.equal(hr2027FourthExcluded('A','2027-03-21'),true);
  assert.equal(hr2027FourthExcluded('A','2027-06-01'),false);
});

function completed(pre:number[],summer:number[],post:number[],memberCount=6):PolicyState {
  const cycles=[...pre.map((_,i)=>({date:'p'+i,period:0 as const})),...summer.map((_,i)=>({date:'s'+i,period:1 as const})),...post.map((_,i)=>({date:'o'+i,period:2 as const}))];
  const capacities=[...pre,...summer,...post],counts=new Array(memberCount).fill(0) as number[];
  const awards:{member_id:string;cycle_date:string}[]=[];let cursor=0;
  for(let i=0;i<cycles.length;i++){
    for(let k=0;k<capacities[i];k++){
      const member=(cursor++)%memberCount;
      awards.push({member_id:'m'+member,cycle_date:cycles[i].date});counts[member]++;
    }
  }
  return {cycles,members:counts.map((entitlement,i)=>({id:'m'+i,entitlement})),awards};
}

test('preverano relaxed rule allows three singles with explicit warning; strict rule rejects',()=>{
  const state=completed([1,1,1,3,3,4],[2,2,2],[2,2,2]);
  const final=evaluate2027Final(state);
  assert.equal(final.valid,true,JSON.stringify(final.issues));
  assert.ok(final.warnings.some(w=>w.code==='PRE_SINGLE_3'));
  assert.ok(evaluate2027Final(state,true).issues.some(x=>x.code==='PRE_SINGLE_LIMIT'));
});

test('postverano permits two singles with one fourth; EC3 and EC4 are independent',()=>{
  const state=completed([2,2,2,2],[2,2,2],[1,1,3,4]);
  assert.equal(evaluate2027Final(state).valid,true,JSON.stringify(evaluate2027Final(state).issues));
  const beyond=completed([2,2,2,2],[2,2,2],[1,1,1,3,4]);
  assert.ok(evaluate2027Final(beyond).issues.some(x=>x.code==='POST_SINGLE_LIMIT'));
});

test('fourth place excluded on HR marked cycles, even if period capacity allows it',()=>{
  const state=completed([2,2,2,4],[2,2,2],[2,2,2]);
  state.cycles[3].fourthExcluded=true;
  assert.ok(evaluate2027Final(state).issues.some(x=>x.code==='FOURTH_EXCLUDED'));
});

test('state initially empty is incomplete yet feasible; witness completes every entitlement',()=>{
  const cycles=[...Array.from({length:4},(_,i)=>({date:'p'+i,period:0 as const})),...Array.from({length:3},(_,i)=>({date:'s'+i,period:1 as const})),...Array.from({length:3},(_,i)=>({date:'o'+i,period:2 as const}))];
  const state:PolicyState={cycles,members:Array.from({length:5},(_,i)=>({id:'m'+i,entitlement:6})),awards:[]};
  const r=canComplete2027(state);
  assert.equal(r.status,'possible',JSON.stringify(r));
  assert.equal(r.witness?.length,30);
  assert.ok(evaluate2027Final({...state,awards:r.witness!}).valid);
  const next=evaluate2027Candidate(state,[{member_id:'m0',cycle_date:'p0'}]);
  assert.equal(next.allowed,true);
});

test('duplicate choice is atomic and globally rejected',()=>{
  const state:PolicyState={cycles:[{date:'p',period:0},{date:'s',period:1},{date:'o',period:2}],members:[{id:'m',entitlement:3}],awards:[]};
  const c=evaluate2027Candidate(state,[{member_id:'m',cycle_date:'p'},{member_id:'m',cycle_date:'p'}]);
  assert.equal(c.allowed,false);
  assert.equal(state.awards.length,0);
});

test('same final allocation is independent of order of the requested dates',()=>{
  const base:PolicyState={cycles:[...Array.from({length:4},(_,i)=>({date:'p'+i,period:0 as const})),...Array.from({length:3},(_,i)=>({date:'s'+i,period:1 as const})),...Array.from({length:3},(_,i)=>({date:'o'+i,period:2 as const}))],members:Array.from({length:5},(_,i)=>({id:'m'+i,entitlement:6})),awards:[]};
  const a=[{member_id:'m0',cycle_date:'p0'},{member_id:'m0',cycle_date:'s0'}];
  const b=[...a].reverse();
  assert.equal(evaluate2027Candidate(base,a).allowed,evaluate2027Candidate(base,b).allowed);
  assert.equal(OCCUPANCY_POLICY_2027,'lecs-2027-occupancy-v1');
});

test('real 2027 calendars A–H have a six-cycle completion witness for the RRHH staffing',()=>{
 for(const team of 'ABCDEFGH'){
  const config=defaultConfig(2027),cycles=calendar(2027,team,config);
  const peopleCount=team==='C'?19:20;
  const state:PolicyState={
   cycles:cycles.map(c=>({date:c.date,period:c.period as 0|1|2,fourthExcluded:hr2027FourthExcluded(team,c.date)})),
   members:Array.from({length:peopleCount},(_,i)=>({id:'m'+i,entitlement:6})),
   awards:[]
  };
  const completion=canComplete2027(state,{maxChecks:1000});
  assert.equal(completion.status,'possible',team+': '+completion.reason);
  assert.equal(completion.witness?.length,peopleCount*6);
  const final=evaluate2027Final({...state,awards:completion.witness!});
  assert.equal(final.valid,true,team+': '+JSON.stringify(final.issues));
 }
});

test('unavailable fourth slot reports exact RRHH exclusion (not a generic no-completion)',()=>{
 const state:PolicyState={
   cycles:[{date:'pre-red',period:0,fourthExcluded:true},{date:'summer',period:1},{date:'post',period:2}],
   members:Array.from({length:5},(_,i)=>({id:'m'+i,entitlement:3})),
   awards:Array.from({length:3},(_,i)=>({member_id:'m'+i,cycle_date:'pre-red'}))
 };
 const choice=evaluate2027Candidate(state,[{member_id:'m3',cycle_date:'pre-red'}]);
 assert.equal(choice.allowed,false);
 assert.equal(choice.issues[0]?.code,'FOURTH_EXCLUDED');
 assert.equal(choice.issues[0]?.cycle,'pre-red');
 assert.equal(choice.completion.checked,0);
});

test('fourth places elsewhere in summer use a common limit and have a precise explanation',()=>{
 const cycles=['a','b','c'].map(date=>({date,period:1 as const}));
 const members=Array.from({length:6},(_,i)=>({id:'m'+i,entitlement:6}));
 const awards=cycles.flatMap((cycle,i)=>Array.from({length:i<2?4:3},(_,j)=>({member_id:'m'+j,cycle_date:cycle.date})));
 const state:PolicyState={cycles,members,awards};
 const check=evaluate2027Candidate(state,[{member_id:'m4',cycle_date:'c'}]);
 assert.equal(check.allowed,false);
 assert.ok(check.issues.some(issue=>issue.code==='FOURTH_LIMIT'&&issue.period===1));
 assert.equal(immediate2027Issues(state,[{member_id:'m4',cycle_date:'c'}]).some(i=>i.code==='FOURTH_LIMIT'),true);
});

test('candidate reports duplicate and entitlement limits with stable codes',()=>{
 const state:PolicyState={
   cycles:[{date:'p',period:0},{date:'s',period:1},{date:'o',period:2}],
   members:[{id:'m',entitlement:1}],
   awards:[{member_id:'m',cycle_date:'p'}]
 };
 assert.ok(evaluate2027Candidate(state,[{member_id:'m',cycle_date:'p'}]).issues.some(i=>i.code==='DUPLICATE_AWARD'));
 assert.ok(evaluate2027Candidate(state,[{member_id:'m',cycle_date:'s'}]).issues.some(i=>i.code==='ENTITLEMENT_EXCEEDED'));
});

test('a locally available seat can be blocked by the remaining global cycle minimums',()=>{
 const state:PolicyState={
  cycles:[{date:'p',period:0},{date:'s',period:1},{date:'o',period:2}],
  members:Array.from({length:4},(_,i)=>({id:'m'+i,entitlement:1})),
  awards:[{member_id:'m0',cycle_date:'p'}]
 };
 // One award in pre is possible; a second one would strand summer/post.
 assert.equal(canComplete2027(state).status,'possible');
 const result=evaluate2027Candidate(state,[{member_id:'m1',cycle_date:'p'}]);
 assert.equal(result.allowed,false);
 assert.ok(result.issues.some(i=>i.code==='CYCLE_MINIMUM_IMPOSSIBLE'));
 assert.equal(result.issues.some(i=>i.code==='CYCLE_MAXIMUM'),false);
 assert.equal(state.awards.length,1);
});
