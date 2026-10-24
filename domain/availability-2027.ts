import {
 canComplete2027, immediate2027Issues, evaluate2027Candidate,
 OCCUPANCY_POLICY_2027, type PolicyState, type PolicyAward,
 type RuleProblem, type Completion
} from './policy-2027.ts';

/**
 * Global, existential cycle availability for LECS 2027.
 *
 * A(c) counts extra occupants in one cycle while some final assignment of
 * every controller remains possible. It does NOT promise that every choice of
 * A(c) controllers, nor all cycles' displayed maxima together, are feasible.
 *
 * If a bounded search fails to finish, an interval of proven/possible places
 * replaces a misleading exact zero. Results are independent of award order.
 */
export type AvailabilitySlot = {
 position: number;
 status: 'occupied' | 'available' | 'blocked' | 'indeterminate';
 memberId?: string;
 reasons: RuleProblem[];
};
export type CycleAvailability = {
 cycle: string;
 period: 0 | 1 | 2;
 occupied: number;
 localMaximum: number;
 status: 'exact' | 'indeterminate' | 'invalid';
 additional: number | null;
 provenAdditional: number;
 possibleAdditionalUpperBound: number;
 slots: AvailabilitySlot[];
};
export type AvailabilitySnapshot = {
 policyVersion: typeof OCCUPANCY_POLICY_2027;
 status: 'exact' | 'indeterminate' | 'invalid';
 cycles: Record<string, CycleAvailability>;
 checked: number;
};
export type AvailabilityChange = {
 cycle: string;
 period: 0 | 1 | 2;
 kind: 'directOccupancy' | 'globalConstraint';
 before: {occupied: number; additional: number | null; lower: number; upper: number};
 after: {occupied: number; additional: number | null; lower: number; upper: number};
 delta: number | null;
 reasons: RuleProblem[];
};
export type ImpactEvent = {
 code: string;
 period?: 0 | 1 | 2;
 actual?: number;
 limit?: number;
 cycles: string[];
};
export type AvailabilityImpact = {
 policyVersion: typeof OCCUPANCY_POLICY_2027;
 status: 'exact' | 'indeterminate' | 'invalid';
 before: AvailabilitySnapshot;
 after: AvailabilitySnapshot;
 changes: AvailabilityChange[];
 events: ImpactEvent[];
};
export type PreviewChoiceImpact = {
 policyVersion: typeof OCCUPANCY_POLICY_2027;
 allowed: boolean;
 completionStatus: Completion['status'];
 issues: RuleProblem[];
 warnings: RuleProblem[];
 impact: AvailabilityImpact | null;
};
export type AvailabilityOptions = {maxChecks?: number; useCache?: boolean};

const cache = new Map<string, AvailabilitySnapshot>();
const CACHE_LIMIT = 96;
const periodLimit = (period:0|1|2):number => period===1?2:1;
const reason = (
 code:string,message:string,period?:0|1|2,cycle?:string,actual?:number,limit?:number
):RuleProblem=>({code,message,period,cycle,actual,limit});

function keyFor(state:PolicyState,maxChecks:number):string {
 const cycles=[...state.cycles].sort((a,b)=>a.date.localeCompare(b.date));
 const members=[...state.members].sort((a,b)=>a.id.localeCompare(b.id));
 const awards=[...state.awards].map(a=>a.member_id+'|'+a.cycle_date).sort();
 return JSON.stringify([OCCUPANCY_POLICY_2027,maxChecks,cycles,members,awards]);
}
function capacity(state:PolicyState,index:number):number {
 const c=state.cycles[index];
 return Math.max(0,Math.min(4,c.maximum??4,c.fourthExcluded?3:4));
}
function blockedReasons(
 state:PolicyState,date:string,position:number,occupied:number
):RuleProblem[]{
 const c=state.cycles.find(x=>x.date===date);
 if(!c)return [reason('OUTSIDE_CAMPAIGN','Ciclo ajeno a la campaña.',undefined,date)];
 const local=Math.min(4,c.maximum??4,c.fourthExcluded?3:4);
 if(position>local)
  return [reason(c.fourthExcluded&&position===4?'FOURTH_EXCLUDED_RED':'CYCLE_MAXIMUM',
   c.fourthExcluded&&position===4
    ?'RRHH excluye la cuarta plaza en este ciclo rojo.'
    :'Este ciclo supera la capacidad individual permitida.',c.period,date,local,position)];
 if(position===4){
  const four=state.cycles.filter(x=>x.period===c.period&&state.awards.filter(a=>a.cycle_date===x.date).length===4).length;
  if(four>=periodLimit(c.period)&&occupied<4)
   return [reason('FOURTH_PERIOD_LIMIT',
    c.period===1?'Alcanzado el límite de dos ciclos con cuarta plaza en verano.':
     'Alcanzado el límite de un ciclo con cuarta plaza en este periodo.',
    c.period,date,four,periodLimit(c.period))];
 }
 const pending=state.members.reduce((sum,m)=>sum+Math.max(0,m.entitlement-state.awards.filter(a=>a.member_id===m.id).length),0);
 if(position-occupied>pending)
  return [reason('INDIVIDUAL_RIGHTS_EXHAUSTED','Los derechos pendientes no alcanzan para ocupar esta plaza.',c.period,date,pending,position-occupied)];
 return [reason('GLOBAL_COMPLETION_CONSTRAINT',
  'Ocupar esta plaza impediría completar legalmente todas las vacaciones pendientes (restricciones globales de RRHH y derechos individuales).',
  c.period,date)];
}
function snapshotCache(key:string,value:AvailabilitySnapshot):void {
 cache.delete(key);
 cache.set(key,value);
 if(cache.size>CACHE_LIMIT)cache.delete(cache.keys().next().value!);
}

