import {calculate,type Member,type Request,type Award} from './vacations.ts';
import {relationQuotas} from './quotas.ts';
import type {Config} from './calendar.ts';

// Criterios Vacaciones 1.1 (10/06/2025), pp. 1-3.
export const ELECTION_POLICY_VERSION='criterios-vacaciones-1.1-2025';
export type ElectionState={
 status:'active'|'paused'|'complete';order:string[];cursor:number;credits:Record<string,number>;
 // Administrators can correct an undone automatic choice without retriggering it.
 automaticPaused?:boolean;
 source:string;allowDeferral:boolean;policyVersion?:string;
 // Each tied group is contiguous in the initial, drawn order, then rotated each round.
 tieGroups?:string[][];
 pendingTieGroups?:string[][];
 tieResolutions?:{order:string[];method:'random'|'external';at:string;actor:string;anticipated?:boolean}[];
 // A joint turn is taken at the position of its last participant in each round.
 jointGroups?:string[][];
 // Round-scoped administrative agreements; cancelled records remain in the audit.
 jointAgreements?:{round:number;members:string[];actor:string;at:string;cancelledBy?:string;cancelledAt?:string}[];
};
export type Preference={member_id:string;dates:string[];automatic:boolean;persistent?:boolean;active?:boolean};
// A one-turn list is consumed by a confirmed choice, not by a deferral.
export function visiblePreferenceDates(dates:string[],cycles:{date:string;occupied:number;max:number;available?:boolean}[]):string[]{
 const byDate=new Map(cycles.map(c=>[c.date,c]));
 return dates.filter(date=>{const cycle=byDate.get(date);return !!cycle&&(cycle.available??cycle.occupied<cycle.max);});
}
export function togglePreferenceDate(dates:string[],date:string,available:boolean):string[]{
 if(dates.includes(date))return dates.filter(d=>d!==date);
 return available?[...dates,date]:dates;
}
export function consumePreferences(preferences:Preference[],memberIds:string[]):Preference[]{
 const consumed=new Set(memberIds);
 return preferences.map(p=>consumed.has(p.member_id)&&!p.persistent?{...p,active:false}:p);
}
export type ElectionContext={year:number;team:string;config:Config;members:Member[];requests:Request[];awards:Award[]};
export type Choice={member_id:string;cycle_date:string};
export type JointChoice={member_id:string;dates:string[]};
const count=(ctx:ElectionContext,id:string)=>ctx.awards.filter(a=>a.member_id===id).length;
export function validateOrder(order:unknown,members:Member[]):asserts order is string[]{
 if(!Array.isArray(order)||order.length!==members.length||!order.length||new Set(order).size!==order.length||order.some(id=>!members.some(m=>m.id===id)))
  throw new Error('El orden debe incluir una vez a cada controlador del equipo');
}
export function validateElectionState(state:ElectionState,members:Member[]){
 validateOrder(state.order,members);
 if(!['active','paused','complete'].includes(state.status)||!Number.isInteger(state.cursor)||state.cursor<0||state.cursor>1000000||typeof state.source!=='string'||typeof state.allowDeferral!=='boolean'||!state.credits||(state.automaticPaused!==undefined&&typeof state.automaticPaused!=='boolean')||Object.entries(state.credits).some(([id,credit])=>!state.order.includes(id)||![0,1,2].includes(credit)))
  throw new Error('Estado de elección no válido');
 for(const [name,groups] of [['tieGroups',state.tieGroups??[]],['jointGroups',state.jointGroups??[]]] as const){
  if(!Array.isArray(groups))throw new Error('Grupos de elección no válidos');
  const used=new Set<string>();
  for(const group of groups){
   if(!Array.isArray(group)||group.length<2||group.length> (name==='jointGroups'?3:state.order.length)||new Set(group).size!==group.length||group.some(id=>!state.order.includes(id)||used.has(id)))
    throw new Error('Grupos de elección no válidos');
   group.forEach(id=>used.add(id));
   if(name==='tieGroups'){
    const indices=group.map(id=>state.order.indexOf(id));
    const first=Math.min(...indices);
    if(indices.some(index=>index<first||index>=first+group.length)||group.some((id,i)=>state.order[first+i]!==id))
     throw new Error('Los empatados deben ser consecutivos y respetar el orden sorteado');
   }
  }
 }
 if(state.jointAgreements!==undefined){
  if(!Array.isArray(state.jointAgreements))throw new Error('Acuerdos de turno conjunto inválidos');
  const perRound=new Map<number,Set<string>>();
  for(const agreement of state.jointAgreements){
   if(!Number.isInteger(agreement.round)||agreement.round<1||agreement.round>100||!Array.isArray(agreement.members)||agreement.members.length<2||agreement.members.length>3||new Set(agreement.members).size!==agreement.members.length||agreement.members.some(id=>!state.order.includes(id))||typeof agreement.actor!=='string'||typeof agreement.at!=='string'||(agreement.cancelledAt!==undefined&&typeof agreement.cancelledAt!=='string')||(agreement.cancelledBy!==undefined&&typeof agreement.cancelledBy!=='string'))throw new Error('Acuerdos de turno conjunto inválidos');
   if(agreement.cancelledAt)continue;
   const used=perRound.get(agreement.round)??new Set<string>();
   if(agreement.members.some(id=>used.has(id)||(state.jointGroups??[]).some(g=>g.includes(id))))throw new Error('Controlador presente en más de un grupo conjunto');
   agreement.members.forEach(id=>used.add(id));perRound.set(agreement.round,used);
  }
 }
 if(state.pendingTieGroups!==undefined&&(!Array.isArray(state.pendingTieGroups)||state.pendingTieGroups.some(group=>!Array.isArray(group)||!(state.tieGroups??[]).some(tie=>tie.length===group.length&&tie.every((id,i)=>id===group[i])))))throw new Error('Empates pendientes no válidos');
 if(state.tieResolutions!==undefined&&(!Array.isArray(state.tieResolutions)||state.tieResolutions.some(r=>!r||!['random','external'].includes(r.method)||typeof r.at!=='string'||typeof r.actor!=='string'||!Array.isArray(r.order)||r.order.length<2||new Set(r.order).size!==r.order.length||r.order.some(id=>!state.order.includes(id))||(r.anticipated!==undefined&&typeof r.anticipated!=='boolean'))))throw new Error('Actas de sorteo no válidas');
}
export function orderForRound(state:ElectionState,round:number):string[]{
 const result=[...state.order];
 for(const group of state.tieGroups??[]){
  const first=state.order.indexOf(group[0]),offset=round%group.length;
  result.splice(first,group.length,...group.slice(offset),...group.slice(0,offset));
 }
 return result;
}
export function currentTurn(ctx:ElectionContext,input:ElectionState){
 const state=structuredClone(input);validateElectionState(state,ctx.members);
 const n=state.order.length;
 const round=Math.floor(state.cursor/n)+1;
 if(state.status!=='active')return {state,memberId:null,needed:0,round,participants:[] as string[],requiredByMember:{} as Record<string,number>};
 if(ctx.members.every(m=>count(ctx,m.id)>=ctx.config.cyclesPerPerson)){
  state.status='complete';return {state,memberId:null,needed:0,round,participants:[] as string[],requiredByMember:{} as Record<string,number>};
 }
 // Every completed or joint-deferred slot still consumes one turn in the round.
 for(let scanned=0;scanned<n*(ctx.config.cyclesPerPerson+4);scanned++){
  const currentRound=Math.floor(state.cursor/n);
  const inRound=orderForRound(state,currentRound),id=inRound[state.cursor%n];
  const remaining=ctx.config.cyclesPerPerson-count(ctx,id);
  if(remaining===0){state.cursor++;continue;}
  const pendingTie=(state.pendingTieGroups??[]).find(group=>group.includes(id));
  if(pendingTie)return {state,memberId:null,needed:0,round:currentRound+1,participants:[] as string[],requiredByMember:{} as Record<string,number>,pendingTie};
  const joint=[...(state.jointGroups??[]),...(state.jointAgreements??[]).filter(a=>!a.cancelledAt&&a.round===currentRound+1).map(a=>a.members)].find(g=>g.includes(id));
  const participants=joint?inRound.filter(person=>joint.includes(person)&&count(ctx,person)<ctx.config.cyclesPerPerson):[id];
  if(participants[participants.length-1]!==id){state.cursor++;continue;}
  const requiredByMember=Object.fromEntries(participants.map(person=>[person,Math.min(1+(state.credits[person]??0),ctx.config.cyclesPerPerson-count(ctx,person))]));
  return {state,memberId:id,needed:Object.values(requiredByMember).reduce((a,b)=>a+b,0),round:currentRound+1,participants,requiredByMember};
 }
 throw new Error('No se ha podido avanzar la elección');
}
/** Resolve a specific pending tie ahead of its turn, without consuming any election slot. */
export function resolveTie(ctx:ElectionContext,input:ElectionState,order:string[],method:'random'|'external',actor:string,at:string,groupMemberIds?:string[]){
 const turn=currentTurn(ctx,input);
 const group=groupMemberIds===undefined?turn.pendingTie
  :Array.isArray(groupMemberIds)?(input.pendingTieGroups??[]).find(pending=>pending.length===groupMemberIds.length&&pending.every(id=>groupMemberIds.includes(id))):undefined;
 if(!group)throw new Error('No hay un empate pendiente para ese grupo');
 if(!Array.isArray(order)||order.length!==group.length||new Set(order).size!==order.length||order.some(id=>!group.includes(id)))throw new Error('El orden debe incluir una vez a cada persona empatada');
 const state=groupMemberIds===undefined?turn.state:structuredClone(input),first=state.order.indexOf(group[0]);
 state.order.splice(first,group.length,...order);
 state.tieGroups=state.tieGroups!.map(g=>g===group||g.length===group.length&&g.every((id,i)=>id===group[i])?[...order]:g);
 state.pendingTieGroups=state.pendingTieGroups!.filter(g=>!g.includes(group[0]));
 const anticipated=groupMemberIds!==undefined&&(!turn.pendingTie||!turn.pendingTie.includes(group[0]));
 state.tieResolutions=[...(state.tieResolutions??[]),{order:[...order],method,actor,at,anticipated}];
 validateElectionState(state,ctx.members);return state;
}

