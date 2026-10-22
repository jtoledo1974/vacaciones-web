import {test} from 'node:test';
import assert from 'node:assert/strict';
import {calendar} from '../domain/calendar.ts';
import {defaultConfig} from '../domain/defaults.ts';
import {registerJointAgreement,cancelJointAgreement,choose,chooseJoint,currentTurn,type ElectionContext,type ElectionState} from '../domain/election.ts';

function fixture(){
 const config={...defaultConfig(2026),cyclesPerPerson:6};
 const ctx:ElectionContext={year:2026,team:'C',config,members:['A','B','C'].map(id=>({id,code:id,seniority:''})),requests:[],awards:[]};
 const state:ElectionState={status:'active',order:['A','B','C'],cursor:0,credits:{},source:'Puntuaciones anteriores comprobadas',allowDeferral:true};
 const dates=calendar(2026,'C',config).map(c=>c.date);
 return {ctx,state,dates};
}
test('acuerdo excepcional en ronda 3 sin alterar rondas anteriores',()=>{
 const {ctx,dates}=fixture();let {state}=fixture();
 for(let round=0;round<2;round++)for(const [i,memberId] of ['A','B','C'].entries()){
  const selected=dates[round*3+i],result=choose(ctx,state,memberId,[selected]);
  ctx.awards.push({id:`${round}-${i}`,member_id:memberId,cycle_date:selected});state=result.state;
 }
 assert.equal(currentTurn(ctx,state).round,3);
 state=registerJointAgreement(ctx,state,['A','C'],3,'admin','2026-10-22');
 assert.equal(currentTurn(ctx,state).memberId,'B');
 let result=choose(ctx,state,'B',[dates[6]]);ctx.awards.push({id:'b3',member_id:'B',cycle_date:dates[6]});state=result.state;
 assert.deepEqual(currentTurn(ctx,state).participants,['A','C']);
 const before=structuredClone(state);
 assert.throws(()=>chooseJoint(ctx,state,[{member_id:'A',dates:[dates[7]]}]),/todos sus participantes/);
 assert.deepEqual(state,before);
 const joined=chooseJoint(ctx,state,[{member_id:'A',dates:[dates[7]]},{member_id:'C',dates:[dates[8]]}]);
 assert.equal(joined.choices.length,2);
 assert.equal(joined.state.cursor>=9,true);
});
test('anular acuerdo antes de consumir el primer turno y rechazarlo después',()=>{
 const {ctx,state,dates}=fixture();
 const grouped=registerJointAgreement(ctx,state,['A','C'],1,'admin','2026-10-22');
 const cancelled=cancelJointAgreement(ctx,grouped,['A','C'],1,'admin','2026-10-22');
 assert.equal(currentTurn(ctx,cancelled).memberId,'A');
 assert.equal(cancelled.jointAgreements?.[0].cancelledBy,'admin');
 const next=choose(ctx,grouped,'B',[dates[0]]);
 ctx.awards.push({id:'b',member_id:'B',cycle_date:dates[0]});
 assert.throws(()=>cancelJointAgreement(ctx,next.state,['A','C'],1,'admin','2026-10-22'),/ya ha empezado/);
});
test('validación de duplicados, rondas anteriores y membresía superpuesta',()=>{
 const {ctx,state,dates}=fixture();
 assert.throws(()=>registerJointAgreement(ctx,state,['A','A'],1,'admin','now'),/diferentes/);
 assert.throws(()=>registerJointAgreement(ctx,state,['A'],1,'admin','now'),/dos o tres/);
 const grouped=registerJointAgreement(ctx,state,['A','B'],1,'admin','now');
 assert.throws(()=>registerJointAgreement(ctx,grouped,['B','C'],1,'admin','now'),/pertenece/);
 const chosen=choose(ctx,state,'A',[dates[0]]);
 ctx.awards.push({id:'a',member_id:'A',cycle_date:dates[0]});
 assert.throws(()=>registerJointAgreement(ctx,chosen.state,['A','C'],1,'admin','now'),/ya ha pasado/);
});
test('respetar la rotación real de empates en el último participante',()=>{
 const {ctx,state}=fixture();state.tieGroups=[['B','C']];
 state.cursor=3; // Round 2: A, C, B.
 const group=registerJointAgreement(ctx,state,['A','B'],2,'admin','now');
 assert.equal(currentTurn(ctx,group).memberId,'C');
 assert.deepEqual(currentTurn(ctx,{...group,cursor:5}).participants,['A','B']);
});