/** Evaluate all cycle capacities from a common verified completion witness. */
export function availabilityByCycle(state:PolicyState,options:AvailabilityOptions={}):AvailabilitySnapshot {
 const maxChecks=options.maxChecks??500;
 const cacheKey=keyFor(state,maxChecks);
 if(options.useCache!==false&&cache.has(cacheKey))return cache.get(cacheKey)!;
 const baseline=canComplete2027(state,{maxChecks});
 const fixed=new Map(state.cycles.map(c=>[c.date,[] as string[]]));
 for(const award of state.awards)fixed.get(award.cycle_date)?.push(award.member_id);
 const witnessCounts=new Map(state.cycles.map(c=>[c.date,fixed.get(c.date)?.length??0]));
 for(const award of baseline.witness??[])witnessCounts.set(award.cycle_date,(witnessCounts.get(award.cycle_date)??0)+1);
 const four=[0,0,0];
 for(const c of state.cycles)if((fixed.get(c.date)?.length??0)===4)four[c.period]++;
 let checked=baseline.checked;
 const cycles:Record<string,CycleAvailability>={};
 for(let index=0;index<state.cycles.length;index++){
  const c=state.cycles[index],people=fixed.get(c.date)??[],occupied=people.length;
  const localMaximum=capacity(state,index),maxAdditional=Math.max(0,localMaximum-occupied);
  let lower=baseline.status==='possible'
   ?Math.max(0,(witnessCounts.get(c.date)??occupied)-occupied):0;
  let upper=maxAdditional;
  if(baseline.status==='impossible')upper=0;
  if(baseline.status==='possible'){
   for(let k=maxAdditional;k>lower;k--){
    const position=occupied+k;
    if(position===4&&four[c.period]>=periodLimit(c.period)&&occupied<4){
     upper=Math.min(upper,k-1);continue;
    }
    if(k>state.members.reduce((sum,m)=>sum+Math.max(0,m.entitlement-state.awards.filter(a=>a.member_id===m.id).length),0)){
     upper=Math.min(upper,k-1);continue;
    }
    const check=canComplete2027(state,{maxChecks,minimumCycle:{date:c.date,occupancy:position}});
    checked+=check.checked;
    if(check.status==='impossible')upper=Math.min(upper,k-1);
    else if(check.status==='possible'){lower=k;break;}
   }
  }
  const status:CycleAvailability['status']=baseline.status==='impossible'?'invalid':
   baseline.status==='indeterminate'||lower!==upper?'indeterminate':'exact';
  const slots:AvailabilitySlot[]=[];
  for(let position=1;position<=4;position++){
   const memberId=people[position-1];
   const slotStatus:AvailabilitySlot['status']=memberId!==undefined?'occupied':
    status==='invalid'?'indeterminate':
    position<=occupied+lower?'available':
    position>occupied+upper?'blocked':'indeterminate';
   slots.push({position,status:slotStatus,
    ...(memberId!==undefined?{memberId}:{}),
    reasons:slotStatus==='blocked'?blockedReasons(state,c.date,position,occupied):
      slotStatus==='indeterminate'?[reason('INDETERMINATE',
       'La búsqueda no ha demostrado todavía si esta plaza puede adjudicarse.',c.period,c.date)]:[]
   });
  }
  cycles[c.date]={cycle:c.date,period:c.period,occupied,localMaximum,status,
   additional:status==='exact'?lower:null,
   provenAdditional:lower,possibleAdditionalUpperBound:upper,slots};
 }
 const status:AvailabilitySnapshot['status']=baseline.status==='impossible'?'invalid':
  Object.values(cycles).some(c=>c.status==='indeterminate')?'indeterminate':'exact';
 const result={policyVersion:OCCUPANCY_POLICY_2027,status,cycles,checked};
 if(options.useCache!==false)snapshotCache(cacheKey,result);
 return result;
}

