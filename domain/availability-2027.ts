import {
 canComplete2027, evaluate2027Candidate, evaluate2027Final, regularFlowCertificate2027,
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
export type AvailabilityOptions = {maxChecks?: number; useCache?: boolean; exact?:boolean};

const cache = new Map<string, AvailabilitySnapshot>();
const CACHE_LIMIT = 96;
const periodLimit = (period:0|1|2):number => period===1?2:1;
const reason = (
 code:string,message:string,period?:0|1|2,cycle?:string,actual?:number,limit?:number
):RuleProblem=>({
 code,message,
 ...(period!==undefined?{period}:{}),
 ...(cycle!==undefined?{cycle}:{}),
 ...(actual!==undefined?{actual}:{}),
 ...(limit!==undefined?{limit}:{})
});

function keyFor(state:PolicyState,maxChecks:number,exact=false):string {
 const cycles=[...state.cycles].sort((a,b)=>a.date.localeCompare(b.date));
 const members=[...state.members].sort((a,b)=>a.id.localeCompare(b.id));
 const awards=[...state.awards].map(a=>a.member_id+'|'+a.cycle_date).sort();
 return JSON.stringify([OCCUPANCY_POLICY_2027,maxChecks,exact,cycles,members,awards]);
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
 const outstanding=state.members.map(m=>({
  member:m.id,remaining:Math.max(0,m.entitlement-state.awards.filter(a=>a.member_id===m.id).length)
 }));
 const pending=outstanding.reduce((sum,m)=>sum+m.remaining,0);
 const targetNeed=position-occupied;
 if(targetNeed>pending)
  return [reason('INDIVIDUAL_RIGHTS_EXHAUSTED','Los derechos pendientes no alcanzan para ocupar esta plaza.',c.period,date,pending,targetNeed)];
 const eligible=outstanding.filter(m=>m.remaining>0&&
  !state.awards.some(a=>a.member_id===m.member&&a.cycle_date===date)).length;
 if(eligible<targetNeed)
  return [reason('DISTINCT_CONTROLLER_SHORTAGE',
   'No hay suficientes controladores con derechos pendientes que puedan elegir este ciclo sin repetirlo.',
   c.period,date,eligible,targetNeed)];
 const remainingMinimums=state.cycles.filter(x=>x.date!==date)
  .reduce((sum,x)=>sum+Math.max(0,(x.period===1?2:1)-state.awards.filter(a=>a.cycle_date===x.date).length),0);
 if(pending<targetNeed+remainingMinimums)
  return [reason('MINIMUM_COVERAGE',
   'Esta plaza impediría alcanzar los mínimos obligatorios de los demás ciclos.',
   c.period,date,pending,targetNeed+remainingMinimums)];
 return [reason('GLOBAL_COMPLETION_CONSTRAINT',
  'Ocupar esta plaza impediría completar legalmente todas las vacaciones pendientes (restricciones globales de RRHH y derechos individuales).',
  c.period,date)];
}
function snapshotCache(key:string,value:AvailabilitySnapshot):void {
 cache.delete(key);
 cache.set(key,value);
 if(cache.size>CACHE_LIMIT)cache.delete(cache.keys().next().value!);
}

/**
 * Cheap constructive certificate. Move a FUTURE award from a donor to the
 * target, keeping every person's annual total unchanged. Validate the entire
 * resulting allocation before accepting the proof. A failure is NOT proof
 * of impossibility: a more complex reallocation may still exist.
 *
 * Existing committed awards are never moved. Bound the search depth by the
 * target's missing occupants (at most three in a valid partial campaign).
 */
export function constructCycleWitness2027(
 state:PolicyState,witness:PolicyAward[],date:string,target:number
):PolicyAward[]|null {
 const fixed=state.awards;
 const initial=[...fixed,...witness];
 if(!state.cycles.some(c=>c.date===date)||!Number.isInteger(target)||target<0||target>4)return null;
 if(!evaluate2027Final({...state,awards:initial}).valid)return null;
 const current=initial.filter(a=>a.cycle_date===date).length;
 if(current>=target)return witness;
 const minByDate=new Map(state.cycles.map(c=>[c.date,c.period===1?2:1]));
 let attempts=0;
 const move=(remaining:PolicyAward[],depth:number):PolicyAward[]|null=>{
  if(++attempts>96)return null;
  const destinationCount=fixed.filter(a=>a.cycle_date===date).length+
   remaining.filter(a=>a.cycle_date===date).length;
  if(destinationCount>=target)
   return evaluate2027Final({...state,awards:[...fixed,...remaining]}).valid?remaining:null;
  if(depth===0)return null;
  const all=[...fixed,...remaining];
  for(let index=0;index<remaining.length;index++){
   const currentAward=remaining[index],source=currentAward.cycle_date;
   if(source===date||all.filter(a=>a.cycle_date===source).length<=(minByDate.get(source)??1))continue;
   if(all.some(a=>a.member_id===currentAward.member_id&&a.cycle_date===date))continue;
   const next=[...remaining];next[index]={...currentAward,cycle_date:date};
   // A transient histogram can be invalid even when a later one is valid,
   // so check the final policy only after all transfers.
   const result=move(next,depth-1);
   if(result)return result;
  }
  return null;
 };
 return move(witness,Math.min(3,target-current));
}

/**
 * Recover the previously proven EXACT or bounded status, without a new solver
 * call. We must reject a record from another policy/roster/calendar/occupancy.
 * A prior indeterminate place remains indeterminate; evidence is not invented.
 */
export function recordedAvailabilityByCycle2027(
 state:PolicyState,recorded:AvailabilitySnapshot|null|undefined
):AvailabilitySnapshot|null {
 if(!recorded||recorded.policyVersion!==OCCUPANCY_POLICY_2027
   ||!recorded.cycles||Object.keys(recorded.cycles).length!==state.cycles.length)return null;
 for(const [index,cycle] of state.cycles.entries()){
  const entry=recorded.cycles[cycle.date];
  const people=state.awards.filter(a=>a.cycle_date===cycle.date).map(a=>a.member_id);
  if(!entry||entry.period!==cycle.period||entry.occupied!==people.length||
    entry.localMaximum!==capacity(state,index)||!Array.isArray(entry.slots)||
    entry.slots.length!==4||
    entry.slots.filter(s=>s.status==='occupied').length!==people.length||
    entry.slots.filter(s=>s.memberId!==undefined).some(s=>!people.includes(s.memberId!))||
    people.some(id=>!entry.slots.some(slot=>slot.status==='occupied'&&slot.memberId===id))||
    !Number.isInteger(entry.provenAdditional)||!Number.isInteger(entry.possibleAdditionalUpperBound)||
    entry.provenAdditional>entry.possibleAdditionalUpperBound ||
    entry.possibleAdditionalUpperBound>Math.max(0,capacity(state,index)-people.length)
  )return null;
 }
 return {...recorded,checked:0};
}

/**
 * Rebuild only the presentation of a restored, previously committed snapshot.
 * No global completion search is run. A local impossibility (e.g. red fourth,
 * already consumed period-fourth quota or a full cycle) is exact; everything
 * else is explicitly provisional until the NEXT actual choice is confirmed.
 *
 * This is for undo/redo/reconstruction restore ONLY, never admission control.
 */
export function restoredAvailabilityByCycle2027(state:PolicyState):AvailabilitySnapshot {
 const occupancy=new Map(state.cycles.map(c=>[c.date,[] as string[]]));
 for(const award of state.awards)occupancy.get(award.cycle_date)?.push(award.member_id);
 const fourth=[0,0,0];
 for(const cycle of state.cycles)
  if((occupancy.get(cycle.date)?.length??0)===4)fourth[cycle.period]++;
 const cycles:Record<string,CycleAvailability>={};
 for(const [index,cycle] of state.cycles.entries()){
  const people=occupancy.get(cycle.date)??[],occupied=people.length,localMaximum=capacity(state,index);
  const fourthConsumed=fourth[cycle.period]>=periodLimit(cycle.period);
  const upper=Math.max(0,Math.min(localMaximum,fourthConsumed?3:4)-occupied);
  const slots:AvailabilitySlot[]=Array.from({length:4},(_,i)=>{
   const position=i+1,memberId=people[i];
   const status:AvailabilitySlot['status']=memberId!==undefined?'occupied':
    position>occupied+upper?'blocked':'indeterminate';
   const reasons:RuleProblem[]=status==='blocked'
    ?blockedReasons(state,cycle.date,position,occupied):
     status==='indeterminate'?[reason('NOT_RECHECKED_AFTER_RESTORE',
      'Estado recuperado del historial; esta posibilidad se verificará al confirmar una nueva adjudicación.',
      cycle.period,cycle.date)]:[];
   return {position,status,...(memberId?{memberId}:{}),reasons};
  });
  cycles[cycle.date]={
   cycle:cycle.date,period:cycle.period,occupied,localMaximum,
   status:upper===0?'exact':'indeterminate',additional:upper===0?0:null,
   provenAdditional:0,possibleAdditionalUpperBound:upper,slots
  };
 }
 return {
  policyVersion:OCCUPANCY_POLICY_2027,
  status:Object.values(cycles).some(c=>c.status==='indeterminate')?'indeterminate':'exact',
  cycles,checked:0
 };
}

/** Evaluate all cycle capacities from a common verified completion witness. */
export function availabilityByCycle(state:PolicyState,options:AvailabilityOptions={}):AvailabilitySnapshot {
 const maxChecks=options.maxChecks??500;
 const exact=options.exact===true;
 const cacheKey=keyFor(state,maxChecks,exact);
 if(options.useCache!==false&&cache.has(cacheKey))return cache.get(cacheKey)!;
 const baseline=canComplete2027(state,{maxChecks,exact});
 // One shared budget for the entire table. Do not spend maxChecks for
 // EACH candidate on EVERY page view (potentially 100+ full searches).
 let remainingChecks=Math.max(0,maxChecks-baseline.checked);
 const fixed=new Map(state.cycles.map(c=>[c.date,[] as string[]]));
 for(const award of state.awards)fixed.get(award.cycle_date)?.push(award.member_id);
 const witnessCounts=new Map(state.cycles.map(c=>[c.date,fixed.get(c.date)?.length??0]));
 for(const award of baseline.witness??[])witnessCounts.set(award.cycle_date,(witnessCounts.get(award.cycle_date)??0)+1);
 const four=[0,0,0];
 for(const c of state.cycles)if((fixed.get(c.date)?.length??0)===4)four[c.period]++;
 const assignedByMember=new Map<string,number>();
 for(const award of state.awards)
  assignedByMember.set(award.member_id,(assignedByMember.get(award.member_id)??0)+1);
 const outstandingRights=state.members.reduce((sum,member)=>
  sum+Math.max(0,member.entitlement-(assignedByMember.get(member.id)??0)),0);
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
    if(k>outstandingRights){
     upper=Math.min(upper,k-1);continue;
    }
    // A single full circulation proves many extra third and fourth places
    // without trying exponential exceptional-cycle combinations.
    // Failure is inconclusive and continues through existing fallbacks.
    const flow=regularFlowCertificate2027(state,{
     minimumCycle:{date:c.date,occupancy:position}
    });
    if(flow!==null){lower=k;break;}
    const repaired=baseline.witness&&constructCycleWitness2027(
     state,baseline.witness,c.date,position);
    if(repaired){lower=k;break;}
    // Reserve enough time for the rest of the table, even when a hard
    // target needs exponentially many exceptional-cycle scenarios.
    if(!exact&&remainingChecks<=0)break;
    const allowance=Math.min(maxChecks>500?512:32,remainingChecks);
    const check=canComplete2027(state,{maxChecks:allowance,exact,minimumCycle:{date:c.date,occupancy:position}});
    checked+=check.checked;
    remainingChecks=Math.max(0,remainingChecks-check.checked);
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
 * A first award cannot reduce any cycle's achievable FINAL occupancy when
 * everybody has identical positive entitlements and no previous awards exist.
 *
 * Proof: every completed allocation has at least one occupant in every cycle
 * (PRE/POST minimum 1, summer minimum 2). In any such allocation, rename the
 * occupant of the selected cycle to the first chooser, and permute all other
 * controller identities consistently. Equal entitlements make the new full
 * allocation valid; its occupation histogram is unchanged. The reverse
 * inclusion is immediate because an added award only restricts completions.
 *
 * Consequently the exact same final maxima AND their sound upper/lower bounds
 * apply before and after the first award. Only the selected cycle's number of
 * FUTURE available places drops by one. This also preserves indeterminate
 * intervals without pretending they are exact.
 *
 * This is deliberately NOT used for heterogeneous HR entitlements, later
 * choices, or unproved/invalid initial allocations.
 */
function firstAwardSymmetry(
 before:PolicyState,after:PolicyState,
 previous:AvailabilitySnapshot,options:AvailabilityOptions
):AvailabilitySnapshot|null {
 if(before.awards.length!==0||after.awards.length!==1||
   !before.members.length||previous.status==='invalid')return null;
 const entitlement=before.members[0].entitlement;
 if(!Number.isInteger(entitlement)||entitlement<=0||
   before.members.some(m=>m.entitlement!==entitlement))return null;
 const award=after.awards[0];
 if(!before.members.some(m=>m.id===award.member_id))return null;
 const entry=previous.cycles[award.cycle_date];
 if(!entry||entry.occupied!==0||entry.provenAdditional<1||
    entry.slots[0]?.status!=='available')return null;
 // A verified completion from the baseline proves the existence of all
 // positive lower bounds. Otherwise we cannot apply the permutation proof.
 if(before.cycles.some(c=>previous.cycles[c.date]?.occupied!==0||
   previous.cycles[c.date]?.provenAdditional<1))return null;
 const selected:CycleAvailability={
   ...entry,occupied:1,
   additional:entry.additional===null?null:entry.additional-1,
   provenAdditional:entry.provenAdditional-1,
   possibleAdditionalUpperBound:entry.possibleAdditionalUpperBound-1,
   slots:entry.slots.map((slot,i)=>i===0
     ?{position:1,status:'occupied' as const,memberId:award.member_id,reasons:[]}
     :slot.status==='blocked'
       ?{...slot,reasons:blockedReasons(after,award.cycle_date,slot.position,1)}
       :slot)
 };
 const snapshot:AvailabilitySnapshot={
  ...previous,
  cycles:{...previous.cycles,[award.cycle_date]:selected},
  checked:0
 };
 if(options.useCache!==false)
    snapshotCache(keyFor(after,options.maxChecks??500,options.exact===true),snapshot);
 return snapshot;
}

/**
 * Compare proven availability before/after ONE atomic operation. A change
 * whose exact delta is unproved is reported with delta:null, not guessed.
 */
export function availabilityImpact(
 before:PolicyState,after:PolicyState,options:AvailabilityOptions={}
):AvailabilityImpact {
 if(keyFor({...before,awards:[]},1)!==keyFor({...after,awards:[]},1))
  throw new Error('No es posible comparar campañas o políticas con distinta plantilla o calendario.');
 const left=availabilityByCycle(before,options);
 const right=firstAwardSymmetry(before,after,left,options)??availabilityByCycle(after,options);
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
 // A lost third-place opportunity is an observable result, but not proof
 // that one specific EC3 permit was consumed: ordinary third places share a pool.
 for(const period of [0,1,2] as const){
  const thirdClosed=changes.filter(change=>{
   if(change.period!==period||change.kind!=='globalConstraint')return false;
   const before=left.cycles[change.cycle],after=right.cycles[change.cycle];
   return before.status==='exact'&&after.status==='exact'&&
    before.occupied+(before.additional??0)>=3&&
    after.occupied+(after.additional??0)<3;
  }).map(change=>change.cycle);
  if(thirdClosed.length)events.push({code:'THIRD_POSITION_CLOSED',period,cycles:thirdClosed});
 }
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
 const assessment=evaluate2027Candidate(state,choices,options.maxChecks??2000,undefined,true,
  {exact:options.exact===true});
 return {policyVersion:OCCUPANCY_POLICY_2027,
  allowed:assessment.allowed,completionStatus:assessment.completion.status,
  issues:assessment.issues,warnings:assessment.warnings,
  impact:assessment.completion.status==='possible'?
   availabilityImpact(state,{...state,awards:[...state.awards,...choices]},options):null};
}
