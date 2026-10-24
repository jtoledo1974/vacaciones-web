import test from 'node:test';
import assert from 'node:assert/strict';
import {
 availabilityByCycle, availabilityImpact, previewChoiceImpact, constructCycleWitness2027
} from '../domain/availability-2027.ts';
import {
 canComplete2027, evaluate2027Final, reassign2027Witness, type PolicyState, type PolicyAward
} from '../domain/policy-2027.ts';

function completedState():PolicyState {
 const counts=[2,2,2,4,4,3,2,2,2];
 const cycles=counts.map((_,i)=>({
  date:i<3?'pre'+i:i<6?'summer'+(i-3):'post'+(i-6),
  period:(i<3?0:i<6?1:2) as 0|1|2
 }));
 const memberCounts=new Array(6).fill(0) as number[];
 const awards:PolicyAward[]=[];
 let cursor=0;
 for(const [i,count] of counts.entries()){
  for(let n=0;n<count;n++){
   const member=cursor++%6;
   memberCounts[member]++;
   awards.push({member_id:'m'+member,cycle_date:cycles[i].date});
  }
 }
 const state:PolicyState={cycles,members:memberCounts.map((entitlement,i)=>({
  id:'m'+i,entitlement
 })),awards};
 assert.equal(evaluate2027Final(state).valid,true);
 return state;
}

test('a globally forbidden fourth is blocked although its local slot is empty',()=>{
 const full=completedState();
 const current=availabilityByCycle(full,{maxChecks:50,useCache:false});
 const summerThird=current.cycles.summer2;
 assert.equal(summerThird.occupied,3);
 assert.equal(summerThird.localMaximum,4);
 assert.equal(summerThird.additional,0);
 assert.equal(summerThird.slots[3].status,'blocked');
 assert.equal(summerThird.slots[3].reasons[0].code,'FOURTH_PERIOD_LIMIT');
 assert.equal(summerThird.slots[2].status,'occupied');
});

test('a summer fourth can close an alternative fourth but not retroactively invalidate thirds',()=>{
 const full=completedState();
 const awarded=full.awards.findLast(a=>a.cycle_date==='summer1')!;
 const before:PolicyState={...full,awards:full.awards.filter(a=>a!==awarded)};
 assert.equal(canComplete2027(before).status,'possible');
 const original=availabilityByCycle(before,{maxChecks:100,useCache:false});
 assert.equal(original.cycles.summer2.additional,1,
  'the unfilled fourth can move to an alternative summer cycle');
 const next=availabilityByCycle(full,{maxChecks:100,useCache:false});
 assert.equal(next.cycles.summer2.additional,0);
 const impact=availabilityImpact(before,full,{maxChecks:100,useCache:false});
 assert.equal(impact.status,'exact');
 const outside=impact.changes.find(c=>c.cycle==='summer2')!;
 assert.equal(outside.kind,'globalConstraint');
 assert.equal(outside.delta,-1);
 assert.ok(outside.reasons.some(x=>x.code==='FOURTH_PERIOD_LIMIT_REACHED'));
 const own=impact.changes.find(c=>c.cycle==='summer1')!;
 assert.equal(own.kind,'directOccupancy');
 assert.equal(own.delta,-1);
 assert.ok(impact.events.some(x=>x.code==='FOURTH_PERIOD_LIMIT_REACHED'&&x.period===1));
 const preview=previewChoiceImpact(before,[awarded],{maxChecks:100,useCache:false});
 assert.equal(preview.allowed,true);
 assert.deepEqual(preview.impact?.changes,impact.changes);
 assert.equal(before.awards.length,full.awards.length-1,'preview must be pure');
});

test('red exclusion only blocks the fourth place, not the third by itself',()=>{
 const base=completedState();
 const red:PolicyState={
  ...base,cycles:base.cycles.map(c=>c.date==='pre0'?{...c,fourthExcluded:true}:c)
 };
 const availability=availabilityByCycle(red,{maxChecks:100,useCache:false}).cycles.pre0;
 assert.equal(availability.localMaximum,3);
 assert.equal(availability.slots[3].status,'blocked');
 assert.equal(availability.slots[3].reasons[0].code,'FOURTH_EXCLUDED_RED');
 assert.notEqual(availability.slots[2].reasons[0]?.code,'FOURTH_EXCLUDED_RED');
});

test('bounded search never converts an inconclusive computation into zero capacity',()=>{
 const base=completedState();
 const removed=['pre0','summer1'].map(date=>base.awards.find(a=>a.cycle_date===date)!);
 const partial:PolicyState={...base,awards:base.awards.filter(a=>!removed.includes(a))};
 assert.equal(canComplete2027(partial,{maxChecks:0}).status,'indeterminate');
 const report=availabilityByCycle(partial,{maxChecks:0,useCache:false});
 assert.equal(report.status,'indeterminate');
 const target=report.cycles.summer2;
 assert.equal(target.additional,null);
 assert.equal(target.status,'indeterminate');
 assert.equal(target.slots[3].status,'indeterminate');
 assert.equal(target.slots[3].reasons[0].code,'INDETERMINATE');
});