const occupancyCount=(state:PolicyState,date:string):number=>
 state.awards.filter(a=>a.cycle_date===date).length;

/**
 * Compare proven availability before/after ONE atomic operation. A change
 * whose exact delta is unproved is reported with delta:null, not guessed.
 */
export function availabilityImpact(
 before:PolicyState,after:PolicyState,options:AvailabilityOptions={}
):AvailabilityImpact {
 if(keyFor({...before,awards:[]},1)!==keyFor({...after,awards:[]},1))
  throw new Error('No es posible comparar campañas o políticas con distinta plantilla o calendario.');
 const left=availabilityByCycle(before,options),right=availabilityByCycle(after,options);
 const changes:AvailabilityChange[]=[];
 const oldFour=[0,0,0],newFour=[0,0,0];
 for(const c of before.cycles){
  if(occupancyCount(before,c.date)===4)oldFour[c.period]++;
  if(occupancyCount(after,c.date)===4)newFour[c.period]++;
 }
 for(const date of Object.keys(left.cycles)){
  const a=left.cycles[date],b=right.cycles[date];
  if(!b)throw new Error('Ciclo ausente en el estado posterior.');
  const same=a.occupied===b.occupied&&a.additional===b.additional&&
   a.provenAdditional===b.provenAdditional&&
   a.possibleAdditionalUpperBound===b.possibleAdditionalUpperBound&&a.status===b.status;
  if(same)continue;
  const direct=a.occupied!==b.occupied;
  const impacted=b.slots.filter(s=>s.status==='blocked')
   .flatMap(s=>s.reasons);
  const period=a.period;
  let reasons:RuleProblem[];
  if(!direct&&oldFour[period]<periodLimit(period)&&newFour[period]>=periodLimit(period)&&
   (a.occupied+a.possibleAdditionalUpperBound)>=4&&b.occupied<4)
    reasons=[reason('FOURTH_PERIOD_LIMIT_REACHED',
     'La operación agota el límite de cuartas plazas de este periodo.',
     period,date,newFour[period],periodLimit(period))];
  else reasons=impacted.length?impacted:
   [reason(direct?'DIRECT_OCCUPANCY':'GLOBAL_AVAILABILITY_CHANGED',
    direct?'La adjudicación ocupa directamente una plaza de este ciclo.':
      'La operación modifica las completaciones admisibles para este ciclo.',
    period,date)];
  changes.push({cycle:date,period,kind:direct?'directOccupancy':'globalConstraint',
   before:{occupied:a.occupied,additional:a.additional,lower:a.provenAdditional,upper:a.possibleAdditionalUpperBound},
   after:{occupied:b.occupied,additional:b.additional,lower:b.provenAdditional,upper:b.possibleAdditionalUpperBound},
   delta:a.additional===null||b.additional===null?null:b.additional-a.additional,
   reasons});
 }
 const events:ImpactEvent[]=[];
 for(const period of [0,1,2] as const){
  if(oldFour[period]<periodLimit(period)&&newFour[period]>=periodLimit(period)){
   const related=changes.filter(x=>x.period===period&&x.kind==='globalConstraint'&&
    x.reasons.some(r=>r.code==='FOURTH_PERIOD_LIMIT_REACHED')).map(x=>x.cycle);
   events.push({code:'FOURTH_PERIOD_LIMIT_REACHED',period,
    actual:newFour[period],limit:periodLimit(period),cycles:related});
  }
 }
 return {policyVersion:OCCUPANCY_POLICY_2027,
  status:left.status==='invalid'||right.status==='invalid'?'invalid':
   left.status==='exact'&&right.status==='exact'?'exact':'indeterminate',
  before:left,after:right,changes,events};
}

/** Preflight and post-commit history share this exact implementation. */
export function previewChoiceImpact(
 state:PolicyState,choices:PolicyAward[],options:AvailabilityOptions={}
):PreviewChoiceImpact {
 const assessment=evaluate2027Candidate(state,choices,options.maxChecks??2000);
 return {policyVersion:OCCUPANCY_POLICY_2027,
  allowed:assessment.allowed,completionStatus:assessment.completion.status,
  issues:assessment.issues,warnings:assessment.warnings,
  impact:assessment.completion.status==='possible'?
   availabilityImpact(state,{...state,awards:[...state.awards,...choices]},options):null};
}
