import {test} from 'node:test';
import assert from 'node:assert/strict';
import {choose,defer,currentTurn,advanceAutomatic,visiblePreferenceDates,togglePreferenceDate,validateOrder,resolveTie,registerJointAgreement,orderForRound,type ElectionState,type ElectionContext} from '../domain/election.ts';
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

test('ciclos copados desaparecen sin perder su prioridad y reaparecen tras undo',()=>{
 const dates=['2026-01-01','2026-01-09','2026-01-17'];
 const cycles=dates.map((date,i)=>({date,occupied:i===1?2:0,max:2}));
 assert.deepEqual(visiblePreferenceDates(dates,cycles),[dates[0],dates[2]]);
 // An undo restores capacity; the original list was never modified.
 cycles[1].occupied=1;
 assert.deepEqual(visiblePreferenceDates(dates,cycles),dates);
});


test('preferencias muestran cupos dinámicos disponibles incluso con ocupación 2/2',()=>{
 const dates=['2026-01-01','2026-01-09','2026-01-17'];
 const cycles=[{date:dates[0],occupied:2,max:2,available:true},{date:dates[1],occupied:2,max:2,available:false},{date:dates[2],occupied:3,max:3,available:false}];
 assert.deepEqual(visiblePreferenceDates(dates,cycles),[dates[0]]);
});

test('elección doble aplazada rechaza atómicamente ciclo lleno, sin modificar el estado',()=>{
 const {ctx,state,dates}=fixture();
 const postponed=defer(ctx,state,'B');
 const turn={...postponed,cursor:3};
 const before=structuredClone(turn);
 ctx.awards=[{id:'x',member_id:'A',cycle_date:dates[0]},{id:'y',member_id:'C',cycle_date:dates[0]}];
 // Forzar un cupo inampliable, distinto del 2/2 dinámicamente ampliable.
 ctx.config.specialQuotas={[dates[0]]:2};
 assert.throws(()=>choose(ctx,turn,'B',[dates[0],dates[1]]),/cupo máximo/);
 assert.deepEqual(turn,before);
 assert.equal(ctx.awards.length,2);
 const valid=choose(ctx,turn,'B',[dates[1],dates[2]]);
 assert.equal(valid.choices.length,2);
});

test('automatismo de turno doble aplazado omite ciclos llenos y selecciona alternativa',()=>{
 const {ctx,state,dates}=fixture();
 ctx.config.specialQuotas={[dates[0]]:2};
 ctx.awards=[{id:'x',member_id:'A',cycle_date:dates[0]},{id:'y',member_id:'C',cycle_date:dates[0]}];
 const postponed=defer(ctx,state,'B');
 const turn={...postponed,cursor:3};
 const result=advanceAutomatic(ctx,turn,[{member_id:'B',dates:[dates[0],dates[1],dates[2]],automatic:true}]);
 assert.deepEqual(result.choices.map(c=>c.cycle_date),[dates[1],dates[2]]);
});

test('preferencias: clic alterna selección y permite retirar ciclos sin cupo',()=>{
 const initial=['2027-07-01','2027-08-01'];
 assert.deepEqual(togglePreferenceDate(initial,'2027-07-01',false),['2027-08-01']);
 assert.deepEqual(togglePreferenceDate(initial,'2027-09-01',true),[...initial,'2027-09-01']);
 assert.deepEqual(togglePreferenceDate(initial,'2027-09-01',false),initial);
 assert.deepEqual(initial,['2027-07-01','2027-08-01']);
});


test('un empate futuro puede resolverse sin alterar el turno ni bloquear el acuerdo conjunto posterior',()=>{
 const {ctx,state}=fixture();
 const extended:ElectionState={...state,order:['B','A','C'],tieGroups:[['A','C']],pendingTieGroups:[['A','C']]};
 // Los integrantes de un empate deben ser consecutivos en el orden base.
 extended.order=['B','C','A'];
 extended.tieGroups=[['C','A']];extended.pendingTieGroups=[['C','A']];
 const initial=structuredClone(extended);
 assert.equal(currentTurn(ctx,extended).memberId,'B');
 const resolved=resolveTie(ctx,extended,['A','C'],'external','admin','2026-10-23T09:00:00Z',['C','A']);
 assert.equal(resolved.cursor,0);
 assert.equal(currentTurn(ctx,resolved).memberId,'B');
 assert.deepEqual(resolved.order,['B','A','C']);
 assert.deepEqual(resolved.pendingTieGroups,[]);
 assert.equal(resolved.tieResolutions?.[0].anticipated,true);
 assert.deepEqual(extended,initial);
 assert.throws(()=>resolveTie(ctx,resolved,['C','A'],'random','admin','2026-10-23T09:00:00Z',['C','A']),/pendiente/);
 assert.throws(()=>resolveTie(ctx,extended,['A','B'],'external','admin','2026-10-23T09:00:00Z',['C','A']),/una vez/);
 const joint=registerJointAgreement(ctx,resolved,['B','A'],1,'admin','2026-10-23T09:00:00Z');
 assert.equal(joint.jointAgreements?.length,1);
 assert.equal(joint.cursor,0);
});
test('desempate anticipado de tres rota correctamente en todas las rondas',()=>{
 const {ctx,state}=fixture();
 const prepared:ElectionState={...state,order:['B','A','C'],tieGroups:[['B','A','C']],pendingTieGroups:[['B','A','C']]};
 const resolved=resolveTie(ctx,prepared,['C','A','B'],'external','admin','2026-10-23T09:00:00Z',['B','A','C']);
 assert.deepEqual(orderForRound(resolved,0),['C','A','B']);
 assert.deepEqual(orderForRound(resolved,1),['A','B','C']);
 assert.deepEqual(orderForRound(resolved,2),['B','C','A']);
 assert.deepEqual(orderForRound(resolved,3),['C','A','B']);
 assert.equal(resolved.tieResolutions?.[0].anticipated,false);
});
