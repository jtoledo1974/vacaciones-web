/**
 * Feasibility engine for the 2027 LECS allocation policy (#57).
 * Pure domain code: no persistence and no dependency on the UI.
 *
 * A witness contains all additional person/cycle assignments. A failed
 * bounded search is INDETERMINATE, never silently treated as impossible.
 */
export const OCCUPANCY_POLICY_2027 = 'lecs-2027-occupancy-v1' as const;
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
};
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

export function evaluate2027Final(state: PolicyState, strictPre = false): FinalAssessment {
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
      issues.push(problem('ENTITLEMENT_INCOMPLETE', 'Los ciclos anuales de una persona no coinciden con su derecho.', { actual: personCounts[i], limit: state.members[i].entitlement }));
  const periods = [0, 1, 2] as const;
  const singles = [0, 0, 0], fourth = [0, 0, 0], ordinary = [0, 0, 0], n = [0, 0, 0], sums = [0, 0, 0];
  for (let i = 0; i < state.cycles.length; i++) {
    const c = state.cycles[i], occupied = counts[i], p = c.period;
    if (!periods.includes(p)) { issues.push(problem('UNKNOWN_PERIOD', 'Periodo de RRHH no identificado.', {cycle:c.date})); continue; }
    n[p]++; sums[p] += occupied;
    const minimum = p === 1 ? 2 : 1, maximum = Math.min(c.maximum ?? 4, c.fourthExcluded ? 3 : 4);
    if (occupied < minimum) issues.push(problem('CYCLE_MINIMUM', 'El ciclo no alcanza el mínimo final.', {period:p,cycle:c.date,actual:occupied,limit:minimum}));
    if (occupied > maximum) issues.push(problem(c.fourthExcluded ? 'FOURTH_EXCLUDED' : 'CYCLE_MAXIMUM', c.fourthExcluded ? 'RRHH excluye este ciclo de la cuarta plaza.' : 'Un ciclo no puede superar cuatro personas.', {period:p,cycle:c.date,actual:occupied,limit:maximum}));
    if (occupied === 1) singles[p]++;
    if (occupied === 4) fourth[p]++;
    if (occupied === 3) ordinary[p]++;
  }
  for (const p of periods) {
    const maxFourth = p === 1 ? 2 : 1;
    if (fourth[p] > maxFourth)
      issues.push(problem('FOURTH_LIMIT', 'Demasiados ciclos con cuatro personas en este periodo.', {period:p, actual:fourth[p],limit:maxFourth}));
  }
  if (singles[1] > 0)
    issues.push(problem('SUMMER_SINGLE', 'En verano todos los ciclos requieren al menos dos personas.', {period:1,actual:singles[1],limit:0}));
  if (singles[2] > 2)
    issues.push(problem('POST_SINGLE_LIMIT', 'Postverano permite como máximo dos ciclos con una persona.', {period:2,actual:singles[2],limit:2}));
  if (singles[0] > (strictPre ? 2 : 3))
    issues.push(problem('PRE_SINGLE_LIMIT', 'Preverano supera el máximo de ciclos con una persona.', {period:0,actual:singles[0],limit:strictPre?2:3}));
  if (!strictPre && singles[0] === 3)
    warnings.push(problem('PRE_SINGLE_3', 'Preverano necesita tres ciclos con una persona; permitido con revisión administrativa frente al criterio de dos.', {period:0,actual:3,limit:2}));
  // A conventional third is the base allocation. A redistribution transfers
  // one person: (2,2)->(1,3), (2,3)->(1,4), (3,3)->(2,4).
  // Witness arithmetic: ordinary thirds B_p = sum(occupancy-2) in period.
  // At least max(0, singles-fourths) transfers must create a third.
  // Pre: EC4 replaces one EC3; the less restrictive third single grants
  // one additional EC3, independently of whether the fourth is used.
  // Post: EC3 and EC4 are independent.
  for (const p of [0, 2] as const) {
    const conventional = sums[p] - 2 * n[p];
    if (conventional < 0 || conventional > n[p])
      issues.push(problem('ORDINARY_THIRD_POOL', 'La cantidad de terceras plazas ordinarias no admite un reparto base de dos/tres en este periodo.', {period:p,actual:conventional,limit:n[p]}));
    const movesThird = Math.max(0, singles[p] - fourth[p]);
    const budgetThird = p === 0 ? (strictPre ? 2 : 3) - fourth[p] : 1;
    if (movesThird > budgetThird)
      issues.push(problem('EXTRA_THIRD_BUDGET', 'La concentración necesita más redistribuciones de tercera plaza que las autorizadas.', {period:p,actual:movesThird,limit:budgetThird}));
    const twos = n[p] - singles[p] - fourth[p] - ordinary[p];
    if (fourth[p] > singles[p] + twos)
      issues.push(problem('ORDINARY_WITNESS', 'No existen ciclos donantes suficientes para justificar la cuarta plaza.', {period:p}));
  }
  const summerTotal = sums[1], summerReference = state.members.reduce((s,m)=>s+m.entitlement,0) === 0 ? 0 : state.members.length * 2;
  if (summerTotal !== summerReference)
    warnings.push(problem('SUMMER_REFERENCE', 'La distribución estival difiere de la referencia informativa de dos ciclos por persona.', {period:1,actual:summerTotal,limit:summerReference}));
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
function match(state:PolicyState,scenario:Scenario,summerTotal?:number):PolicyAward[]|null {
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
    const lo=fixedSingle?1:fixedFourth?4:2,hi=fixedSingle?1:fixedFourth?4:Math.min(3,localMax);
    if(occupied[c]>hi||hi>localMax||!bounded(cycleBase+c,periodBase+p,Math.max(0,lo-occupied[c]),hi-occupied[c]))return null;
  }
  for(let p=0;p<3;p++){
    const target=p===1&&summerTotal!==undefined ? summerTotal-periodUsed[p] : undefined;
    const lower=target!==undefined ? target : p===1 ? 0 : Math.max(0,2*periodSize[p]-periodUsed[p]);
    const upper=target!==undefined ? target : p===1 ? remaining : Math.min(remaining,3*periodSize[p]-periodUsed[p]);
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
 * Strict-pre and fixed-summer checks are used to decide *warnings* on a
 * pending choice, not to reject an otherwise permitted choice.
 */
export function canComplete2027(state:PolicyState,opts:{
  strictPre?:boolean; summerTotal?:number; maxChecks?:number
}={}):Completion {
  const maxChecks=opts.maxChecks??2000;
  const M=new Map(state.members.map(m=>[m.id,m])), C=new Map(state.cycles.map(c=>[c.date,c]));
  if(state.members.length!==M.size||state.cycles.length!==C.size)return {status:'impossible',checked:0,reason:'Identificadores duplicados'};
  const counts=new Map(state.cycles.map(c=>[c.date,0])),people=new Map(state.members.map(m=>[m.id,0])),pairs=new Set<string>();
  for(const a of state.awards){
    const member=M.get(a.member_id),cycle=C.get(a.cycle_date),key=a.member_id+':'+a.cycle_date;
    if(!member||!cycle||pairs.has(key))return {status:'impossible',checked:0,reason:'Adjudicación externa o repetida'};
    pairs.add(key);counts.set(a.cycle_date,counts.get(a.cycle_date)!+1);people.set(a.member_id,people.get(a.member_id)!+1);
  }
  if(state.members.some(m=>!Number.isInteger(m.entitlement)||m.entitlement<0||m.entitlement>6||people.get(m.id)!>m.entitlement))return {status:'impossible',checked:0,reason:'Derechos individuales excedidos'};
  for(const c of state.cycles)if(counts.get(c.date)!>Math.min(c.maximum??4,c.fourthExcluded?3:4))return {status:'impossible',checked:0,reason:'Ciclo con ocupación superior al máximo'};
  const slots=[0,1,2].map(p=>range(state.cycles.length).filter(i=>state.cycles[i].period===p));
  if(slots.some(s=>s.length===0))return {status:'impossible',checked:0,reason:'Calendario sin uno de los periodos'};
  const forcedFour=slots.map(s=>s.filter(i=>counts.get(state.cycles[i].date)===4));
  const possibleFour=slots.map(s=>s.filter(i=>counts.get(state.cycles[i].date)!==4&&!state.cycles[i].fourthExcluded&&(state.cycles[i].maximum??4)>=4));
  const forcedSingle=slots.map(s=>s.filter(i=>(state.cycles[i].maximum??4)===1));
  const possibleSingle=slots.map(s=>s.filter(i=>counts.get(state.cycles[i].date)!<=1&&!forcedSingle.some(group=>group.includes(i))));
  const maxFour=[1,2,1],maxSingle=[opts.strictPre?2:3,0,2];
  if(forcedFour.some((x,p)=>x.length>maxFour[p])||forcedSingle.some((x,p)=>x.length>maxSingle[p]))return {status:'impossible',checked:0,reason:'Límite de cuartas o plazas individuales excedido'};
  // Deterministic preference: no optional concentration until it is necessary.
  let checked=0,exhausted=false;
  const choose=(p:number,scenario:Scenario):PolicyAward[]|null=>{
    if(exhausted)return null;
    if(p===3){
      if(++checked>maxChecks){exhausted=true;return null;}
      const extra=match(state,scenario,opts.summerTotal);if(!extra)return null;
      const end:PolicyState={...state,awards:[...state.awards,...extra]};
      const final=evaluate2027Final(end,opts.strictPre);
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
        if(p===2&&n+forcedSingle[p].length>1+fourth.length)continue;
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

/** Evaluate an atomic batch of choices on the same prior state. */
export function evaluate2027Candidate(state:PolicyState,choices:PolicyAward[],maxChecks=2000):CandidateAssessment {
  const next={...state,awards:[...state.awards,...choices]};
  const completion=canComplete2027(next,{maxChecks});
  const issues:RuleProblem[]=completion.status==='impossible'
    ?[problem('NO_VALID_COMPLETION','Esta combinación impediría completar las vacaciones respetando las reglas.')]:
    completion.status==='indeterminate'
      ?[problem('COMPLETION_UNDETERMINED','No se ha demostrado que exista una completación válida; no se adjudica automáticamente.')]:[];
  const warnings:RuleProblem[]=[];
  if(completion.status==='possible'){
    if(canComplete2027(next,{strictPre:true,maxChecks}).status==='impossible')
      warnings.push(problem('PRE_SINGLE_3','Esta elección hace inevitable utilizar tres ciclos con una persona en preverano; permitida con revisión administrativa.',{period:0,actual:3,limit:2}));
    const summerReference=state.members.length*2;
    if(canComplete2027(next,{summerTotal:summerReference,maxChecks}).status==='impossible')
      warnings.push(problem('SUMMER_REFERENCE','La terminación necesita un total estival distinto de la referencia informativa.',{period:1,limit:summerReference}));
  }
  return {allowed:completion.status==='possible',completion,issues,warnings};
}
