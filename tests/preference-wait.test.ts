import {test} from 'node:test';
import assert from 'node:assert/strict';
import {advanceAutomatic,automaticChain,automaticAt,preferredChoice,roundQueue,stampTurn,validateElectionState,type ElectionState,type ElectionContext,type Preference} from '../domain/election.ts';
import {defaultConfig} from '../domain/defaults.ts';
import {calendar} from '../domain/calendar.ts';

function fixture(){
 const config={...defaultConfig(2026),cyclesPerPerson:2,summerPerPerson:0};
 const ctx:ElectionContext={year:2026,team:'C',config,members:['A','B','C'].map(id=>({id,code:id,seniority:''})),requests:[],awards:[]};
 const state:ElectionState={status:'active',order:['B','A','C'],cursor:0,credits:{},source:'Orden histórico confirmado',allowDeferral:true};
 return {ctx,state,dates:calendar(2026,'C',config).map(c=>c.date)};
}
const T0=Date.parse('2026-11-02T09:00:00Z');
const list=(member_id:string,dates:string[],extra:Partial<Preference>={}):Preference=>({member_id,dates,automatic:true,active:true,...extra});

test('una lista «esperar» no se aplica hasta que vence el plazo desde el inicio del turno',()=>{
 const {ctx,state,dates}=fixture();
 const started=stampTurn(state,0,new Date(T0).toISOString())!;
 const prefs=[list('B',[dates[0]],{mode:'wait',waitMinutes:30})];
 assert.equal(preferredChoice(ctx,started,prefs,T0+29*60_000),null);
 assert.deepEqual(preferredChoice(ctx,started,prefs,T0+30*60_000),[dates[0]]);
 assert.equal(advanceAutomatic(ctx,started,prefs,12,T0+10*60_000).choices.length,0);
 assert.equal(advanceAutomatic(ctx,started,prefs,12,T0+31*60_000).choices.length,1);
});

test('sin hora de inicio conocida, una lista «esperar» no actúa: no se adelanta nunca',()=>{
 const {ctx,state,dates}=fixture();
 const prefs=[list('B',[dates[0]],{mode:'wait',waitMinutes:1})];
 assert.equal(preferredChoice(ctx,state,prefs,T0+1e9),null);
 // A stale clock of another turn does not count either.
 assert.equal(preferredChoice(ctx,{...state,turnSince:{cursor:5,at:new Date(T0).toISOString()}},prefs,T0+1e9),null);
});

test('una lista «elijo yo» es solo una nota y la de aplicación inmediata se comporta como antes',()=>{
 const {ctx,state,dates}=fixture();
 assert.equal(preferredChoice(ctx,state,[list('B',[dates[0]],{mode:'manual'})]),null);
 assert.deepEqual(preferredChoice(ctx,state,[list('B',[dates[0]],{mode:'immediate'})]),[dates[0]]);
 assert.deepEqual(preferredChoice(ctx,state,[list('B',[dates[0]])]),[dates[0]]);
});

test('al vencer el plazo sin ninguna preferencia libre, el turno queda para elección manual',()=>{
 const {ctx,state,dates}=fixture();
 ctx.awards=[{id:'a',member_id:'A',cycle_date:dates[0]},{id:'c',member_id:'C',cycle_date:dates[0]}];
 const started=stampTurn(state,0,new Date(T0).toISOString())!;
 const result=advanceAutomatic(ctx,started,[list('B',[dates[0]],{mode:'wait',waitMinutes:5})],12,T0+3600_000);
 assert.equal(result.choices.length,0);
 assert.equal(result.state.cursor,0);
});

test('el reloj se reinicia con un turno nuevo o al reanudar, y se conserva si el turno sigue',()=>{
 const {state}=fixture();
 const at=new Date(T0).toISOString(),later=new Date(T0+60_000).toISOString();
 const first=stampTurn(state,0,at)!;
 assert.deepEqual(first.turnSince,{cursor:0,at});
 assert.equal(stampTurn(first,0,later),first);
 assert.deepEqual(stampTurn(first,1,later)!.turnSince,{cursor:1,at:later});
 assert.deepEqual(stampTurn(first,0,later,true)!.turnSince,{cursor:0,at:later});
 assert.equal(stampTurn({...state,status:'paused'},0,at)!.turnSince,undefined);
 validateElectionState(first,fixture().ctx.members);
 assert.throws(()=>validateElectionState({...state,turnSince:{cursor:0,at:'mañana'}},fixture().ctx.members),/Inicio de turno/);
});

test('automaticAt: inmediata desde ya, esperar desde el inicio más el plazo, nunca sin lista',()=>{
 const {state,dates}=fixture();
 const started=stampTurn(state,0,new Date(T0).toISOString())!;
 assert.equal(automaticAt(list('B',[dates[0]]),started,0),0);
 assert.equal(automaticAt(list('B',[dates[0]],{mode:'wait',waitMinutes:90}),started,0),T0+90*60_000);
 assert.equal(automaticAt(list('B',[dates[0]],{mode:'manual'}),started,0),null);
 assert.equal(automaticAt(list('B',[]),started,0),null);
 assert.equal(automaticAt(list('B',[dates[0]],{active:false}),started,0),null);
 assert.equal(automaticAt(undefined,started,0),null);
});

test('simulación «si reanudas»: aplica las inmediatas y se para en quien espera o elige a mano',()=>{
 const {ctx,state,dates}=fixture();
 const paused:ElectionState={...state,status:'paused'};
 const prefs=[list('B',[dates[0]]),list('A',[dates[1]]),list('C',[dates[2]],{mode:'wait',waitMinutes:120})];
 const chain=automaticChain(ctx,paused,prefs);
 assert.deepEqual(chain.applied,[{memberId:'B',dates:[dates[0]]},{memberId:'A',dates:[dates[1]]}]);
 assert.deepEqual(chain.stop,{memberId:'C',reason:'wait',waitMinutes:120});
 const manual=automaticChain(ctx,paused,[list('B',[dates[0]]),list('A',[dates[1]],{mode:'manual'})]);
 assert.deepEqual(manual.stop,{memberId:'A',reason:'manual'});
 assert.deepEqual(automaticChain(ctx,paused,[]).stop,{memberId:'B',reason:'manual'});
 ctx.awards=[{id:'a',member_id:'A',cycle_date:dates[0]},{id:'c',member_id:'C',cycle_date:dates[0]}];
 assert.deepEqual(automaticChain(ctx,paused,[list('B',[dates[0]])]).stop,{memberId:'B',reason:'no-option'});
 // Simulating never touches the stored state.
 assert.equal(paused.status,'paused');
});

test('la cola de la ronda indica el modo de cada lista y nunca sus ciclos',()=>{
 const {ctx,state,dates}=fixture();
 const prefs=[list('A',[dates[1]],{mode:'wait',waitMinutes:45}),list('C',[dates[2]],{mode:'manual'})];
 const queue=roundQueue(ctx,{...state,cursor:1},prefs);
 assert.deepEqual(queue,[
  {memberId:'A',mode:'wait',waitMinutes:45,current:true},
  {memberId:'C',mode:'manual',waitMinutes:0,current:false},
 ]);
 assert.ok(!JSON.stringify(queue).includes(dates[1]));
 assert.deepEqual(roundQueue(ctx,state,[list('B',[dates[0]],{active:false})])[0],{memberId:'B',mode:'none',waitMinutes:0,current:true});
});
