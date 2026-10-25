import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultConfig,copyConfig} from '../domain/defaults.ts';
import {calendar,validateConfig} from '../domain/calendar.ts';
import {calculate} from '../domain/vacations.ts';
import {policyState2027,cyclesEntitlement2027} from '../domain/election-2027.ts';
import {currentTurn,type ElectionState} from '../domain/election.ts';
import {HR_2027, hr2027Period, hr2027FourthExcluded} from '../domain/hr-2027.ts';
import {OCCUPANCY_POLICY_2027,canComplete2027,evaluate2027Candidate,evaluate2027Final,immediate2027Issues,transplant2027Witness,regularFlowCertificate2027,type PolicyState} from '../domain/policy-2027.ts';

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

test('PRE has two independent extra thirds and a fourth at a different destination',()=>{
 const valid=completed([1,1,2,3,3,4],[2,2,2],[2,2,2]);
 assert.equal(evaluate2027Final(valid).valid,true,JSON.stringify(evaluate2027Final(valid).issues));
 assert.equal(evaluate2027Final(valid,true).valid,true,'Territorial witness is local to PRE');
 assert.equal(evaluate2027Final(valid).warnings.some(w=>w.code==='PRE_SINGLE_3'),false);
 const chained=completed([1,1,4],[2,2,2],[2,2,2]);
 assert.ok(evaluate2027Final(chained).issues.some(w=>w.code==='REDISTRIBUTION_WITNESS'),
   'PRE EC3 and EC4 cannot use the same fourth-place destination');
});

test('three PRE singles do not create a fictitious extra permission',()=>{
 const impossible=completed([1,1,1,3,3,4],[2,2,2],[2,2,2]);
 assert.ok(evaluate2027Final(impossible).issues.some(w=>w.code==='REDISTRIBUTION_WITNESS'));
 assert.equal(evaluate2027Final(impossible).warnings.some(w=>w.code==='PRE_SINGLE_3'),false);
 const flexible=completed([1,1,1,3,3,4],[2,2,2],[3,2,2]);
 assert.equal(evaluate2027Final(flexible).valid,true,JSON.stringify(evaluate2027Final(flexible).issues));
 assert.ok(evaluate2027Final(flexible).warnings.some(w=>w.code==='CROSS_PERIOD_FLEXIBILITY'));
 assert.ok(evaluate2027Final(flexible,true).issues.some(w=>w.code==='REDISTRIBUTION_WITNESS'));
 const fourSingles=completed([1,1,1,1,3,3,4],[2,2,2],[3,2,2]);
 assert.ok(evaluate2027Final(fourSingles).issues.some(w=>w.code==='PRE_SINGLE_LIMIT'));
});

test('PRE fourth cannot use a donor that becomes a new single',()=>{
 const noDouble=completed([1,1,1,3,3,4],[2,2,2],[2,2,2]);
 assert.ok(evaluate2027Final(noDouble).issues.some(w=>w.code==='REDISTRIBUTION_WITNESS'));
 const withDouble=completed([1,1,2,3,3,4],[2,2,2],[2,2,2]);
 assert.ok(evaluate2027Final(withDouble).valid);
});

