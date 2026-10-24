import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultConfig} from '../domain/defaults.ts';
import {calendar} from '../domain/calendar.ts';
import {calculate} from '../domain/vacations.ts';
import {policyState2027} from '../domain/election-2027.ts';
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

test('a locally available seat can be blocked by remaining global cycle minimums',()=>{
 const state:PolicyState={
  cycles:[
   {date:'p0',period:0},{date:'p1',period:0},
   {date:'s0',period:1},{date:'o0',period:2},{date:'o1',period:2}
  ],
  members:Array.from({length:10},(_,i)=>({id:'m'+i,entitlement:1})),
  awards:[
   {member_id:'m0',cycle_date:'p0'},{member_id:'m1',cycle_date:'p0'},
   {member_id:'m2',cycle_date:'p1'},{member_id:'m3',cycle_date:'p1'},
   {member_id:'m4',cycle_date:'s0'},
   {member_id:'m5',cycle_date:'o0'},{member_id:'m6',cycle_date:'o0'},
   {member_id:'m7',cycle_date:'o1'},{member_id:'m8',cycle_date:'o1'}
  ]
 };
 // A complete baseline of two per cycle exists by giving m9 summer.
 const feasible=canComplete2027(state,{maxChecks:2000});
 assert.equal(feasible.status,'possible',feasible.reason);
 assert.equal(feasible.witness?.[0]?.cycle_date,'s0');
 // p0 has a legal local third place, but taking it strands summer at one.
 const result=evaluate2027Candidate(state,[{member_id:'m9',cycle_date:'p0'}]);
 assert.equal(result.allowed,false);
 assert.ok(result.issues.some(i=>i.code==='SUMMER_MINIMUM_IMPOSSIBLE'));
 assert.ok(result.issues.some(i=>i.code==='CYCLE_MINIMUM_IMPOSSIBLE'));
 assert.equal(result.issues.some(i=>i.code==='CYCLE_MAXIMUM'),false);
 assert.equal(state.awards.length,9);
});

test('small exact oracle: global feasibility agrees with independent exhaustive enumerator',()=>{
 const cycles=[
  {date:'p0',period:0 as const},{date:'p1',period:0 as const},
  {date:'s0',period:1 as const},{date:'o0',period:2 as const}
 ];
 const members=Array.from({length:3},(_,i)=>({id:'m'+i,entitlement:3}));
 const edges=members.flatMap(m=>cycles.map(c=>({member_id:m.id,cycle_date:c.date})));
 // Independent enumerator: every CTA must select 3 of the 4 cycles.
 const allFull:PolicyState['awards'][]=[];
 for(let omit0=0;omit0<4;omit0++)
  for(let omit1=0;omit1<4;omit1++)
   for(let omit2=0;omit2<4;omit2++){
    allFull.push(members.flatMap((m,i)=>cycles.filter((_,j)=>j!==[omit0,omit1,omit2][i])
      .map(c=>({member_id:m.id,cycle_date:c.date}))));
   }
 const validFinals=allFull.filter(awards=>evaluate2027Final({cycles,members,awards}).valid);
 assert.ok(validFinals.length>0,'the independent oracle must have viable final states');
 let checked=0;
 for(let i=0;i<edges.length;i++)for(let j=i+1;j<edges.length;j++){
  const awards=[edges[i],edges[j]];
  const expected=validFinals.some(full=>awards.every(a=>full.some(f=>f.member_id===a.member_id&&f.cycle_date===a.cycle_date)));
  const completion=canComplete2027({cycles,members,awards},{maxChecks:2000});
  assert.notEqual(completion.status,'indeterminate','tiny campaign should always be decided');
  assert.equal(completion.status==='possible',expected,JSON.stringify(awards));
  if(expected)assert.ok(evaluate2027Final({cycles,members,awards:[...awards,...completion.witness!]}).valid);
  checked++;
 }
 assert.equal(checked,66);
});

test('preverano warning persists in an incomplete allocation only when the third single is unavoidable',()=>{
 const full=completed([1,1,1,3,3,4],[2,2,2],[2,2,2]);
 const summerAward=full.awards.find(a=>a.cycle_date==='s0')!;
 const stillNeedsSummer={...full,awards:full.awards.filter(a=>a!==summerAward)};
 const inevitable=evaluate2027Candidate(stillNeedsSummer,[]);
 assert.equal(inevitable.completion.status,'possible');
 assert.ok(inevitable.warnings.some(w=>w.code==='PRE_SINGLE_3'));

 const preAward=full.awards.find(a=>a.cycle_date==='p0')!;
 const canAvoidThird={...full,awards:full.awards.filter(a=>a!==preAward)};
 const avoidable=evaluate2027Candidate(canAvoidThird,[]);
 assert.equal(avoidable.completion.status,'possible');
 assert.equal(avoidable.warnings.some(w=>w.code==='PRE_SINGLE_3'),false);
 assert.equal(canAvoidThird.awards.filter(a=>a.cycle_date==='p0').length,0);
});

test('warnings remain visible through calculate during a real-sized incomplete 2027 campaign',()=>{
 const team='A', config=defaultConfig(2027),dates=calendar(2027,team,config);
 const pre=dates.filter(c=>c.period===0).slice(0,3).map(c=>c.date);
 config.specialQuotas=Object.fromEntries(pre.map(d=>[d,1]));
 const members=Array.from({length:20},(_,i)=>({id:'m'+i,code:'CTA'+i,seniority:''}));
 const state=policyState2027(2027,team,config,members,[]);
 const complete=canComplete2027(state,{maxChecks:1000});
 assert.equal(complete.status,'possible',complete.reason);
 const full=complete.witness!.map((a,i)=>({...a,id:'a'+i}));
 assert.ok(evaluate2027Final({...state,awards:full}).warnings.some(w=>w.code==='PRE_SINGLE_3'));
 const summerDate=dates.find(c=>c.period===1)!.date;
 const remove=full.find(a=>a.cycle_date===summerDate)!;
 const partial=full.filter(a=>a!==remove);
 const view=calculate(2027,team,config,members,[],partial);
 assert.ok(view.policyWarnings.some(w=>w.code==='PRE_SINGLE_3'),JSON.stringify(view.policyWarnings));
 assert.ok(view.warnings.some(text=>text.includes('Preverano')));
 assert.equal(view.issues.length,0,view.issues.join('; '));
});
