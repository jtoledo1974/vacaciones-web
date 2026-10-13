import {calculate,type Member,type Request,type Award} from './vacations.ts';
import type {Config} from './calendar.ts';

export const ELECTION_POLICY_VERSION='one-cycle-defer-v1-provisional';
export type ElectionState={status:'active'|'paused'|'complete';order:string[];cursor:number;credits:Record<string,number>;source:string;allowDeferral:boolean;policyVersion?:string};
export type Preference={member_id:string;dates:string[];automatic:boolean};
export type ElectionContext={year:number;team:string;config:Config;members:Member[];requests:Request[];awards:Award[]};
export type Choice={member_id:string;cycle_date:string};
const count=(ctx:ElectionContext,memberId:string)=>ctx.awards.filter(a=>a.member_id===memberId).length;
export function validateOrder(order:unknown,members:Member[]):asserts order is string[]{
 if(!Array.isArray(order)||order.length!==members.length||!order.length||new Set(order).size!==order.length||order.some(id=>!members.some(m=>m.id===id)))throw new Error('El orden debe incluir una vez a cada controlador del equipo');
}
export function validateElectionState(state:ElectionState,members:Member[]){
 validateOrder(state.order,members);
 if(!['active','paused','complete'].includes(state.status)||!Number.isInteger(state.cursor)||state.cursor<0||state.cursor>1000000||typeof state.source!=='string'||typeof state.allowDeferral!=='boolean'||!state.credits||Object.entries(state.credits).some(([id,credit])=>!state.order.includes(id)||![0,1].includes(credit)))throw new Error('Estado de elección no válido');
}
export function currentTurn(ctx:ElectionContext,input:ElectionState){
 const state=structuredClone(input);validateOrder(state.order,ctx.members);
 if(state.status!=='active')return {state,memberId:null,needed:0,round:Math.floor(state.cursor/state.order.length)+1};
 if(ctx.members.every(m=>count(ctx,m.id)>=ctx.config.cyclesPerPerson)){state.status='complete';return {state,memberId:null,needed:0,round:Math.floor(state.cursor/state.order.length)+1};}
 while(count(ctx,state.order[state.cursor%state.order.length])>=ctx.config.cyclesPerPerson)state.cursor++;
 const memberId=state.order[state.cursor%state.order.length],remaining=ctx.config.cyclesPerPerson-count(ctx,memberId);
 return {state,memberId,needed:Math.min(1+(state.credits[memberId]??0),remaining),round:Math.floor(state.cursor/state.order.length)+1};
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
 if(turn.memberId!==memberId||!turn.memberId)throw new Error('No es el turno de este controlador');
 if(dates.length!==turn.needed)throw new Error(`En este turno corresponde elegir ${turn.needed} ciclo(s)`);
 const issues=choiceIssues(ctx,memberId,dates);if(issues.length)throw new Error(issues.join('; '));
 const state=turn.state;state.credits[memberId]=0;state.cursor++;
 const choices=dates.map(d=>({member_id:memberId,cycle_date:d}));
 const next=currentTurn({...ctx,awards:[...ctx.awards,...choices.map((c,i)=>({...c,id:'chosen-'+i}))]},state);
 return {state:next.state,choices};
}
export function defer(ctx:ElectionContext,input:ElectionState,memberId:string){
 const turn=currentTurn(ctx,input);
 if(turn.memberId!==memberId||!turn.memberId)throw new Error('No es el turno de este controlador');
 if(!input.allowDeferral)throw new Error('El aplazamiento no está habilitado para esta campaña');
 if(input.credits[memberId]||ctx.config.cyclesPerPerson-count(ctx,memberId)<2)throw new Error('No se puede acumular otro aplazamiento ni aplazar el último ciclo');
 turn.state.credits[memberId]=1;turn.state.cursor++;
 return currentTurn(ctx,turn.state).state;
}
export function preferredChoice(ctx:ElectionContext,state:ElectionState,preferences:Preference[]){
 const turn=currentTurn(ctx,state),pref=preferences.find(p=>p.member_id===turn.memberId&&p.automatic);
 if(!pref||!turn.memberId)return null;
 for(let i=0;i<pref.dates.length;i++){
  if(choiceIssues(ctx,turn.memberId,[pref.dates[i]]).length)continue;
  if(turn.needed===1)return [pref.dates[i]];
  for(let j=i+1;j<pref.dates.length;j++)if(!choiceIssues(ctx,turn.memberId,[pref.dates[i],pref.dates[j]]).length)return [pref.dates[i],pref.dates[j]];
 }
 return null;
}
// Bounded batches keep a Worker request short. The client resumes until the next manual turn.
export function advanceAutomatic(ctx:ElectionContext,input:ElectionState,preferences:Preference[],maxTurns=12){
 let state=currentTurn(ctx,input).state;const choices:Choice[]=[];
 for(let step=0;step<maxTurns;step++){
  const context={...ctx,awards:[...ctx.awards,...choices.map((c,i)=>({...c,id:'automatic-'+i}))]},turn=currentTurn(context,state);
  state=turn.state;const dates=preferredChoice(context,state,preferences);if(!dates||!turn.memberId)break;
  const next=choose(context,state,turn.memberId,dates);choices.push(...next.choices);state=next.state;
 }
 const finalContext={...ctx,awards:[...ctx.awards,...choices.map((c,i)=>({...c,id:'automatic-'+i}))]};
 return {state,choices,pendingAutomatic:!!preferredChoice(finalContext,state,preferences)};
}