test('a failed atomic preview does not mutate state or fabricate an impact',()=>{
 const base=completedState();
 const selected=base.awards[0];
 const preview=previewChoiceImpact(base,[selected],{maxChecks:100});
 assert.equal(preview.allowed,false);
 assert.equal(preview.impact,null);
 assert.equal(preview.issues[0]?.code,'DUPLICATE_AWARD');
 assert.equal(base.awards.length,23);
});

test('the constrained solver proves an existential target without naming all chosen controllers',()=>{
 const full=completedState();
 const awarded=full.awards.findLast(a=>a.cycle_date==='summer1')!;
 const before:PolicyState={...full,awards:full.awards.filter(a=>a!==awarded)};
 assert.equal(canComplete2027(before,{minimumCycle:{date:'summer2',occupancy:4}}).status,'possible');
 assert.equal(canComplete2027(full,{minimumCycle:{date:'summer2',occupancy:4}}).status,'impossible');
});

test('empty cycles can have four, three, two or one provably feasible additional allocations',()=>{
 const amounts=[1,1,2,3,3,4,2,2,2,2,2,2];
 const cycles=amounts.map((_,i)=>({
  date:i<6?'pre'+i:i<9?'summer'+(i-6):'post'+(i-9),
  period:(i<6?0:i<9?1:2) as 0|1|2
 }));
 const counts=Array.from({length:6},()=>0);
 const awards:PolicyAward[]=[];
 let cursor=0;
 for(const [i,n] of amounts.entries())for(let k=0;k<n;k++){
  const m=cursor++%6;
  counts[m]++;
  awards.push({member_id:'m'+m,cycle_date:cycles[i].date});
 }
 const final:PolicyState={cycles,members:counts.map((entitlement,i)=>({id:'m'+i,entitlement})),awards};
 assert.equal(evaluate2027Final(final).valid,true);
 for(const [date,expected] of [['pre0',1],['pre2',2],['pre3',3],['pre5',4]] as const){
  const state:PolicyState={...final,awards:awards.filter(a=>a.cycle_date!==date)};
  assert.equal(state.awards.filter(a=>a.cycle_date===date).length,0);
  const cycle=availabilityByCycle(state,{maxChecks:5000,useCache:false}).cycles[date];
  assert.equal(cycle.status,'exact',date);
  assert.equal(cycle.additional,expected,date);
  assert.equal(cycle.slots.filter(s=>s.status==='available').length,expected,date);
 }
});

test('an empty cycle with A=0 cannot be called a valid completion under final minimums',()=>{
 const full=completedState();
 const extra={date:'post-unplanned',period:2 as const};
 const impossible:PolicyState={...full,cycles:[...full.cycles,extra]};
 const result=availabilityByCycle(impossible,{maxChecks:100,useCache:false});
 assert.equal(result.status,'invalid');
 assert.equal(result.cycles[extra.date].additional,null,
  'no valid starting completion means invalid, not a fictitious exact zero');
});

test('verified final assignments prove local availability without combinatorial enumeration',()=>{
 const state=completedState(),fullAwards=state.awards;
 const partial:PolicyState={...state,awards:fullAwards.filter(a=>a.cycle_date!=='post0')};
 const witness=fullAwards.filter(a=>a.cycle_date==='post0');
 const proven=constructCycleWitness2027(partial,witness,'post0',2);
 assert.ok(proven,'a verified completion already contains the desired two-person cycle');
 const forced=fullAwards.find(a=>a.cycle_date==='post0')!;
 const fixed={...partial,awards:[...partial.awards,forced]};
 const reassigned=reassign2027Witness(fixed,state);
 assert.ok(reassigned,'exact histogram flow finds an assignment with the fixed choice');
 assert.ok(evaluate2027Final({...fixed,awards:[...fixed.awards,...reassigned!]}).valid);
 const impossible=constructCycleWitness2027(partial,[{member_id:'unknown',cycle_date:'post0'}],'post0',2);
 assert.equal(impossible,null,'a forged witness must never be accepted');
});

test('shared budget bounds full-team availability: no per-cycle multiplication of solver work',()=>{
 const cycles=[
  ...Array.from({length:17},(_,i)=>({date:'p'+i,period:0 as const})),
  ...Array.from({length:13},(_,i)=>({date:'s'+i,period:1 as const})),
  ...Array.from({length:15},(_,i)=>({date:'o'+i,period:2 as const}))
 ];
 const state:PolicyState={cycles,
  members:Array.from({length:20},(_,i)=>({id:'m'+i,entitlement:6})),awards:[]};
 const start=performance.now();
 const report=availabilityByCycle(state,{maxChecks:500,useCache:false});
 const ms=performance.now()-start;
 assert.ok(report.checked<=500,'the total budget must be shared between all cycles');
 assert.equal(Object.keys(report.cycles).length,45);
 assert.notEqual(report.status,'invalid');
 const uncertain=Object.values(report.cycles).filter(c=>c.status==='indeterminate');
 assert.ok(uncertain.every(c=>c.additional===null),'unknown must not masquerade as exact zero');
 console.info('2027 availability budget diagnostic:',JSON.stringify({
  cycles:45,checked:report.checked,indeterminate:uncertain.length,elapsedMs:Math.round(ms)
 }));
});