/** Register a temporary joint turn without consuming a choice or altering earlier rounds. */
export function registerJointAgreement(ctx:ElectionContext,input:ElectionState,members:string[],round:number,actor:string,at:string):ElectionState{
 const turn=currentTurn(ctx,input),state=turn.state,n=state.order.length,currentRound=Math.floor(state.cursor/n)+1;
 if(state.status!=='active')throw new Error('La elección no está activa');
 if(!Array.isArray(members)||members.length<2||members.length>3||new Set(members).size!==members.length||members.some(id=>!state.order.includes(id)))throw new Error('Selecciona dos o tres controladores diferentes');
 if(!Number.isInteger(round)||round<currentRound||round>ctx.config.cyclesPerPerson)throw new Error('Solo pueden acordarse turnos de la ronda actual o una futura');
 if(members.some(id=>count(ctx,id)>=ctx.config.cyclesPerPerson))throw new Error('Hay controladores que ya han terminado sus ciclos');
 if(members.some(id=>(state.pendingTieGroups??[]).some(t=>t.includes(id))))throw new Error('Resuelve el empate antes de agrupar a sus integrantes');
 const ordered=orderForRound(state,round-1),first=Math.min(...members.map(id=>ordered.indexOf(id)));
 if(round===currentRound&&first<state.cursor%n)throw new Error('El primer turno del grupo ya ha pasado en esta ronda');
 const all=[...(state.jointGroups??[]),...(state.jointAgreements??[]).filter(a=>a.round===round&&!a.cancelledAt).map(a=>a.members)];
 if(all.some(g=>g.some(id=>members.includes(id))))throw new Error('Algún controlador ya pertenece a otro turno conjunto de esta ronda');
 state.jointAgreements=[...(state.jointAgreements??[]),{round,members:ordered.filter(id=>members.includes(id)),actor,at}];
 validateElectionState(state,ctx.members);
 return state;
}
/** Cancel only before the first participant's effective slot has been passed. */
export function cancelJointAgreement(ctx:ElectionContext,input:ElectionState,members:string[],round:number,actor:string,at:string):ElectionState{
 const state=structuredClone(input);validateElectionState(state,ctx.members);const n=state.order.length;
 if(state.status!=='active')throw new Error('La elección no está activa');
 const agreement=state.jointAgreements?.find(a=>a.round===round&&!a.cancelledAt&&a.members.length===members.length&&a.members.every(id=>members.includes(id)));
 if(!agreement)throw new Error('No existe ese acuerdo activo');
 const ordered=orderForRound(state,round-1),first=Math.min(...members.map(id=>ordered.indexOf(id)));
 if(round<Math.floor(state.cursor/n)+1||(round===Math.floor(state.cursor/n)+1&&first<state.cursor%n))throw new Error('El turno conjunto ya ha empezado; utiliza reconstrucción');
 agreement.cancelledAt=at;agreement.cancelledBy=actor;
 validateElectionState(state,ctx.members);
 return state;
}

