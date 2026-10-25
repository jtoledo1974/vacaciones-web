import test from 'node:test';
import assert from 'node:assert/strict';
import type {AvailabilitySnapshot,AvailabilityImpact,AvailabilitySlot} from '../domain/availability-2027';
import {cycleAvailability,cycleOccupancyLabel,describeImpact,slotExplanation,summarizeImpact} from '../app/cycle-availability-ui.ts';

test('occupancy denominator reflects viable capacity rather than theoretical fourth place',()=>{
 for(const [occupied,additional,expected] of [[0,3,'0/3'],[2,1,'2/3'],[3,0,'3/3'],[4,0,'4/4']] as const){
  const data=snapshot('exact',additional,additional,additional);
  data.cycles[cycle.date].occupied=occupied;
  assert.equal(cycleOccupancyLabel({...cycle,occupied},data,2027),expected);
 }
 assert.equal(cycleOccupancyLabel(cycle,null,2027),'0/?');
 assert.equal(cycleOccupancyLabel(cycle,snapshot('indeterminate',null,1,3),2027),'0/1–3');
 assert.equal(cycleOccupancyLabel(cycle,snapshot('invalid',null,0,0),2027),'0/?');
 assert.equal(cycleOccupancyLabel(cycle,null,2026),'0/4');
});

const cycle={date:'2027-07-01',occupied:0,max:4};

function snapshot(status:'exact'|'indeterminate'|'invalid',additional:number|null,lower:number,upper:number):AvailabilitySnapshot{
 return {policyVersion:'lecs-2027-occupancy-v2',status,checked:0,cycles:{
  [cycle.date]:{cycle:cycle.date,period:1,occupied:0,localMaximum:4,status,
   additional,provenAdditional:lower,possibleAdditionalUpperBound:upper,slots:[]}
 }};
}

test('2027 uses exact global feasibility, not local maximum',()=>{
 const view=cycleAvailability(cycle,snapshot('exact',1,1,1),2027);
 assert.equal(view.label,'1');
 assert.equal(view.className,'vac2-free-1');
 assert.match(view.description,/globalmente viables/);
 assert.equal(cycleAvailability(cycle,null,2027).label,'?');
 assert.equal(cycleAvailability(cycle,null,2027).className,'vac2-unknown');
 assert.equal(cycleAvailability(cycle,snapshot('invalid',null,0,0),2027).label,'—');
});

test('indeterminate bounds never appear as exact zero',()=>{
 const unknown=cycleAvailability(cycle,snapshot('indeterminate',null,1,3),2027);
 assert.equal(unknown.label,'?');
 assert.match(unknown.description,/1–3/);
 assert.equal(unknown.className,'vac2-unknown');
});

test('historical campaigns preserve their original local presentation',()=>{
 const old=cycleAvailability({...cycle,max:3},null,2026);
 assert.equal(old.label,'3');
 assert.equal(old.className,'vac2-free-3');
});

test('blocked slots include the actual rule explanation',()=>{
 const excluded:AvailabilitySlot={position:4,status:'blocked',
  reasons:[{code:'FOURTH_EXCLUDED_RED',message:'RRHH excluye la cuarta plaza en este ciclo rojo.'}]};
 assert.match(slotExplanation(excluded),/cuarta plaza/);
 const uncertain:AvailabilitySlot={position:3,status:'indeterminate',
  reasons:[{code:'INDETERMINATE',message:'La búsqueda no ha concluido.'}]};
 assert.match(slotExplanation(uncertain),/indeterminada/);
});

test('impact descriptions distinguish direct losses, global losses and fourth-place limits',()=>{
 const impact={changes:[
  {cycle:'2027-07-01',kind:'directOccupancy',before:{additional:3,lower:3,upper:3},after:{additional:2,lower:2,upper:2},delta:-1,reasons:[]},
  {cycle:'2027-08-01',kind:'globalConstraint',before:{additional:2,lower:2,upper:2},after:{additional:0,lower:0,upper:0},delta:-2,reasons:[]}
 ],events:[{code:'SUMMER_FOURTH_LIMIT_REACHED',period:1,cycles:['2027-07-01']}]} as unknown as AvailabilityImpact;
 const lines=describeImpact(impact);
 assert.ok(lines.some(line=>line.includes('Adjudicación directa')&&line.includes('2027-07-01')));
 assert.ok(lines.some(line=>line.includes('Restricción global')&&line.includes('2027-08-01')));
 assert.ok(lines.some(line=>line.includes('terceras plazas siguen')));
});

test('el historial solo resume consecuencias sobre otros ciclos',()=>{
 const change=(cycle:string,kind:'directOccupancy'|'globalConstraint',before:number,after:number,codes:string[])=>({
  cycle,period:0 as const,kind,before:{occupied:2,additional:before,lower:before,upper:before},
  after:{occupied:2,additional:after,lower:after,upper:after},delta:after-before,
  reasons:codes.map(code=>({code,message:code}))});
 const base={policyVersion:'lecs-2027-occupancy-v2',status:'exact',before:null,after:null} as any;
 // Own cycle only: nothing to show.
 assert.deepEqual(summarizeImpact({...base,changes:[change('2027-01-09','directOccupancy',1,0,['DIRECT_OCCUPANCY'])],events:[]}),{highlights:[],details:[]});
 // Exhausted personal rights (with a fixed red-cycle limit) are not a consequence.
 assert.deepEqual(summarizeImpact({...base,changes:[change('2027-12-27','globalConstraint',1,0,['INDIVIDUAL_RIGHTS_EXHAUSTED','FOURTH_EXCLUDED_RED'])],
  events:[{code:'THIRD_POSITION_CLOSED',period:2,cycles:['2027-12-27']}]}),{highlights:[],details:[]});
 // Period-wide fourth limit is highlighted and its cycles are not repeated.
 const fourth=summarizeImpact({...base,changes:[change('2027-01-17','globalConstraint',2,1,['FOURTH_PERIOD_LIMIT_REACHED']),
  change('2027-03-06','globalConstraint',1,0,['GLOBAL_COMPLETION_CONSTRAINT'])],
  events:[{code:'FOURTH_PERIOD_LIMIT_REACHED',period:0,actual:1,limit:1,cycles:['2027-01-17']}]});
 assert.equal(fourth.highlights.length,1);
 assert.match(fourth.highlights[0],/cuartas plazas del preverano \(1\/1\)/);
 assert.equal(fourth.details.length,1);
 assert.match(fourth.details[0],/1 → 0/);
});