test('POST third and fourth can chain on one destination',()=>{
 const chained=completed([2,2,2],[2,2,2],[1,1,4]);
 assert.equal(evaluate2027Final(chained).valid,true,JSON.stringify(evaluate2027Final(chained).issues));
 assert.equal(evaluate2027Final(chained,true).valid,true);
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
  assert.equal(OCCUPANCY_POLICY_2027,'lecs-2027-occupancy-v2');
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

test('a fifth candidate does not invalidate the four already-authorised occupants',()=>{
 const cycles=[{date:'2027-01-01',period:0 as const}];
 const members=Array.from({length:5},(_,i)=>({id:'m'+i,entitlement:1}));
 const awards=members.slice(0,4).map(m=>({member_id:m.id,cycle_date:'2027-01-01'}));
 const rejected=immediate2027Issues({cycles,members,awards},[{member_id:'m4',cycle_date:'2027-01-01'}]);
 const capacity=rejected.find(issue=>issue.code==='CYCLE_MAXIMUM');
 assert.ok(capacity);
 assert.match(capacity.message,/ya tiene sus 4 plazas autorizadas ocupadas/);
 assert.match(capacity.message,/No se puede adjudicar una 5/);
 assert.match(capacity.message,/las 4 existentes son válidas/);
 assert.equal(awards.length,4,'the fifth candidate cannot alter existing awards');
 const red=immediate2027Issues({
  cycles:[{date:'2027-01-01',period:0,fourthExcluded:true}],
  members,awards:awards.slice(0,3)
 },[{member_id:'m3',cycle_date:'2027-01-01'}]);
 assert.ok(red.some(issue=>issue.code==='FOURTH_EXCLUDED'&&/ya tiene tres personas y RR. HH. excluye su cuarta plaza/.test(issue.message)));
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

/**
 * Transfer one place from a POST third to a PRE fourth. The POST donor
 * becomes double, while PRE has no eligible local double donor. This is
 * admissible provisionally but not under the territorial reading.
 */
function crossPeriodTeamA(){
 const config=defaultConfig(2027);
 const members=Array.from({length:20},(_,i)=>({id:'m'+i,code:'CTA'+i,seniority:''}));
 const state=policyState2027(2027,'A',config,members,[]);
 const completion=canComplete2027(state,{maxChecks:1000});
 assert.equal(completion.status,'possible',completion.reason);
 const awards=completion.witness!;
 const candidates=[awards];
 const count=(list:typeof awards,date:string)=>list.filter(a=>a.cycle_date===date);
 // The first exact completion may put every summer cycle at two. Create
 // an ordinary 2/3 redistribution from POST into summer before the test
 // transfer if a summer three does not yet exist.
 if(!state.cycles.some(c=>c.period===1&&count(awards,c.date).length===3)){
  for(const post of state.cycles.filter(c=>c.period===2&&count(awards,c.date).length===3)){
   for(const summer of state.cycles.filter(c=>c.period===1&&count(awards,c.date).length===2)){
    const moving=count(awards,post.date).find(a=>!count(awards,summer.date).some(b=>a.member_id===b.member_id));
    if(moving){
     const redistributed=awards.map(a=>a===moving?{...a,cycle_date:summer.date}:a);
     if(evaluate2027Final({...state,awards:redistributed}).valid)candidates.push(redistributed);
    }
   }
  }
 }
 for(const baseline of candidates){
  for(const target of state.cycles.filter(c=>c.period===0&&!c.fourthExcluded&&count(baseline,c.date).length===3)){
   for(const source of state.cycles.filter(c=>c.period===1&&count(baseline,c.date).length===3)){
    const moving=count(baseline,source.date).find(a=>!count(baseline,target.date).some(b=>b.member_id===a.member_id));
    if(!moving)continue;
    const shifted=baseline.map(a=>a===moving?{...a,cycle_date:target.date}:a);
    const final=evaluate2027Final({...state,awards:shifted});
    const summerMin=state.cycles.find(c=>c.period===1&&count(shifted,c.date).length===2);
    if(final.valid&&summerMin&&final.warnings.some(w=>w.code==='CROSS_PERIOD_FLEXIBILITY'))
     return {config,members,state,awards:shifted,source:summerMin.date};
   }
  }
 }
  throw Error('Expected a verifiable cross-period move in team A');
}

test('the permitted cross-period transfer triggers a territorial warning, not an old PRE limit',()=>{
 const {state,awards,source}=crossPeriodTeamA();
 const final=evaluate2027Final({...state,awards});
 assert.equal(final.valid,true);
 assert.ok(final.warnings.some(w=>w.code==='CROSS_PERIOD_FLEXIBILITY'));
 assert.ok(final.warnings.some(w=>w.code==='SUMMER_REFERENCE') ||
   final.warnings.every(w=>w.code!=='PRE_SINGLE_3'));
 assert.ok(evaluate2027Final({...state,awards},true).issues.some(w=>w.code==='REDISTRIBUTION_WITNESS'));
 const missing=awards.find(a=>a.cycle_date===source)!;
 const partial={...state,awards:awards.filter(a=>a!==missing)};
 const check=evaluate2027Candidate(partial,[]);
 assert.equal(check.completion.status,'possible',check.completion.reason);
 assert.ok(check.warnings.some(w=>w.code==='CROSS_PERIOD_FLEXIBILITY'),JSON.stringify(check.warnings));
 assert.ok(!check.warnings.some(w=>w.code.startsWith('PRE_SINGLE')));
});

test('calculate keeps policy warnings visible to ordinary team members',()=>{
 const {config,members,awards,source}=crossPeriodTeamA();
 const removed=awards.find(a=>a.cycle_date===source)!;
 const partial=awards.filter(a=>a!==removed).map((a,i)=>({...a,id:'a'+i}));
 const view=calculate(2027,'A',config,members,[],partial);
 assert.ok(view.policyWarnings.some(w=>w.code==='CROSS_PERIOD_FLEXIBILITY'),JSON.stringify(view.policyWarnings));
 assert.ok(view.warnings.some(text=>/estricta|periodos/i.test(text)));
 assert.equal(view.issues.length,0,view.issues.join('; '));
});

test('2027 individual HR exceptions must be authorized, change effective rights and never copy to another year',()=>{
 const config=defaultConfig(2027);
 config.individualEntitlements={X:{cycles:0,authorization:'Acuerdo específico RRHH referencia prueba R-27'},Y:{cycles:3,authorization:'Acuerdo específico RRHH referencia prueba S-27'}};
 assert.doesNotThrow(()=>validateConfig(config,2027));
 const members=[{id:'x',code:'X',seniority:''},{id:'y',code:'Y',seniority:''}];
 assert.equal(cyclesEntitlement2027(config,members[0]),0);
 assert.equal(cyclesEntitlement2027(config,members[1]),3);
 const snapshot=policyState2027(2027,'A',config,members,[]);
 assert.deepEqual(snapshot.members.map(m=>m.entitlement),[0,3]);
 assert.equal(calculate(2027,'A',config,members,[],[]).totals.necessary,3);
 const next=copyConfig(config,2027,2028);
 assert.equal(next.individualEntitlements,undefined);
 config.individualEntitlements.X.authorization='';
 assert.throws(()=>validateConfig(config,2027),/excepción individual/);
 const outsideYear={...copyConfig(defaultConfig(2027),2027,2028),
  individualEntitlements:{X:{cycles:3,authorization:'Documento RRHH referencia R-27'}}};
 assert.throws(()=>validateConfig(outsideYear,2028),/este ejercicio/);
});

test('2027 election skips controllers with approved lower entitlement without changing other members',()=>{
 const config=defaultConfig(2027);
 config.individualEntitlements={X:{cycles:0,authorization:'Autorización de RRHH específica para X'}};
 const members=[{id:'x',code:'X',seniority:''},{id:'y',code:'Y',seniority:''}];
 const state:ElectionState={
  status:'active',order:['x','y'],cursor:0,credits:{},source:'Prueba documentada',
  allowDeferral:true
 };
 const turn=currentTurn({year:2027,team:'A',config,members,requests:[],awards:[]},state);
 assert.equal(turn.memberId,'y');
 assert.equal(turn.needed,1);
 assert.equal(turn.state.cursor,1);
});

test('a completed 2027 allocation is decided immediately without a bounded search',()=>{
 const full=completed([1,1,2,3,3,4],[2,2,2],[2,2,2]);
 assert.equal(evaluate2027Final(full).valid,true);
 const relaxed=canComplete2027(full,{maxChecks:0});
 assert.equal(relaxed.status,'possible');
 assert.equal(relaxed.checked,1);
 assert.deepEqual(relaxed.witness,[]);
 const strict=canComplete2027(full,{strictRegions:true,maxChecks:0});
 assert.equal(strict.status,'possible');
 assert.equal(strict.checked,1);
 const summer=full.awards.filter(a=>a.cycle_date.startsWith('s')).length;
 assert.equal(canComplete2027(full,{summerTotal:summer,maxChecks:0}).status,'possible');
 assert.equal(canComplete2027(full,{summerTotal:summer+1,maxChecks:0}).status,'impossible');
 const broken={...full,awards:full.awards.slice(0,-1)};
 assert.notEqual(canComplete2027(broken,{maxChecks:0}).status,'possible');
});

test('a sound two-person swap reuses a completed 2027 witness without any search',()=>{
 const full=completed([2,2,2],[2,2,2],[2,2,2]);
 assert.equal(evaluate2027Final(full).valid,true);
 const first={member_id:'m0',cycle_date:'p0'},second={member_id:'m2',cycle_date:'p1'};
 const original=(a:{member_id:string;cycle_date:string})=>a.member_id===first.member_id&&a.cycle_date===first.cycle_date
  ||a.member_id===second.member_id&&a.cycle_date===second.cycle_date;
 const partial:PolicyState={...full,awards:full.awards.filter(a=>!original(a))};
 const witness=full.awards.filter(original);
 assert.equal(canComplete2027(partial).status,'possible');
 const choice={member_id:'m0',cycle_date:'p1'};
 const result=evaluate2027Candidate(partial,[choice],0,witness);
 assert.equal(result.allowed,true);
 assert.equal(result.completion.checked,0,'Reusing a verified swap must avoid running the solver');
 assert.deepEqual(result.completion.witness,[{member_id:'m2',cycle_date:'p0'}]);
 const final={...partial,awards:[...partial.awards,choice,...result.completion.witness!]};
 assert.equal(evaluate2027Final(final).valid,true);
 const direct=evaluate2027Candidate(partial,[first],0,witness);
 assert.equal(direct.allowed,true);
 assert.equal(direct.completion.checked,0);
 const unsafe=[{member_id:'m1',cycle_date:'p1'}];
 assert.equal(transplant2027Witness(partial,choice,unsafe),null,'Forged proofs must not be accepted');
 const already={...partial,awards:[...partial.awards,choice]};
 assert.equal(transplant2027Witness(already,choice,witness),null,'Cannot award an already confirmed cycle');
});

test('witness reuse and full 2027 evaluator agree across all period boundaries of team A',()=>{
 const config=defaultConfig(2027),calendarA=calendar(2027,'A',config);
 const members=Array.from({length:20},(_,i)=>({id:'m'+i,code:'CTA'+i,seniority:''}));
 const initial=policyState2027(2027,'A',config,members,[]);
 const found=canComplete2027(initial,{maxChecks:1000});
 assert.equal(found.status,'possible',found.reason);
 const proof=found.witness!;
 const member=members[0].id;
 const targets=[...new Set([
  ...calendarA.filter(c=>c.period===0).slice(0,2).map(c=>c.date),
  ...calendarA.filter(c=>c.period===1).slice(0,2).map(c=>c.date),
  ...calendarA.filter(c=>c.period===2).slice(0,2).map(c=>c.date),
  ...proof.filter(a=>a.member_id===member).slice(0,2).map(a=>a.cycle_date)
 ])];
 let reused=0;
 for(const cycle_date of targets){
  const choice={member_id:member,cycle_date};
  const ordinary=evaluate2027Candidate(initial,[choice],2000);
  const accelerated=evaluate2027Candidate(initial,[choice],2000,proof);
  if(ordinary.completion.status!=='indeterminate'){
   assert.equal(accelerated.allowed,ordinary.allowed,cycle_date);
   assert.equal(accelerated.completion.status,ordinary.completion.status,cycle_date);
   assert.deepEqual(accelerated.issues.map(i=>i.code).sort(),ordinary.issues.map(i=>i.code).sort(),cycle_date);
   assert.deepEqual(accelerated.warnings.map(w=>w.code).sort(),ordinary.warnings.map(w=>w.code).sort(),cycle_date);
  }else if(accelerated.allowed){
   // A verifiable constructive proof can resolve a bounded search's uncertainty.
   assert.equal(evaluate2027Final({...initial,awards:[choice,...accelerated.completion.witness!]}).valid,true);
  }
  if(accelerated.completion.checked===0){
   reused++;
   assert.equal(evaluate2027Final({...initial,awards:[choice,...accelerated.completion.witness!]}).valid,true);
  }
 }
 assert.ok(reused>0,'At least the chosen baseline assignments should reuse proven completions');
});

test('late-stage 2027 previews preserve feasibility and report solver reuse without timing assertions',()=>{
 const config=defaultConfig(2027),members=Array.from({length:20},(_,i)=>({id:'m'+i,code:'CTA'+i,seniority:''}));
 const empty=policyState2027(2027,'A',config,members,[]);
 const original=canComplete2027(empty,{maxChecks:1000});
 assert.equal(original.status,'possible');
 const settled=original.witness!.filter((_,i)=>i%5!==0);
 const partial={...empty,awards:settled};
 const base=canComplete2027(partial,{maxChecks:2000});
 assert.equal(base.status,'possible',base.reason);
 const member=original.witness!.find(a=>!settled.some(b=>a.member_id===b.member_id&&a.cycle_date===b.cycle_date))!.member_id;
 const own=new Set(settled.filter(a=>a.member_id===member).map(a=>a.cycle_date));
 const candidates=[
  ...empty.cycles.filter(c=>c.period===0&&!own.has(c.date)).slice(0,2),
  ...empty.cycles.filter(c=>c.period===1&&!own.has(c.date)).slice(0,2),
  ...empty.cycles.filter(c=>c.period===2&&!own.has(c.date)).slice(0,2)
 ].map(c=>({member_id:member,cycle_date:c.date}));
 const classic=[],optimized=[];
 const time0=performance.now();
 for(const choice of candidates)classic.push(evaluate2027Candidate(partial,[choice]));
 const time1=performance.now();
 for(const choice of candidates)optimized.push(evaluate2027Candidate(partial,[choice],2000,base.witness));
 const time2=performance.now();
 let proofs=0;
 for(let i=0;i<candidates.length;i++){
  const x=classic[i],y=optimized[i];
  if(x.completion.status!=='indeterminate'){
   assert.equal(y.allowed,x.allowed,candidates[i].cycle_date);
   assert.deepEqual(y.issues.map(z=>z.code).sort(),x.issues.map(z=>z.code).sort());
  }
  if(y.completion.checked===0){
   proofs++;
   assert.ok(y.allowed);
   assert.ok(evaluate2027Final({...partial,awards:[...partial.awards,candidates[i],...y.completion.witness!]}).valid);
  }
 }
 console.info('2027 A partial availability diagnostic:',JSON.stringify({
  assigned:settled.length,candidates:candidates.length,verifiedProofs:proofs,
  baselineMs:Math.round(time1-time0),reusedMs:Math.round(time2-time1)
 }));
});

test('ordinary PRE thirds admit a flow certificate with a single solver check',()=>{
 const cycles=[
  ...Array.from({length:17},(_,i)=>({date:'p'+i,period:0 as const})),
  ...Array.from({length:13},(_,i)=>({date:'s'+i,period:1 as const})),
  ...Array.from({length:15},(_,i)=>({date:'o'+i,period:2 as const}))
 ];
 const members=Array.from({length:20},(_,i)=>({id:'m'+i,entitlement:6}));
 const awards=cycles.filter(c=>c.period===0).flatMap((c,i)=>
  Array.from({length:3},(_,j)=>({member_id:'m'+((i*3+j)%20),cycle_date:c.date})));
 const state:PolicyState={cycles,members,awards};
 // All 17 PRE cycles already have three CTA: this is not a reason to
 // enumerate combinations of possible singles and fourths.
 const result=canComplete2027(state,{maxChecks:1});
 assert.equal(result.status,'possible',result.reason);
 assert.equal(result.checked,1,'one circulation proves all remaining entitlements');
 assert.equal(result.witness?.length,69);
 assert.equal(evaluate2027Final({...state,awards:[...awards,...result.witness!]}).valid,true);
 const candidate=evaluate2027Candidate(state,[{member_id:'m0',cycle_date:'s0'}],1,undefined,false);
 assert.equal(candidate.allowed,true,JSON.stringify(candidate.issues));
 assert.equal(candidate.completion.checked,1);
});

test('flow certificate failure never rejects a valid allocation needing singles',()=>{
 const full=completed([1,1,2,3,3,4],[2,2,2],[2,2,2]);
 assert.equal(evaluate2027Final(full).valid,true);
 const missing=full.awards.find(a=>a.cycle_date==='p0')!;
 const partial={...full,awards:full.awards.filter(a=>a!==missing)};
 assert.equal(regularFlowCertificate2027(partial),null);
 const completion=canComplete2027(partial,{maxChecks:100});
 assert.equal(completion.status,'possible',completion.reason);
 assert.ok(completion.witness?.some(a=>a.member_id===missing.member_id&&a.cycle_date==='p0'));
});
