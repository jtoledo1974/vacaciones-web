import {calculate,type Member,type Request,type Award} from './vacations.ts';
import type {Config} from './calendar.ts';

// Criterios Vacaciones 1.1 (10/06/2025), pp. 1-3.
export const ELECTION_POLICY_VERSION='criterios-vacaciones-1.1-2025';
export type ElectionState={
 status:'active'|'paused'|'complete';order:string[];cursor:number;credits:Record<string,number>;
 source:string;allowDeferral:boolean;policyVersion?:string;
 // Each tied group is contiguous in the initial, drawn order, then rotated each round.
 tieGroups?:string[][];
 pendingTieGroups?:string[][];
 tieResolutions?:{order:string[];method:'random'|'external';at:string;actor:string}[];
 // A joint turn is taken at the position of its last participant in each round.
 jointGroups?:string[][];
};
export type Preference={member_id:string;dates:string[];automatic:boolean;persistent?:boolean;active?:boolean};
// A one-turn list is consumed by a confirmed choice, not by a deferral.
export function visiblePreferenceDates(dates:string[],cycles:{date:string;occupied:number;max:number}[]):string[]{
 const byDate=new Map(cycles.map(c=>[c.date,c]));
 return dates.filter(date=>{const cycle=byDate.get(date);return !!cycle&&cycle.occupied<cycle.max;});
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
 if(!['active','paused','complete'].includes(state.status)||!Number.isInteger(state.cursor)||state.cursor<0||state.cursor>1000000||typeof state.source!=='string'||typeof state.allowDeferral!=='boolean'||!state.credits||Object.entries(state.credits).some(([id,credit])=>!state.order.includes(id)||![0,1,2].includes(credit)))
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
 if(state.pendingTieGroups!==undefined&&(!Array.isArray(state.pendingTieGroups)||state.pendingTieGroups.some(group=>!Array.isArray(group)||!(state.tieGroups??[]).some(tie=>tie.length===group.length&&tie.every((id,i)=>id===group[i])))))throw new Error('Empates pendientes no válidos');
 if(state.tieResolutions!==undefined&&(!Array.isArray(state.tieResolutions)||state.tieResolutions.some(r=>!r||!['random','external'].includes(r.method)||typeof r.at!=='string'||typeof r.actor!=='string'||!Array.isArray(r.order)||r.order.length<2||new Set(r.order).size!==r.order.length||r.order.some(id=>!state.order.includes(id)))))throw new Error('Actas de sorteo no válidas');
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
  const joint=(state.jointGroups??[]).find(g=>g.includes(id));
  const participants=joint?inRound.filter(person=>joint.includes(person)&&count(ctx,person)<ctx.config.cyclesPerPerson):[id];
  if(participants[participants.length-1]!==id){state.cursor++;continue;}
  const requiredByMember=Object.fromEntries(participants.map(person=>[person,Math.min(1+(state.credits[person]??0),ctx.config.cyclesPerPerson-count(ctx,person))]));
  return {state,memberId:id,needed:Object.values(requiredByMember).reduce((a,b)=>a+b,0),round:currentRound+1,participants,requiredByMember};
 }
 throw new Error('No se ha podido avanzar la elección');
}
export function resolveTie(ctx:ElectionContext,input:ElectionState,order:string[],method:'random'|'external',actor:string,at:string){
 const turn=currentTurn(ctx,input),group=turn.pendingTie;
 if(!group)throw new Error('No hay un empate pendiente en este turno');
 if(!Array.isArray(order)||order.length!==group.length||new Set(order).size!==order.length||order.some(id=>!group.includes(id)))throw new Error('El orden debe incluir una vez a cada persona empatada');
 const state=turn.state,first=state.order.indexOf(group[0]);
 state.order.splice(first,group.length,...order);
 state.tieGroups=state.tieGroups!.map(g=>g===group||g.length===group.length&&g.every((id,i)=>id===group[i])?[...order]:g);
 state.pendingTieGroups=state.pendingTieGroups!.filter(g=>!g.includes(group[0]));
 state.tieResolutions=[...(state.tieResolutions??[]),{order:[...order],method,actor,at}];
 validateElectionState(state,ctx.members);return state;
}

// Unbiased Fisher–Yates, with rejection sampling of cryptographically random integers.
export function drawTie(group:string[]):string[]{
 const order=[...group],word=new Uint32Array(1);
 for(let i=order.length-1;i>0;i--){const size=i+1,limit=0x100000000-0x100000000%size;let value:number;do{crypto.getRandomValues(word);value=word[0];}while(value>=limit);const j=value%size;[order[i],order[j]]=[order[j],order[i]];}
 return order;
}
export function choiceIssues(ctx:ElectionContext,memberId:string,dates:string[]){
 if(!ctx.members.some(m=>m.id===memberId))return ['Controlador ajeno a la campaña'];
 if(new Set(dates).size!==dates.length)return ['No se puede elegir el mismo ciclo dos veces'];
 if(dates.some(d=>ctx.awards.some(a=>a.member_id===memberId&&a.cycle_date===d)))return ['Este controlador ya tiene uno de esos ciclos'];
 const awards=[...ctx.awards,...dates.map((d,i)=>({id:'candidate-'+i,member_id:memberId,cycle_date:d}))];
 return calculate(ctx.year,ctx.team,ctx.config,ctx.members,ctx.requests,awards).issues;
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
 const turn=currentTurn(ctx,state);
 if(turn.participants.length!==1||!turn.memberId)return null;
 // A saved preference list is an advance instruction to choose; legacy automatic=false is ignored.
 const pref=preferences.find(p=>p.member_id===turn.memberId&&p.active!==false);
 if(!pref)return null;
 const needed=turn.needed;
 // Explicit bounded backtracking avoids accepting a pair/triple that breaks joint quota accounting.
 let budget=3000;
 const search=(at:number,selected:string[]):string[]|null=>{
  if(selected.length===needed)return selected;
  for(let i=at;i<pref.dates.length&&budget-->0;i++){
   const candidate=[...selected,pref.dates[i]];
   if(choiceIssues(ctx,turn.memberId!,candidate).length)continue;
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
