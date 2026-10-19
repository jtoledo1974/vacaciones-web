import {test} from 'node:test';
import assert from 'node:assert/strict';
import {choose,defer,currentTurn,advanceAutomatic,visiblePreferenceDates,validateOrder,type ElectionState,type ElectionContext} from '../domain/election.ts';
import {defaultConfig} from '../domain/defaults.ts';
import {calendar} from '../domain/calendar.ts';
function fixture(){const config={...defaultConfig(2026),cyclesPerPerson:2,summerPerPerson:0};const ctx:ElectionContext={year:2026,team:'C',config,members:['A','B','C'].map(id=>({id,code:id,seniority:''})),requests:[],awards:[]};const state:ElectionState={status:'active',order:['B','A','C'],cursor:0,credits:{},source:'Orden histórico confirmado',allowDeferral:true};return {ctx,state,dates:calendar(2026,'C',config).map(c=>c.date)};}
test('orden confirmado inmutable: las puntuaciones actuales no cambian quién elige',()=>{const {ctx,state,dates}=fixture();const before=structuredClone(state);assert.throws(()=>choose(ctx,state,'A',[dates[0]]),/turno/);const result=choose(ctx,state,'B',[dates[0]]);assert.deepEqual(result.state.order,state.order);assert.equal(currentTurn({...ctx,awards:[{id:'x',member_id:'B',cycle_date:dates[0]}]},result.state).memberId,'A');assert.deepEqual(state,before);assert.equal(ctx.awards.length,0);});
test('automatismo respeta turno y prioridad y omite ciclos ocupados',()=>{const {ctx,state,dates}=fixture();ctx.awards=[{id:'x',member_id:'A',cycle_date:dates[0]},{id:'y',member_id:'C',cycle_date:dates[0]}];const result=advanceAutomatic(ctx,state,[{member_id:'B',dates:[dates[0],dates[1]],automatic:true},{member_id:'C',dates:[dates[2]],automatic:true}]);assert.equal(result.choices.length,1);assert.equal(result.choices[0].member_id,'B');assert.equal(result.choices[0].cycle_date,dates[1]);assert.equal(currentTurn({...ctx,awards:[...ctx.awards,{id:'z',...result.choices[0]}]},result.state).memberId,'A');});
test('aplazamiento permite dos ciclos juntos y no admite encadenar otro aplazamiento',()=>{const {ctx,state,dates}=fixture();const postponed=defer(ctx,state,'B');const next={...postponed,cursor:3};assert.equal(currentTurn(ctx,next).needed,2);assert.throws(()=>choose(ctx,next,'B',[dates[0]]),/2 ciclo/);assert.throws(()=>defer(ctx,next,'B'),/otro aplazamiento/);const result=choose(ctx,next,'B',[dates[0],dates[1]]);assert.equal(result.choices.length,2);assert.equal(result.state.credits.B,0);});
test('dos ciclos automáticos se confirman de forma conjunta o el turno espera',()=>{const {ctx,state,dates}=fixture();state.credits.B=1;const preferences=[{member_id:'B',dates:[dates[0]],automatic:true}];const held=advanceAutomatic(ctx,state,preferences);assert.equal(held.choices.length,0);assert.equal(held.state.cursor,0);preferences[0].dates.push(dates[1]);const chosen=advanceAutomatic(ctx,state,preferences);assert.equal(chosen.choices.length,2);});
test('preferencias antiguas sin autorización también se aplican; sin opciones o en pausa se detienen',()=>{const {ctx,state,dates}=fixture();assert.equal(advanceAutomatic(ctx,state,[{member_id:'B',dates:[dates[0]],automatic:false}]).choices.length,1);assert.equal(advanceAutomatic(ctx,{...state,status:'paused'},[{member_id:'B',dates:[dates[0]],automatic:true}]).choices.length,0);assert.throws(()=>validateOrder(['B','B','C'],ctx.members),/una vez/);assert.throws(()=>choose(ctx,state,'B',[dates[0],dates[0]]),/corresponde/);});

test('preferencias de un solo turno se consumen; las persistentes sobreviven a la ronda',()=>{
 const {ctx,state,dates}=fixture();
 const one=advanceAutomatic(ctx,state,[{member_id:'B',dates:[dates[0],dates[1]],automatic:false,persistent:false,active:true}]);
 assert.deepEqual(one.choices.map(c=>c.cycle_date),[dates[0]]);
 assert.equal(one.preferences[0].active,false);
 const all=advanceAutomatic(ctx,state,[{member_id:'B',dates:[dates[0],dates[1]],automatic:true,persistent:true,active:true}]);
 assert.deepEqual(all.choices.map(c=>c.cycle_date),[dates[0]]);
 assert.equal(all.preferences[0].active,true);
 const prior=[{id:'b',member_id:'B',cycle_date:dates[0]},{id:'a',member_id:'A',cycle_date:dates[2]},{id:'c',member_id:'C',cycle_date:dates[3]}];
 const second=advanceAutomatic({...ctx,awards:prior},{...state,cursor:3},all.preferences);
 assert.deepEqual(second.choices.map(c=>c.cycle_date),[dates[1]]);
 const inactive=advanceAutomatic({...ctx,awards:prior},{...state,cursor:3},one.preferences);
 assert.equal(inactive.choices.length,0);
});
test('preferencia de siguiente turno no se consume al aplazar',()=>{
 const {ctx,state,dates}=fixture();
 const deferred=defer(ctx,state,'B');
 const p=[{member_id:'B',dates:[dates[0],dates[1]],automatic:false,persistent:false,active:true}];
 const waiting=advanceAutomatic(ctx,deferred,p);
 assert.equal(waiting.choices.length,0);
 assert.equal(waiting.preferences[0].active,true);
 const awards=[{id:'a',member_id:'A',cycle_date:dates[2]},{id:'c',member_id:'C',cycle_date:dates[3]}];
 const next=advanceAutomatic({...ctx,awards},{...deferred,cursor:3},waiting.preferences);
 assert.deepEqual(next.choices.map(c=>c.cycle_date),[dates[0],dates[1]]);
 assert.equal(next.preferences[0].active,false);
});