// Unbiased Fisher–Yates, with rejection sampling of cryptographically random integers.
export function drawTie(group:string[]):string[]{
 const order=[...group],word=new Uint32Array(1);
 for(let i=order.length-1;i>0;i--){const size=i+1,limit=0x100000000-0x100000000%size;let value:number;do{crypto.getRandomValues(word);value=word[0];}while(value>=limit);const j=value%size;[order[i],order[j]]=[order[j],order[i]];}
 return order;
}
/**
 * Check candidate cycles against one immutable election snapshot.
 * Calendar scores and existing occupancy are computed once; every hypothetical
 * selection still passes through the original, dynamic relationQuotas formula.
 * The fallback keeps the original behaviour for malformed/imported campaigns.
 */
export function createChoiceChecker(ctx:ElectionContext,baseline=calculate(ctx.year,ctx.team,ctx.config,ctx.members,ctx.requests,ctx.awards)){
 const cycles=baseline.cycles,periods=cycles.map(c=>c.period),datesToIndex=new Map(cycles.map((cycle,i)=>[cycle.date,i]));
 const occupancy=cycles.map(c=>c.occupied),config=ctx.config,people=ctx.members.length;
 const members=new Map(ctx.members.map(m=>[m.id,m]));
 const memberCounts=new Map(ctx.members.map(m=>[m.id,0]));
 const awardedByMember=new Map(ctx.members.map(m=>[m.id,new Set<string>()]));
 for(const a of ctx.awards){
  memberCounts.set(a.member_id,(memberCounts.get(a.member_id)??0)+1);
  awardedByMember.get(a.member_id)?.add(a.cycle_date);
 }
 const baseTotal=baseline.totals.base,neededTotal=people*config.cyclesPerPerson;
 const relation=config.relation??{minimum:1,base:2,maximum:3,graceJanuary:0,graceOctober:0};
 const conventionSummer=baseline.totals.conventionSummer,conventionWinter=baseline.totals.conventionWinter;
 const convention=[config.commonConvention?conventionWinter:Math.min(conventionWinter,config.conventionJanuary),conventionSummer,config.commonConvention?conventionWinter:Math.max(0,conventionWinter-config.conventionJanuary)];
 const baselineExtras=[0,0,0];
 for(let i=0;i<cycles.length;i++)baselineExtras[periods[i]]+=Math.max(0,occupancy[i]-config.base[periods[i]]);
 const relationParams={...relation,people,necessary:neededTotal,baseTotal};
 const relationT=(n:number)=>n>relation.maximum?relation.maximum:n>relation.base?n:relation.base;
 const slow=(memberId:string,dates:string[])=>calculate(ctx.year,ctx.team,config,ctx.members,ctx.requests,[...ctx.awards,...dates.map((date,i)=>({id:'candidate-'+i,member_id:memberId,cycle_date:date}))]).issues;
 return (memberId:string,dates:string[]):string[]=>{
  const member=members.get(memberId);
  if(!member)return ['Controlador ajeno a la campaña'];
  if(new Set(dates).size!==dates.length)return ['No se puede elegir el mismo ciclo dos veces'];
  if(dates.some(date=>awardedByMember.get(memberId)!.has(date)))return ['Este controlador ya tiene uno de esos ciclos'];
  if(baseline.issues.length||dates.some(date=>!datesToIndex.has(date)))return slow(memberId,dates);

  // When T does not change, relationQuotas gives the same maxima for all
  // cycles. For the standard configuration, 1->2 falls into this fast path.
  const candidateIndices=dates.map(date=>datesToIndex.get(date)!);
  const changedRelation=candidateIndices.some(i=>relationT(occupancy[i]+1)!==relationT(occupancy[i]));
  const extra=baselineExtras.slice();
  for(const i of candidateIndices){
   const before=occupancy[i],p=periods[i];
   extra[p]+=Math.max(0,before+1-config.base[p])-Math.max(0,before-config.base[p]);
  }
  const issues:string[]=[];
  if(memberCounts.get(memberId)!+dates.length>config.cyclesPerPerson)issues.push(`${member.code}: supera los ciclos anuales`);
  if(extra[1]>conventionSummer+config.grace[1])issues.push('Se han agotado los extracupos de verano');
  if((config.commonConvention||config.commonGrace)&&extra[0]+extra[2]>conventionWinter+config.grace[0]+config.grace[2])issues.push('Se han agotado los extracupos de no verano');
  if(!config.commonConvention&&!config.commonGrace){
   for(const p of [0,2])if(extra[p]>convention[p]+config.grace[p])issues.push('Se han agotado los extracupos del período');
  }
  if(!changedRelation){
   // Existing cycles remain valid: inspect only the changed cells.
   for(const i of candidateIndices.sort((a,b)=>a-b)){
    if(occupancy[i]+1>cycles[i].max)issues.push(`${cycles[i].date}: supera el cupo máximo de la relación`);
   }
   return issues;
  }
  // 2->3 (normally) consumes global capacity. Keep the authoritative
  // Excel-derived relationQuotas calculation for those candidates.
  const hypothetical=occupancy.slice();
  for(const i of candidateIndices)hypothetical[i]++;
  const quotas=relationQuotas(periods,hypothetical,relationParams);
  for(let i=0;i<cycles.length;i++){
   const max=config.specialQuotas?.[cycles[i].date]??quotas[i].max;
   if(hypothetical[i]>max)issues.push(`${cycles[i].date}: supera el cupo máximo de la relación`);
  }
  return issues;
 };
}
export function choiceIssues(ctx:ElectionContext,memberId:string,dates:string[]){
 return createChoiceChecker(ctx)(memberId,dates);
}
export function choose(ctx:ElectionContext,input:ElectionState,memberId:string,dates:string[]){
 const turn=currentTurn(ctx,input);
 if(turn.memberId!==memberId||turn.participants.length!==1)throw new Error('No es el turno individual de este controlador');
 if(dates.length!==turn.needed)throw new Error('En este turno corresponde elegir '+turn.needed+' ciclo(s)');
 const issues=choiceIssues(ctx,memberId,dates);if(issues.length)throw new Error(issues.join('; '));
 const state=turn.state;state.credits[memberId]=0;state.cursor++;
 const choices=dates.map(d=>({member_id:memberId,cycle_date:d}));
 const next=currentTurn({...ctx,awards:[...ctx.awards,...choices.map((c,i)=>({...c,id:'chosen-'+i}))]},state);
 return {state:next.state,choices};
}
export function chooseJoint(ctx:ElectionContext,input:ElectionState,entries:JointChoice[]){
 const turn=currentTurn(ctx,input);
 if(turn.participants.length<2)throw new Error('No corresponde un turno conjunto');
 if(entries.length!==turn.participants.length||new Set(entries.map(e=>e.member_id)).size!==entries.length||entries.some(e=>!turn.participants.includes(e.member_id)||!Array.isArray(e.dates)||e.dates.length!==turn.requiredByMember[e.member_id]))
  throw new Error('El turno conjunto debe incluir las elecciones de todos sus participantes');
 const choices:Choice[]=[];
 for(const person of turn.participants){
  const entry=entries.find(e=>e.member_id===person)!;
  const nextContext={...ctx,awards:[...ctx.awards,...choices.map((c,i)=>({...c,id:'joint-'+i}))]};
  const issues=choiceIssues(nextContext,person,entry.dates);
  if(issues.length)throw new Error(issues.join('; '));
  choices.push(...entry.dates.map(date=>({member_id:person,cycle_date:date})));
 }
 const state=turn.state;
 turn.participants.forEach(person=>{state.credits[person]=0;});
 state.cursor++;
 const next=currentTurn({...ctx,awards:[...ctx.awards,...choices.map((c,i)=>({...c,id:'joint-'+i}))]},state);
 return {state:next.state,choices};
}
export function defer(ctx:ElectionContext,input:ElectionState,memberId:string){
 const turn=currentTurn(ctx,input);
 if(turn.memberId!==memberId||turn.participants.length!==1)throw new Error('No es el turno individual de este controlador');
 if(!input.allowDeferral)throw new Error('El aplazamiento no está habilitado para esta campaña');
 const credits=input.credits[memberId]??0;
 const remaining=ctx.config.cyclesPerPerson-count(ctx,memberId);
 if(credits>=2||remaining<=credits+1)throw new Error('No se puede acumular otro aplazamiento ni aplazar los últimos ciclos');
 turn.state.credits[memberId]=credits+1;turn.state.cursor++;
 return currentTurn(ctx,turn.state).state;
}
export function preferredChoice(ctx:ElectionContext,state:ElectionState,preferences:Preference[]){
 if(state.automaticPaused)return null;
 const turn=currentTurn(ctx,state);
 if(turn.participants.length!==1||!turn.memberId)return null;
 // A saved preference list is an advance instruction to choose; legacy automatic=false is ignored.
 const pref=preferences.find(p=>p.member_id===turn.memberId&&p.active!==false);
 if(!pref)return null;
 const needed=turn.needed;
 // Reuse one snapshot for all preference candidates instead of recalculating
 // the calendar and every award on each backtracking branch.
 const check=createChoiceChecker(ctx);
 // Explicit bounded backtracking avoids accepting a pair/triple that breaks joint quota accounting.
 let budget=3000;
 const search=(at:number,selected:string[]):string[]|null=>{
  if(selected.length===needed)return selected;
  for(let i=at;i<pref.dates.length&&budget-->0;i++){
   const candidate=[...selected,pref.dates[i]];
   if(check(turn.memberId!,candidate).length)continue;
   const found=search(i+1,candidate);
   if(found)return found;
  }
  return null;
 };
 return search(0,[]);
}
export function advanceAutomatic(ctx:ElectionContext,input:ElectionState,preferences:Preference[],maxTurns=12){
 let state=currentTurn(ctx,input).state;const choices:Choice[]=[];
 let remainingPreferences=preferences;
 for(let step=0;step<maxTurns;step++){
  const context={...ctx,awards:[...ctx.awards,...choices.map((c,i)=>({...c,id:'automatic-'+i}))]},turn=currentTurn(context,state);
  state=turn.state;const dates=preferredChoice(context,state,remainingPreferences);if(!dates||!turn.memberId)break;
  const next=choose(context,state,turn.memberId,dates);choices.push(...next.choices);state=next.state;
  remainingPreferences=consumePreferences(remainingPreferences,[turn.memberId]);
 }
 const finalContext={...ctx,awards:[...ctx.awards,...choices.map((c,i)=>({...c,id:'automatic-'+i}))]};
 return {state,choices,preferences:remainingPreferences,pendingAutomatic:!!preferredChoice(finalContext,state,remainingPreferences)};
}
