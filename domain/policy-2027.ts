/**
 * Feasibility engine for the 2027 LECS allocation policy (#57).
 * Pure domain code: no persistence and no dependency on the UI.
 *
 * A witness contains all additional person/cycle assignments. A failed
 * bounded search is INDETERMINATE, never silently treated as impossible.
 */
export const OCCUPANCY_POLICY_2027 = 'lecs-2027-occupancy-v2' as const;
export type Period2027 = 0 | 1 | 2;
export type PolicyCycle = { date: string; period: Period2027; fourthExcluded?: boolean; maximum?: number };
export type PolicyMember = { id: string; entitlement: number };
export type PolicyAward = { member_id: string; cycle_date: string };
export type PolicyState = { cycles: PolicyCycle[]; members: PolicyMember[]; awards: PolicyAward[] };
export type RuleProblem = {
  code: string;
  message: string;
  period?: Period2027;
  cycle?: string;
  actual?: number;
  limit?: number;
  /** 'proven' holds in every admissible completion; never set from one witness. */
  certainty?: 'proven' | 'indeterminate';
  evidence?: string;
};
/** Extraordinary third-place permits per period (preverano 2, posverano 1).
 * Overridden only to test, by relaxation, which permit causes a block. */
export type Permits2027 = { preThird?: number; postThird?: number };
const MONTHS_2027=['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
const PERIOD_NAMES_2027=['preverano','verano','posverano'];
/** "2027-09-30" -> "30 sep", for messages shown to people. */
export const day2027=(date:string)=>Number(date.slice(8,10))+' '+(MONTHS_2027[Number(date.slice(5,7))-1]??date.slice(5,7));
const cycleList=(dates:string[])=>dates.map(day2027).join(', ');
/**
 * Concrete reason, when there is a simple one, why the strict territorial
 * reading fails: a period's fourth place has no same-period donor left. In
 * preverano the donor must end with two people; in posverano with one or two.
 * `final` reads finished occupancies; otherwise a cycle still at two or fewer
 * may yet end as a donor.
 */
function strictRegionCause2027(state:PolicyState,choices:PolicyAward[],final:boolean):string|null {
  const before=new Map<string,number>(),after=new Map<string,number>();
  for(const a of state.awards){before.set(a.cycle_date,(before.get(a.cycle_date)??0)+1);after.set(a.cycle_date,(after.get(a.cycle_date)??0)+1);}
  for(const a of choices)after.set(a.cycle_date,(after.get(a.cycle_date)??0)+1);
  for(const period of [0,2] as const){
    const cycles=state.cycles.filter(c=>c.period===period);
    const fours=cycles.filter(c=>(after.get(c.date)??0)>=4);
    if(!fours.length)continue;
    const donor=(n:number)=>final?(period===0?n===2:n===1||n===2):n<=2;
    if(cycles.some(c=>!fours.includes(c)&&donor(after.get(c.date)??0)))continue;
    const last=choices.map(c=>c.cycle_date).filter(d=>cycles.some(c=>c.date===d)&&donor(before.get(d)??0));
    const need=period===0?'termine con dos personas':'termine con una o dos personas';
    return `Lectura estricta de RR. HH.: la cuarta plaza del ${PERIOD_NAMES_2027[period]} (${cycleList(fours.map(c=>c.date))}) debe salir de otro ciclo del ${PERIOD_NAMES_2027[period]} que ${need}, y `+
      (final?'ninguno termina así.':`con esta elección ya no queda ninguno que pueda hacerlo${last.length?' ('+cycleList(last)+' era el último)':''}.`)+
      ' Se admite con la flexibilidad provisional entre periodos; requiere revisión administrativa.';
  }
  return null;
}
export type FinalAssessment = { valid: boolean; issues: RuleProblem[]; warnings: RuleProblem[] };
export type Completion = {
  status: 'possible' | 'impossible' | 'indeterminate';
  witness?: PolicyAward[];
  checked: number;
  reason?: string;
};
export type CandidateAssessment = {
  allowed: boolean;
  completion: Completion;
  issues: RuleProblem[];
  warnings: RuleProblem[];
};

const problem = (code: string, message: string, other: Partial<RuleProblem> = {}): RuleProblem => ({ code, message, ...other });
const range = (size: number): number[] => Array.from({ length: size }, (_, i) => i);
type Scenario = { single: Set<number>; fourth: Set<number> };

/**
 * Existential, order-independent accounting of additional placements.
 *
 * The ordinary starting histogram has two or three places per off-summer
 * cycle, with conventional third places pooled across PRE and POST.
 * PRE permits two distinct extra-third destinations and a separate fourth;
 * unlike POST, its fourth MUST NOT create another one-person cycle.
 * POST's third and fourth can be chained onto the same destination.
 *
 * Reversing each optional extra placement selects a recipient (final 3/4)
 * and a source (final 1/2 outside, or a final 2/3 in summer under the
 * provisional cross-period policy). There are at most five operations, so
 * counting source types avoids factorial assignment histories.
 *
 * strictRegions compares the same allocation against the territorial
 * interpretation: each permission's source remains in its own period.
 * This is not the withdrawn "maximum two PRE singles" interpretation.
 * The summer reference of two per person is never a hard total.
 */
function has2027Accounting(state: PolicyState, counts: number[], strictRegions: boolean, permits?: Permits2027): boolean {
  const tally = [0,1,2].map(p=>({
    one:0,two:0,three:0,four:0,cycles:0
  }));
  let summerThirdDonorCapacity=0;
  for (let i=0;i<state.cycles.length;i++) {
    const cycle=state.cycles[i], value=counts[i], period=cycle.period;
    if (period!==0&&period!==1&&period!==2) return false;
    const h=tally[period]; h.cycles++;
    if (value===1)h.one++;
    else if (value===2)h.two++;
    else if (value===3) {
      h.three++;
      if(period===1&&!cycle.fourthExcluded&&(cycle.maximum??4)>=4)summerThirdDonorCapacity++;
    } else if (value===4)h.four++;
    else return false;
  }
  return accountingForTally(tally,summerThirdDonorCapacity,strictRegions,permits);
}
type PeriodTally={one:number;two:number;three:number;four:number;cycles:number};
function accountingForTally(tally:PeriodTally[],summerThirdDonorCapacity:number,strictRegions:boolean,permits?:Permits2027):boolean {
  const pre=tally[0],summer=tally[1],post=tally[2];
  if(pre.four>1||post.four>1||summer.four>2||pre.one>3||post.one>2||summer.one>0)return false;
  const summerDonorCapacity=summer.two+Math.min(summerThirdDonorCapacity,Math.max(0,2-summer.four));
  const singles=pre.one+post.one;
  const baselineCount=pre.cycles+post.cycles;
  // Distinct PRE third destinations are final threes. A PRE fourth is
  // necessarily a fourth destination, never chained with an extra third.
  const preThirdPermits=permits?.preThird??2,postThirdPermits=permits?.postThird??1;
  for(let preThird=0;preThird<=Math.min(preThirdPermits,pre.three);preThird++){
    for(let postThird=0;postThird<=Math.min(postThirdPermits,post.three);postThird++){
      for(let postChain=0;postChain<=post.four;postChain++){
        if(postThird+postChain>postThirdPermits)continue;
        const operations=preThird+pre.four+postThird+postChain+post.four;
        if(operations<singles)continue;
        const otherDonors=operations-singles;
        // The PRE EC4 donor must remain at least double in the final
        // allocation. It cannot create another one-person cycle.
        if(otherDonors<pre.four)continue;
        const baselineThirdsWithoutDoubleDonors=
          pre.three+post.three-preThird-postThird+pre.four+post.four*(1-postChain);
        if(strictRegions) {
          // PRE EC3 takes its source from a PRE one; its EC4 takes a
          // PRE two. POST's EC3 takes a POST one, while its EC4 may
          // take either a POST one or a POST two.
          if(pre.one!==preThird||pre.two<pre.four)continue;
          const postFourthFromOne=post.one-(postThird+postChain);
          if(postFourthFromOne<0||postFourthFromOne>post.four)continue;
          const postFourthFromTwo=post.four-postFourthFromOne;
          if(post.two<postFourthFromTwo)continue;
          const ordinary=baselineThirdsWithoutDoubleDonors+pre.four+postFourthFromTwo;
          if(ordinary>=0&&ordinary<=baselineCount)return true;
          continue;
        }
        const outsideDoubles=pre.two+post.two;
        const minOutside=Math.max(0,otherDonors-summerDonorCapacity);
        const maxOutside=Math.min(otherDonors,outsideDoubles);
        for(let doubles=minOutside;doubles<=maxOutside;doubles++){
          const ordinary=baselineThirdsWithoutDoubleDonors+doubles;
          if(ordinary>=0&&ordinary<=baselineCount)return true;
        }
      }
    }
  }
  return false;
}

/** Reject impossible occupancy histograms BEFORE constructing a person graph.
 * The graph still proves the actual distinct-person assignment; arithmetic
 * alone is never used to accept a campaign. */
function scenarioAccountingPossible(state:PolicyState,scenario:Scenario,opts:CompletionOptions2027):boolean {
  const occupied=new Map(state.cycles.map(c=>[c.date,0]));
  for(const a of state.awards)occupied.set(a.cycle_date,(occupied.get(a.cycle_date)??0)+1);
  const periods=[0,1,2].map(()=>({n:0,singles:0,fours:0,minThree:0,maxThree:0,eligible:0,eligibleForced:0,other:0,otherForced:0}));
  for(const [i,c] of state.cycles.entries()){
    const p=periods[c.period],count=occupied.get(c.date)??0;
    if(!p)return false;p.n++;
    const single=scenario.single.has(i),fourth=scenario.fourth.has(i);
    const minimum=Math.max(single?1:fourth?4:2,c.date===opts.minimumCycle?.date?opts.minimumCycle.occupancy:0,count);
    const maximum=single?1:fourth?4:Math.min(3,c.maximum??4,c.fourthExcluded?3:4);
    if(minimum>maximum||maximum>Math.min(c.maximum??4,c.fourthExcluded?3:4))return false;
    if(single){p.singles++;continue;}if(fourth){p.fours++;continue;}
    if(minimum>=3)p.minThree++;
    if(maximum>=3)p.maxThree++;
    if(c.period===1&&maximum>=3){
      if(!c.fourthExcluded&&(c.maximum??4)>=4){p.eligible++;if(minimum>=3)p.eligibleForced++;}
      else {p.other++;if(minimum>=3)p.otherForced++;}
    }
  }
  const bases=periods.map(p=>2*p.n-p.singles+2*p.fours);
  const total=state.members.reduce((s,m)=>s+m.entitlement,0)-bases.reduce((s,n)=>s+n,0);
  if(total<periods.reduce((s,p)=>s+p.minThree,0)||total>periods.reduce((s,p)=>s+p.maxThree,0))return false;
  for(let pre=periods[0].minThree;pre<=periods[0].maxThree;pre++){
    for(let summer=periods[1].minThree;summer<=periods[1].maxThree;summer++){
      const post=total-pre-summer;
      if(post<periods[2].minThree||post>periods[2].maxThree)continue;
      if(opts.summerTotal!==undefined&&bases[1]+summer!==opts.summerTotal)continue;
      const threes=[pre,summer,post];
      const tally=periods.map((p,i)=>({one:p.singles,two:p.n-p.singles-p.fours-threes[i],three:threes[i],four:p.fours,cycles:p.n}));
      const s=periods[1],minEligible=Math.max(s.eligibleForced,summer-s.other),maxEligible=Math.min(s.eligible,summer-s.otherForced);
      for(let q=minEligible;q<=maxEligible;q++)if(accountingForTally(tally,q,opts.strictRegions===true,opts.permits))return true;
    }
  }
  return false;
}

export function evaluate2027Final(state: PolicyState, strictRegions = false, permits?: Permits2027): FinalAssessment {
  const issues: RuleProblem[] = [], warnings: RuleProblem[] = [];
  const dates = new Map(state.cycles.map((c, i) => [c.date, i]));
  const ids = new Map(state.members.map((m, i) => [m.id, i]));
  const counts = new Array(state.cycles.length).fill(0) as number[];
  const personCounts = new Array(state.members.length).fill(0) as number[];
  const pairs = new Set<string>();
  if (dates.size !== state.cycles.length || ids.size !== state.members.length)
    issues.push(problem('DUPLICATE_INPUT', 'El calendario o la plantilla contienen identificadores repetidos.'));
  for (const member of state.members)
    if (!Number.isInteger(member.entitlement) || member.entitlement < 0 || member.entitlement > 6)
      issues.push(problem('INVALID_ENTITLEMENT', 'Derecho individual fuera de rango (0–6).'));
  for (const a of state.awards) {
    const c = dates.get(a.cycle_date), m = ids.get(a.member_id);
    if (c === undefined || m === undefined) {
      issues.push(problem('OUTSIDE_CAMPAIGN', 'Adjudicación de una persona o ciclo ajeno a la campaña.', { cycle: a.cycle_date }));
      continue;
    }
    const key = m + ':' + c;
    if (pairs.has(key)) issues.push(problem('DUPLICATE_AWARD', 'Una persona no puede repetir el mismo ciclo.', { cycle: a.cycle_date }));
    pairs.add(key); counts[c]++; personCounts[m]++;
  }
  for (let i = 0; i < state.members.length; i++)
    if (personCounts[i] !== state.members[i].entitlement)
      issues.push(problem('ENTITLEMENT_INCOMPLETE', `Una persona tiene ${personCounts[i]} ciclos adjudicados y su derecho es de ${state.members[i].entitlement}.`, { actual: personCounts[i], limit: state.members[i].entitlement }));
  const periods = [0, 1, 2] as const;
  const fourCycles: string[][] = [[], [], []], singleCycles: string[][] = [[], [], []];
  const singles = [0, 0, 0], fourth = [0, 0, 0], ordinary = [0, 0, 0], n = [0, 0, 0], sums = [0, 0, 0];
  for (let i = 0; i < state.cycles.length; i++) {
    const c = state.cycles[i], occupied = counts[i], p = c.period;
    if (!periods.includes(p)) { issues.push(problem('UNKNOWN_PERIOD', 'Periodo de RRHH no identificado.', {cycle:c.date})); continue; }
    n[p]++; sums[p] += occupied;
    const minimum = p === 1 ? 2 : 1, maximum = Math.min(c.maximum ?? 4, c.fourthExcluded ? 3 : 4);
    if (occupied < minimum) issues.push(problem('CYCLE_MINIMUM', `El ${day2027(c.date)} termina con ${occupied} persona(s); el mínimo es ${minimum}.`, {period:p,cycle:c.date,actual:occupied,limit:minimum}));
    if (occupied > maximum) issues.push(problem(c.fourthExcluded ? 'FOURTH_EXCLUDED' : 'CYCLE_MAXIMUM', c.fourthExcluded ? `RR. HH. excluye la cuarta plaza del ${day2027(c.date)}, que tiene ${occupied}.` : `El ${day2027(c.date)} tiene ${occupied} personas; el máximo es ${maximum}.`, {period:p,cycle:c.date,actual:occupied,limit:maximum}));
    if (occupied === 1) { singles[p]++; singleCycles[p].push(c.date); }
    if (occupied === 4) { fourth[p]++; fourCycles[p].push(c.date); }
    if (occupied === 3) ordinary[p]++;
  }
  for (const p of periods) {
    const maxFourth = p === 1 ? 2 : 1;
    if (fourth[p] > maxFourth)
      issues.push(problem('FOURTH_LIMIT', `El ${PERIOD_NAMES_2027[p]} tiene ${fourth[p]} ciclos con cuatro (${cycleList(fourCycles[p])}); el máximo es ${maxFourth}.`, {period:p, actual:fourth[p],limit:maxFourth}));
  }
  if (singles[1] > 0)
    issues.push(problem('SUMMER_SINGLE', `En verano todos los ciclos requieren al menos dos personas; quedan con una: ${cycleList(singleCycles[1])}.`, {period:1,actual:singles[1],limit:0}));
  if (singles[2] > 2)
    issues.push(problem('POST_SINGLE_LIMIT', `Posverano admite como máximo dos ciclos con una persona y tiene ${singles[2]} (${cycleList(singleCycles[2])}).`, {period:2,actual:singles[2],limit:2}));
  if (singles[0] > 3)
    issues.push(problem('PRE_SINGLE_LIMIT', `Preverano admite como máximo tres ciclos con una persona y tiene ${singles[0]} (${cycleList(singleCycles[0])}).`, {period:0,actual:singles[0],limit:3}));
  // A cap of three PRE singles is NOT a third EC3 permission.
  // Both applied and strict evaluations use the same ordinary pool.
  const accounting=has2027Accounting(state,counts,strictRegions,permits);
  if(!accounting)
    issues.push(problem('REDISTRIBUTION_WITNESS',
      strictRegions
        ?'Este reparto no admite justificación con origen y destino de cada permiso en el mismo periodo (lectura territorial estricta de RRHH).'
        :'No existe un reparto ordinario que justifique las ampliaciones adicionales, sus destinos y sus fuentes autorizadas.',
      {period:0}));
  if(!strictRegions&&accounting&&!has2027Accounting(state,counts,true,permits))
    warnings.push(problem('CROSS_PERIOD_FLEXIBILITY',strictRegionCause2027(state,[],true)??
      'La distribución es admisible con flexibilidad entre periodos autorizada provisionalmente por el responsable, pero no cumple la interpretación territorial estricta expuesta por RRHH. Requiere revisión administrativa.'));
  const summerTotal = sums[1], summerReference = state.members.reduce((total,m)=>total+Math.min(2,m.entitlement),0);
  if (summerTotal !== summerReference)
    warnings.push(problem('SUMMER_REFERENCE', `El verano termina con ${summerTotal} turnos frente a los ${summerReference} de referencia (dos por controlador). Es informativo.`, {period:1,actual:summerTotal,limit:summerReference}));
  return { valid: issues.length === 0, issues, warnings };
}

type Edge = { to:number; rev:number; cap:number; initial:number };
class Network {
  graph: Edge[][];
  constructor(n:number) { this.graph = range(n).map(()=>[]); }
  add(u:number,v:number,cap:number):Edge {
    const a:Edge={to:v,rev:this.graph[v].length,cap,initial:cap};
    const b:Edge={to:u,rev:this.graph[u].length,cap:0,initial:0};
    this.graph[u].push(a);this.graph[v].push(b);return a;
  }
  flow(s:number,t:number):number {
    let result=0;const n=this.graph.length;
    for (;;) {
      const level=new Array(n).fill(-1) as number[], q=[s];level[s]=0;
      for(let k=0;k<q.length;k++) for(const e of this.graph[q[k]]) if(e.cap>0&&level[e.to]===-1){level[e.to]=level[q[k]]+1;q.push(e.to);}
      if(level[t]<0)return result;
      const next=new Array(n).fill(0) as number[];
      const send=(u:number,f:number):number=>{
        if(u===t)return f;
        for(;next[u]<this.graph[u].length;next[u]++){
          const e=this.graph[u][next[u]];
          if(e.cap<=0||level[e.to]!==level[u]+1)continue;
          const got=send(e.to,Math.min(f,e.cap));
          if(got){e.cap-=got;this.graph[e.to][e.rev].cap+=got;return got;}
        }
        return 0;
      };
      let pushed:number;while((pushed=send(s,1_000_000))>0)result+=pushed;
    }
  }
}

/** Exact integer circulation for one choice of one-person and four-person cycles. */
function match(state:PolicyState,scenario:Scenario,summerTotal?:number,minimumCycle?:{date:string;occupancy:number},exactCounts?:ReadonlyMap<string,number>,strictRegular=false):PolicyAward[]|null {
  const M=state.members.length,C=state.cycles.length;
  const mapM=new Map(state.members.map((m,i)=>[m.id,i])),mapC=new Map(state.cycles.map((c,i)=>[c.date,i]));
  const occupied=new Array(C).fill(0) as number[], mine=range(M).map(()=>new Set<number>());
  for(const a of state.awards){const m=mapM.get(a.member_id), c=mapC.get(a.cycle_date);if(m===undefined||c===undefined||mine[m].has(c))return null;mine[m].add(c);occupied[c]++;}
  const personBase=1,cycleBase=personBase+M,periodBase=cycleBase+C,source=periodBase+3,sink=source+1,superSource=sink+1,superSink=sink+2;
  const graph=new Network(superSink+1),balances=new Array(superSink+1).fill(0) as number[];
  const bounded=(u:number,v:number,lower:number,upper:number):Edge|null=>{
    if(lower>upper||lower<0)return null;
    balances[u]-=lower;balances[v]+=lower;return graph.add(u,v,upper-lower);
  };
  const memberEdges:{m:number;c:number;edge:Edge}[]=[];
  let remaining=0;
  for(let m=0;m<M;m++) {
    const need=state.members[m].entitlement-mine[m].size;
    if(need<0||!bounded(source,personBase+m,need,need))return null;
    remaining+=need;
    for(let c=0;c<C;c++)if(!mine[m].has(c)) {
      const edge=bounded(personBase+m,cycleBase+c,0,1)!;
      memberEdges.push({m,c,edge});
    }
  }
  const periodUsed=[0,0,0],periodSize=[0,0,0];
  for(let c=0;c<C;c++) {
    const item=state.cycles[c], p=item.period, fixedSingle=scenario.single.has(c), fixedFourth=scenario.fourth.has(c);
    if(p<0||p>2||fixedSingle&&fixedFourth||item.fourthExcluded&&fixedFourth)return null;
    periodUsed[p]+=occupied[c];periodSize[p]++;
    const localMax=Math.min(item.maximum??4,item.fourthExcluded?3:4);
    const exact=exactCounts?.get(item.date);
    const lo=exact??Math.max(fixedSingle?1:fixedFourth?4:2,item.date===minimumCycle?.date?minimumCycle.occupancy:0),hi=exact??(fixedSingle?1:fixedFourth?4:Math.min(3,localMax));
    if(occupied[c]>hi||hi>localMax||!bounded(cycleBase+c,periodBase+p,Math.max(0,lo-occupied[c]),hi-occupied[c]))return null;
  }
  for(let p=0;p<3;p++){
    const target=p===1&&summerTotal!==undefined ? summerTotal-periodUsed[p] : undefined;
    const lower=target!==undefined ? target : 0;
    // In a regular territorial allocation every fourth needs a double in
    // the same outside period: total = 3*n - doubles + fourths <= 3*n.
    const upper=target!==undefined ? target : strictRegular&&p!==1
      ?Math.max(0,3*periodSize[p]-periodUsed[p]):remaining;
    if(!bounded(periodBase+p,sink,lower,upper))return null;
  }
  if(!bounded(sink,source,0,remaining))return null;
  let demand=0;
  for(let i=0;i<balances.length;i++){
    if(balances[i]>0){graph.add(superSource,i,balances[i]);demand+=balances[i];}
    if(balances[i]<0)graph.add(i,superSink,-balances[i]);
  }
  if(graph.flow(superSource,superSink)!==demand)return null;
  return memberEdges.filter(x=>x.edge.initial-x.edge.cap>0).map(x=>({member_id:state.members[x.m].id,cycle_date:state.cycles[x.c].date}));
}

/**
 * A polynomial-time, constructive certificate for ordinary allocations.
 *
 * Search an allocation in which each cycle finishes with two or three people,
 * except for fourth places already fixed or required by the target. The
 * exact integer circulation also enforces every person's remaining rights
 * and prevents duplicate person/cycle pairs. The resulting FULL allocation
 * is independently checked against the real 2027 policy.
 *
 * This is a SUFFICIENT condition only. A null result must fall back to the
 * complete exceptional-distribution solver; singles or different fourth
 * placements can still be feasible.
 */
export function regularFlowCertificate2027(
 state:PolicyState,
 opts:{strictRegions?:boolean;summerTotal?:number;minimumCycle?:{date:string;occupancy:number};permits?:Permits2027}={}
):PolicyAward[]|null {
 const dates=new Set(state.cycles.map(c=>c.date));
 if(opts.minimumCycle&&(!dates.has(opts.minimumCycle.date)||
   !Number.isInteger(opts.minimumCycle.occupancy)||
   opts.minimumCycle.occupancy<0||opts.minimumCycle.occupancy>4))return null;
 const occupied=new Map(state.cycles.map(c=>[c.date,0]));
 for(const award of state.awards)
  occupied.set(award.cycle_date,(occupied.get(award.cycle_date)??0)+1);
 const fourth=new Set<number>(),byPeriod=[0,0,0];
 for(let i=0;i<state.cycles.length;i++){
  const c=state.cycles[i];
  if((occupied.get(c.date)??0)===4||
    (c.date===opts.minimumCycle?.date&&opts.minimumCycle.occupancy===4)){
   if(c.period<0||c.period>2)return null;
   fourth.add(i);
   byPeriod[c.period]++;
  }
 }
 if(byPeriod.some((n,p)=>n>[1,2,1][p]))return null;
 const witness=match(state,{single:new Set(),fourth},
  opts.summerTotal,opts.minimumCycle,undefined,opts.strictRegions===true);
 if(witness===null)return null;
 return evaluate2027Final({...state,awards:[...state.awards,...witness]},opts.strictRegions,opts.permits).valid
  ?witness:null;
}

const combinations = function* (values:number[],count:number,start=0,picked:number[]=[]):Generator<number[]> {
  if(count===0){yield [...picked];return;}
  for(let i=start;i<=values.length-count;i++){
    picked.push(values[i]);yield* combinations(values,count-1,i+1,picked);picked.pop();
  }
};

/**
 * Search all period-specific exceptional placement combinations. When the
 * exploration limit is reached, do not claim impossibility.
 *
 * Strict territorial and fixed-summer checks are used to decide *warnings* on a
 * pending choice, not to reject an otherwise permitted choice.
 */
export type CompletionOptions2027={
  strictRegions?:boolean; summerTotal?:number; maxChecks?:number;
  minimumCycle?:{date:string;occupancy:number}; exact?:boolean; permits?:Permits2027;
};
const completionWitnessCache=new Map<string,PolicyAward[]>();
function witnessFamily(state:PolicyState,opts:CompletionOptions2027):string {
  return JSON.stringify([OCCUPANCY_POLICY_2027,
    [...state.cycles].sort((a,b)=>a.date.localeCompare(b.date)),
    [...state.members].sort((a,b)=>a.id.localeCompare(b.id)),
    !!opts.strictRegions,opts.summerTotal??null]);
}
/** Cached complete allocations are certificates, never cached assumptions. */
export function canComplete2027(state:PolicyState,opts:CompletionOptions2027={}):Completion {
  const family=opts.exact&&!opts.permits?witnessFamily(state,opts):null;
  const previous=family?completionWitnessCache.get(family):undefined;
  if(previous&&(!opts.minimumCycle||state.cycles.some(c=>c.date===opts.minimumCycle!.date)&&
      Number.isInteger(opts.minimumCycle.occupancy)&&opts.minimumCycle.occupancy>=0&&opts.minimumCycle.occupancy<=4)){
    const fixed=new Set(state.awards.map(a=>a.member_id+'|'+a.cycle_date));
    const keys=new Set(previous.map(a=>a.member_id+'|'+a.cycle_date));
    let future=state.awards.every(a=>keys.has(a.member_id+'|'+a.cycle_date))
      ?previous.filter(a=>!fixed.has(a.member_id+'|'+a.cycle_date)):null;
    if(!future)future=reassign2027Witness(state,{...state,awards:previous});
    if(future){
      const full={...state,awards:[...state.awards,...future]};
      const summerDates=new Set(state.cycles.filter(c=>c.period===1).map(c=>c.date));
      if(evaluate2027Final(full,opts.strictRegions).valid&&
        (opts.summerTotal===undefined||full.awards.filter(a=>summerDates.has(a.cycle_date)).length===opts.summerTotal)&&
        (!opts.minimumCycle||full.awards.filter(a=>a.cycle_date===opts.minimumCycle!.date).length>=opts.minimumCycle.occupancy)){
        completionWitnessCache.set(family!,full.awards.map(a=>({...a})));
        return {status:'possible',checked:0,witness:future.map(a=>({...a}))};
      }
    }
  }
  const result=solveCompletion2027(state,opts);
  if(family&&result.status==='possible'){
    completionWitnessCache.delete(family);
    completionWitnessCache.set(family,[...state.awards,...result.witness??[]].map(a=>({...a})));
    if(completionWitnessCache.size>32)completionWitnessCache.delete(completionWitnessCache.keys().next().value!);
  }
  return result;
}
function solveCompletion2027(state:PolicyState,opts:CompletionOptions2027):Completion {
  // Keep the search bounded: an unproved state stays indeterminate, never exhaustive.
  const maxChecks=opts.maxChecks??2000;
  const M=new Map(state.members.map(m=>[m.id,m])), C=new Map(state.cycles.map(c=>[c.date,c]));
  if(state.members.length!==M.size||state.cycles.length!==C.size)return {status:'impossible',checked:0,reason:'Identificadores duplicados'};
  if(opts.minimumCycle&&(!C.has(opts.minimumCycle.date)||!Number.isInteger(opts.minimumCycle.occupancy)||opts.minimumCycle.occupancy<0||opts.minimumCycle.occupancy>4))return {status:'impossible',checked:0,reason:'Límite solicitado para un ciclo desconocido o inválido'};
  const counts=new Map(state.cycles.map(c=>[c.date,0])),people=new Map(state.members.map(m=>[m.id,0])),pairs=new Set<string>();
  for(const a of state.awards){
    const member=M.get(a.member_id),cycle=C.get(a.cycle_date),key=a.member_id+':'+a.cycle_date;
    if(!member||!cycle||pairs.has(key))return {status:'impossible',checked:0,reason:'Adjudicación externa o repetida'};
    pairs.add(key);counts.set(a.cycle_date,counts.get(a.cycle_date)!+1);people.set(a.member_id,people.get(a.member_id)!+1);
  }
  if(state.members.some(m=>!Number.isInteger(m.entitlement)||m.entitlement<0||m.entitlement>6||people.get(m.id)!>m.entitlement))return {status:'impossible',checked:0,reason:'Derechos individuales excedidos'};
  for(const c of state.cycles)if(counts.get(c.date)!>Math.min(c.maximum??4,c.fourthExcluded?3:4))return {status:'impossible',checked:0,reason:'Ciclo con ocupación superior al máximo'};
  // Territorial redistribution preserves the ordinary 2/3 capacity inside
  // each outside period. Fixed awards can never be removed by a completion.
  if(opts.strictRegions)for(const p of [0,2]){
    const dates=new Set(state.cycles.filter(c=>c.period===p).map(c=>c.date));
    if(state.awards.filter(a=>dates.has(a.cycle_date)).length>3*dates.size)
      return {status:'impossible',checked:0,reason:'La ocupación fija supera la capacidad territorial ordinaria del periodo'};
  }
  // A fully allocated campaign needs no combinatorial scenario search.
  // This is also important for publication and review: a timeout must never
  // turn a valid finished allocation into an indeterminate one.
  if(state.members.every(m=>people.get(m.id)===m.entitlement)){
    const final=evaluate2027Final(state,opts.strictRegions,opts.permits);
    const targetCount=opts.minimumCycle?state.awards.filter(a=>a.cycle_date===opts.minimumCycle!.date).length:0;
    const summer=state.awards.filter(a=>C.get(a.cycle_date)?.period===1).length;
    return final.valid&&(!opts.minimumCycle||targetCount>=opts.minimumCycle.occupancy)&&(opts.summerTotal===undefined||summer===opts.summerTotal)
      ?{status:'possible',checked:1,witness:[]}
      :{status:'impossible',checked:1,reason:final.issues[0]?.message??'El total de verano no coincide con la referencia solicitada'};
  }
  // A nearly complete allocation can be proved (or disproved) by direct
  // enumeration of the outstanding person/cycle pairs. This avoids the
  // combinatorial exceptional-cycle search and, crucially, prevents a
  // bounded timeout from hiding a provable strict-territorial warning.
  const pending=state.members.flatMap(m=>range(m.entitlement-(people.get(m.id)??0))
    .map(()=>m.id));
  if(pending.length===1&&maxChecks>=state.cycles.length){
    const memberId=pending[0];
    let examined=0;
    for(const c of state.cycles){
      if(state.awards.some(a=>a.member_id===memberId&&a.cycle_date===c.date))continue;
      examined++;
      const nextAward={member_id:memberId,cycle_date:c.date};
      const final=evaluate2027Final({...state,awards:[...state.awards,nextAward]},opts.strictRegions,opts.permits);
      if(!final.valid)continue;
       if(opts.minimumCycle&&state.awards.filter(a=>a.cycle_date===opts.minimumCycle!.date).length+(c.date===opts.minimumCycle.date?1:0)<opts.minimumCycle.occupancy)continue;
      if(opts.summerTotal!==undefined){
        const total=state.awards.filter(a=>C.get(a.cycle_date)?.period===1).length+(c.period===1?1:0);
        if(total!==opts.summerTotal)continue;
      }
      return {status:'possible',checked:examined,witness:[nextAward]};
    }
    return {status:'impossible',checked:examined,reason:'No existe una asignación para la última plaza pendiente que cumpla la política solicitada'};
  }
  // Prefer a single polynomial-time circulation to enumerating sets of
  // optional single/fourth cycles. No generic capacity-only shortcuts:
  // the completion witness proves that every CTA can still finish.
  if(maxChecks>0){
    const certificate=regularFlowCertificate2027(state,opts);
    if(certificate!==null)return {status:'possible',checked:1,witness:certificate};
  }
  const slots=[0,1,2].map(p=>range(state.cycles.length).filter(i=>state.cycles[i].period===p));
  if(slots.some(s=>s.length===0))return {status:'impossible',checked:0,reason:'Calendario sin uno de los periodos'};
  const forcedFour=slots.map(s=>s.filter(i=>counts.get(state.cycles[i].date)===4||(state.cycles[i].date===opts.minimumCycle?.date&&opts.minimumCycle.occupancy===4)));
  const possibleFour=slots.map(s=>s.filter(i=>counts.get(state.cycles[i].date)!==4&&!state.cycles[i].fourthExcluded&&(state.cycles[i].maximum??4)>=4));
  const forcedSingle=slots.map(s=>s.filter(i=>(state.cycles[i].maximum??4)===1));
  const possibleSingle=slots.map(s=>s.filter(i=>counts.get(state.cycles[i].date)!<=1&&state.cycles[i].date!==opts.minimumCycle?.date&&!forcedSingle.some(group=>group.includes(i))));
  const maxFour=[1,2,1],maxSingle=[3,0,2];
  if(forcedFour.some((x,p)=>x.length>maxFour[p])||forcedSingle.some((x,p)=>x.length>maxSingle[p]))return {status:'impossible',checked:0,reason:'Límite de cuartas o plazas individuales excedido'};
  // Deterministic preference: no optional concentration until it is necessary.
  let checked=0,exhausted=false;
  const choose=(p:number,scenario:Scenario):PolicyAward[]|null=>{
    if(exhausted)return null;
    if(p===3){
      if(++checked>maxChecks){exhausted=true;return null;}
      // Count pruned scenarios too: the budget must bound enumeration itself.
      if(!scenarioAccountingPossible(state,scenario,opts))return null;
      const extra=match(state,scenario,opts.summerTotal,opts.minimumCycle);if(!extra)return null;
      const end:PolicyState={...state,awards:[...state.awards,...extra]};
      const final=evaluate2027Final(end,opts.strictRegions,opts.permits);
      if(!final.valid)return null;
      if(opts.summerTotal!==undefined){
        const summer=new Set(state.cycles.filter(c=>c.period===1).map(c=>c.date));
        if(end.awards.filter(a=>summer.has(a.cycle_date)).length!==opts.summerTotal)return null;
      }
      return extra;
    }
    const room=maxFour[p]-forcedFour[p].length;
    for(let f=0;f<=room;f++)for(const addedFour of combinations(possibleFour[p],f)){
      const fourth=[...forcedFour[p],...addedFour],sMax=maxSingle[p];
      const candidates=possibleSingle[p].filter(i=>!fourth.includes(i));
      for(let n=0;n<=Math.min(sMax-forcedSingle[p].length,candidates.length);n++){
        if(p===0&&n+forcedSingle[p].length>maxSingle[p])continue;
        // POST can use its EC3 and EC4 together; PRE EC4 is separate.
        for(const singles of combinations(candidates,n)){
          const next:Scenario={single:new Set([...scenario.single,...forcedSingle[p],...singles]),fourth:new Set([...scenario.fourth,...fourth])};
          const result=choose(p+1,next);if(result)return result;
          if(exhausted)return null;
        }
      }
    }
    return null;
  };
  const witness=choose(0,{single:new Set(),fourth:new Set()});
  if(witness)return {status:'possible',checked,witness};
  return exhausted?{status:'indeterminate',checked:maxChecks,reason:'Límite de exploración alcanzado; no se ha demostrado imposibilidad'}:{status:'impossible',checked,reason:'No existe una completación válida'};
}

/**
 * Deterministic, inexpensive failures that do not require running the global
 * solver. Both API previews and committed operations receive the same codes.
 */
export function immediate2027Issues(state:PolicyState,choices:PolicyAward[]):RuleProblem[] {
  const result:RuleProblem[]=[];
  const cycles=new Map(state.cycles.map(c=>[c.date,c]));
  const members=new Map(state.members.map(m=>[m.id,m]));
  const personCounts=new Map(state.members.map(m=>[m.id,0]));
  const cycleCounts=new Map(state.cycles.map(c=>[c.date,0]));
  const pairs=new Set<string>();
  for(const award of [...state.awards,...choices]) {
    const cycle=cycles.get(award.cycle_date),member=members.get(award.member_id);
    if(!cycle || !member){
      result.push(problem('OUTSIDE_CAMPAIGN','La persona o el ciclo no pertenece a esta campaña.',{cycle:award.cycle_date}));
      continue;
    }
    const pair=award.member_id+'|'+award.cycle_date;
    if(pairs.has(pair))
      result.push(problem('DUPLICATE_AWARD','Esta persona ya tiene adjudicado el mismo ciclo.',{cycle:award.cycle_date}));
    pairs.add(pair);
    personCounts.set(member.id,(personCounts.get(member.id)??0)+1);
    cycleCounts.set(cycle.date,(cycleCounts.get(cycle.date)??0)+1);
  }
  for(const member of state.members) {
    const count=personCounts.get(member.id)??0;
    if(count>member.entitlement)
      result.push(problem('ENTITLEMENT_EXCEEDED',`Esta persona ya tiene sus ${member.entitlement} ciclos anuales; no puede recibir otro.`,{actual:count,limit:member.entitlement}));
  }
  const fours=[0,0,0],priorFours:string[][]=[[],[],[]];
  const priorCounts=new Map<string,number>();
  for(const award of state.awards)priorCounts.set(award.cycle_date,(priorCounts.get(award.cycle_date)??0)+1);
  for(const cycle of state.cycles){
    const occupied=cycleCounts.get(cycle.date)??0;
    const cap=Math.min(cycle.maximum??4,cycle.fourthExcluded?3:4);
    if(occupied>cap)
      result.push(problem(cycle.fourthExcluded&&occupied>=4?'FOURTH_EXCLUDED':'CYCLE_MAXIMUM',
        cycle.fourthExcluded&&occupied>=4
          ?`El ${day2027(cycle.date)} ya tiene tres personas y RR. HH. excluye su cuarta plaza.`
          :`El ${day2027(cycle.date)} ya tiene sus ${cap} plazas autorizadas ocupadas. No se puede adjudicar una ${cap+1}.ª plaza; las ${cap} existentes son válidas.`,
        {period:cycle.period,cycle:cycle.date,actual:occupied,limit:cap}));
    if(occupied>=4)fours[cycle.period]++;
    if((priorCounts.get(cycle.date)??0)>=4)priorFours[cycle.period].push(cycle.date);
  }
  for(const period of [0,1,2] as const){
    const limit=period===1?2:1;
    if(fours[period]>limit)
      result.push(problem('FOURTH_LIMIT',
        period===1
          ?`El verano ya tiene sus dos ciclos con cuatro${priorFours[1].length?' ('+cycleList(priorFours[1])+')':''}; no admite otro.`
          :`El ${PERIOD_NAMES_2027[period]} ya tiene su ciclo con cuatro${priorFours[period].length?' ('+cycleList(priorFours[period])+')':''}; no admite otro.`,
        {period,actual:fours[period],limit}));
  }
  // Necessary (not sufficient) global bounds. They provide a concrete reason
  // before the more expensive person-to-cycle exact matching is attempted.
  const remaining=state.members.reduce((n,m)=>n+Math.max(0,m.entitlement-(personCounts.get(m.id)??0)),0);
  const minMissing=state.cycles.reduce((n,c)=>n+Math.max(0,(c.period===1?2:1)-(cycleCounts.get(c.date)??0)),0);
  const capacity=state.cycles.reduce((n,c)=>n+Math.max(0,Math.min(c.maximum??4,c.fourthExcluded?3:4)-(cycleCounts.get(c.date)??0)),0);
  const summerMissing=state.cycles.filter(c=>c.period===1)
    .reduce((n,c)=>n+Math.max(0,2-(cycleCounts.get(c.date)??0)),0);
  if(remaining<summerMissing)
    result.push(problem('SUMMER_MINIMUM_IMPOSSIBLE',
      `Quedarían ${remaining} vacaciones por adjudicar y el verano aún necesita ${summerMissing} para tener dos personas en cada ciclo.`,
      {period:1,actual:remaining,limit:summerMissing}));
  if(remaining<minMissing)
    result.push(problem('CYCLE_MINIMUM_IMPOSSIBLE',
      `Quedarían ${remaining} vacaciones por adjudicar y aún hacen falta ${minMissing} para cubrir el mínimo de todos los ciclos (dos en verano, una fuera).`,
      {actual:remaining,limit:minMissing}));
  if(remaining>capacity)
    result.push(problem('INSUFFICIENT_CAPACITY',
      `Quedarían ${remaining} vacaciones por adjudicar y solo ${capacity} plazas autorizadas libres.`,
      {actual:capacity,limit:remaining}));
  for(const member of state.members){
    const held=new Set([...state.awards,...choices].filter(a=>a.member_id===member.id).map(a=>a.cycle_date));
    const pending=member.entitlement-(personCounts.get(member.id)??0);
    if(pending<=0)continue;
    const options=state.cycles.filter(c=>!held.has(c.date)&&
      (cycleCounts.get(c.date)??0)<Math.min(c.maximum??4,c.fourthExcluded?3:4)).length;
    if(pending>options)
      result.push(problem('PERSON_CYCLES_EXHAUSTED',
        `${choices.some(c=>c.member_id===member.id)?'A esta persona':'A otro controlador'} le quedarían ${pending} ciclos por adjudicar y solo ${options} ciclos distintos con plaza libre.`,
        {actual:options,limit:pending}));
  }
  return result;
}

/**
 * A valid completed allocation is a certificate of a feasible occupancy
 * histogram. Reassign all remaining controllers with a single bounded
 * circulation while preserving exactly that histogram and all fixed awards.
 * This is stronger than a two-controller swap and avoids any exceptional
 * cycle enumeration. The final assessment is an independent safety check.
 *
 * If the requested fixed awards cannot fit this particular histogram,
 * return null: callers must use the ordinary exhaustive solver or another
 * certificate rather than interpreting null as impossibility.
 */
export function reassign2027Witness(
 state:PolicyState,verifiedFinal:PolicyState
):PolicyAward[]|null {
 if(!evaluate2027Final(verifiedFinal).valid)return null;
 if(state.cycles.length!==verifiedFinal.cycles.length||state.members.length!==verifiedFinal.members.length)return null;
 const histogram=new Map(verifiedFinal.cycles.map(c=>[
  c.date,verifiedFinal.awards.filter(a=>a.cycle_date===c.date).length
 ]));
 const assignments=match(state,{single:new Set(),fourth:new Set()},undefined,undefined,histogram);
 if(assignments===null)return null;
 return evaluate2027Final({...state,awards:[...state.awards,...assignments]}).valid?assignments:null;
}

/**
 * Reuse a previously proved final allocation for one candidate.
 *
 * A proposed person/cycle pair can be taken directly from a completion
 * witness; otherwise an alternating two-person/two-cycle swap may preserve
 * exactly the same final occupation histogram. Neither case changes existing
 * awards. Every proposed result is verified with the complete final policy
 * before it may bypass the bounded search.
 *
 * Returns only the FUTURE awards after the candidate has been applied.
 */
export function transplant2027Witness(
  state:PolicyState,choice:PolicyAward,witness:PolicyAward[]
):PolicyAward[]|null {
  const finalState={...state,awards:[...state.awards,...witness]};
  if(!evaluate2027Final(finalState).valid)return null;
  const same=(a:PolicyAward,b:PolicyAward)=>a.member_id===b.member_id&&a.cycle_date===b.cycle_date;
  // It is not valid to claim that an already allocated pair is newly chosen.
  if(state.awards.some(a=>same(a,choice)))return null;
  const direct=witness.findIndex(a=>same(a,choice));
  if(direct!==-1)return witness.filter((_,i)=>i!==direct);
  const mine=witness.flatMap((a,i)=>a.member_id===choice.member_id?[i]:[]);
  const holders=witness.flatMap((a,i)=>a.cycle_date===choice.cycle_date?[i]:[]);
  for(const i of mine)for(const j of holders){
    if(i===j)continue;
    const displaced=witness[i],replaced=witness[j];
    const remainder=witness.map((a,k)=>k===i?choice:k===j
      ?{member_id:replaced.member_id,cycle_date:displaced.cycle_date}:a);
    if(evaluate2027Final({...state,awards:[...state.awards,...remainder]}).valid)
      return remainder.filter((_,k)=>k!==i);
  }
  // Try any augmenting flow that preserves the same validated final cycle
  // counts. The preceding direct and two-person shortcuts cover cheap cases.
  const rebuilt=reassign2027Witness({...state,awards:[...state.awards,choice]},finalState);
  if(rebuilt)return rebuilt;
  return null;
}

const partialCache=new Map<string,CandidateAssessment>();
/** Assessment of the current partial allocation, shared by the commit audit
 * and the following view so one decision pays for its warnings only once. */
export function partialAssessment2027(state:PolicyState,maxChecks=500):CandidateAssessment {
  const key=JSON.stringify([OCCUPANCY_POLICY_2027,maxChecks,
    [...state.cycles].sort((a,b)=>a.date.localeCompare(b.date)),
    [...state.members].sort((a,b)=>a.id.localeCompare(b.id)),
    state.awards.map(a=>a.member_id+'|'+a.cycle_date).sort()]);
  const cached=partialCache.get(key);
  if(cached)return cached;
  const result=evaluate2027Candidate(state,[],maxChecks);
  partialCache.set(key,result);
  if(partialCache.size>16)partialCache.delete(partialCache.keys().next().value!);
  return result;
}

/** Evaluate an atomic batch of choices on the same prior state. */
export function evaluate2027Candidate(
  state:PolicyState,choices:PolicyAward[],maxChecks=2000,
  knownWitness?:PolicyAward[],includeWarnings=true,options:{exact?:boolean}={}
):CandidateAssessment {
  const next={...state,awards:[...state.awards,...choices]};
  const immediate=immediate2027Issues(state,choices);
  if(immediate.length){
    return {allowed:false,completion:{status:'impossible',checked:0,reason:'Restricción inmediata vulnerada'},
      issues:immediate,warnings:[]};
  }
  const repaired=choices.length===1&&knownWitness
    ?transplant2027Witness(state,choices[0],knownWitness):null;
  const completion:Completion=repaired
    ?{status:'possible',checked:0,witness:repaired}
    :canComplete2027(next,{maxChecks,exact:options.exact});
  const issues:RuleProblem[]=completion.status==='impossible'
    ?[problem('NO_VALID_COMPLETION','Esta combinación impediría completar las vacaciones respetando las reglas.')]:
    completion.status==='indeterminate'
      ?[problem('COMPLETION_UNDETERMINED','No se ha demostrado que exista una completación válida; no se adjudica automáticamente.')]:[];
  const warnings:RuleProblem[]=[];
  if(completion.status==='possible'&&includeWarnings){
    // A positively verified final completion is a constructive proof for
    // either informative comparison; do not pay for another exact search.
    const finalWitness={...next,awards:[...next.awards,...(completion.witness??[])]};
    const strictAlreadyPossible=evaluate2027Final(finalWitness,true).valid;
    const strict=strictAlreadyPossible?{status:'possible' as const}
      :canComplete2027(next,{strictRegions:true,maxChecks,exact:options.exact});
    if(strict.status==='impossible')
      warnings.push(problem('CROSS_PERIOD_FLEXIBILITY',strictRegionCause2027(state,choices,false)??
        'Esta elección impide terminar con el origen de cada ampliación en su propio periodo (lectura estricta de RRHH). La flexibilidad entre periodos es provisional y requiere revisión administrativa.'));
    const summerReference=state.members.reduce((total,m)=>total+Math.min(2,m.entitlement),0);
    const summerDates=new Set(state.cycles.filter(c=>c.period===1).map(c=>c.date));
    const currentSummer=finalWitness.awards.filter(a=>summerDates.has(a.cycle_date)).length;
    const reference=currentSummer===summerReference?{status:'possible' as const}
      :canComplete2027(next,{summerTotal:summerReference,maxChecks,exact:options.exact});
    if(reference.status==='impossible'){
      // Find the achievable summer total closest to the reference. The witness
      // total is already proven, so the search only spans the (small) gap.
      const step=currentSummer<summerReference?-1:1;
      let closest=currentSummer,exactClosest=true;
      for(let total=summerReference+step;total!==currentSummer;total+=step){
        const check=canComplete2027(next,{summerTotal:total,maxChecks,exact:options.exact});
        if(check.status==='possible'){closest=total;break;}
        if(check.status==='indeterminate'){exactClosest=false;break;}
      }
      const bound=exactClosest?(step<0?'como máximo':'como mínimo'):'en una terminación válida';
      warnings.push(problem('SUMMER_REFERENCE',step<0
        ?`Con esta elección el verano ya no podrá cubrir los ${summerReference} turnos de referencia (dos por controlador): ${bound} se cubrirán ${closest}. ${summerReference-closest===1?'El turno restante pasará':`Los ${summerReference-closest} restantes pasarán`} a preverano o posverano. Es informativo: no bloquea la elección.`
        :`Con esta elección el verano tendrá ${bound} ${closest} turnos, más que los ${summerReference} de referencia (dos por controlador). Es informativo: no bloquea la elección.`,
        {period:1,actual:closest,limit:summerReference}));
    }else if(reference.status==='indeterminate')
      warnings.push(problem('SUMMER_UNDETERMINED',`No se ha podido comprobar si el verano aún puede cubrir los ${summerReference} turnos de referencia (dos por controlador).`,{period:1,limit:summerReference}));
  }
  return {allowed:completion.status==='possible',completion,issues,warnings};
}
