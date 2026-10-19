import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildElectionTimeline} from '../server/election-timeline.ts';
import {orderForRound,type ElectionContext,type ElectionState} from '../domain/election.ts';
import {defaultConfig} from '../domain/defaults.ts';

const resolution={order:['A','B','C'],method:'external' as const,at:'2026-10-20T10:00:00.000Z',actor:'admin'};
const state=(cursor:number,credits:Record<string,number>={}):ElectionState=>({
 status:'active',order:['A','B','C'],cursor,credits,source:'Test del orden confirmado',
 allowDeferral:true,tieGroups:[['A','B','C']],pendingTieGroups:[],tieResolutions:[resolution]
});
const choice=(member_id:string,cycle_date:string)=>({member_id,cycle_date});
const award=(id:string,member_id:string,cycle_date:string)=>({id,member_id,cycle_date});
const row=(id:string,action:string,before:any,after:any)=>({
 id,action,before_json:before===null?null:JSON.stringify(before),after_json:JSON.stringify(after),
 created_at:'2026-10-20T10:00:00.000Z'
});
const snap=(cursor:number,awards:any[],credits:Record<string,number>={})=>({format:'election-undo-v1',state:state(cursor,credits),awards,requests:[],preferences:[]});

test('historial: sorteo triple, aplazamiento, turno doble y rotación real en rondas 1–3',()=>{
 const ctx:ElectionContext={year:2026,team:'C',config:{...defaultConfig(2026),cyclesPerPerson:6},
  members:['A','B','C'].map(id=>({id,code:id,seniority:''})),requests:[],awards:[]};
 const a=award('a','A','2026-01-01'),c=award('c','C','2026-01-09');
 const b1=award('b1','B','2026-01-17'),b2=award('b2','B','2026-01-25');
 const c2=award('c2','C','2026-02-02'),a2=award('a2','A','2026-02-10');
 const c3=award('c3','C','2026-02-18');
 ctx.awards=[a,c,b1,b2,c2,a2,c3];
 const rows=[
  row('start','start',{format:'election-undo-v1',state:null,awards:[]},{}),
  row('draw','resolve_tie',{state:{...state(0),pendingTieGroups:[['A','B','C']]},awards:[]},{resolution}),
  row('one','choose',snap(0,[]),{choices:[choice('A',a.cycle_date)],memberId:'A'}),
  row('skip','defer',snap(1,[a]),{choices:[],memberId:'B'}),
  row('three','choose',snap(2,[a]),{choices:[choice('C',c.cycle_date)],memberId:'C'}),
  row('double','choose',snap(3,[a,c],{B:1}),{choices:[choice('B',b1.cycle_date),choice('B',b2.cycle_date)],memberId:'B'}),
  row('five','choose',snap(4,[a,c,b1,b2]),{choices:[choice('C',c2.cycle_date)]}),
  row('six','choose',snap(5,[a,c,b1,b2,c2]),{choices:[choice('A',a2.cycle_date)]}),
  row('seven','choose',snap(6,[a,c,b1,b2,c2,a2]),{choices:[choice('C',c3.cycle_date)]}),
 ];
 const events=buildElectionTimeline(rows,ctx,state(7));
 assert.equal(events.length,8);
 assert.equal(events[0].round,3);
 assert.deepEqual(events[0].ties[0],{memberId:'C',position:1,total:3,order:['C','A','B']});
 const double=events.find(e=>e.id==='double')!;
 assert.equal(double.round,2);
 assert.equal(double.kind,'choice');
 assert.equal(double.choices.length,2);
 assert.equal(double.deferredTurns,1);
 assert.deepEqual(double.ties[0].order,['B','C','A']);
 assert.equal(events.find(e=>e.id==='skip')?.kind,'defer');
 assert.equal(events.find(e=>e.id==='skip')?.round,1);
 assert.deepEqual(events.find(e=>e.id==='one')?.ties[0].order,['A','B','C']);
 assert.equal(events.find(e=>e.id==='draw')?.kind,'tie');
 assert.deepEqual(events.find(e=>e.id==='draw')?.order,['A','B','C']);
});

test('deshacer, rehacer y bifurcar no muestran adjudicaciones anuladas',()=>{
 const ctx:ElectionContext={year:2026,team:'C',config:defaultConfig(2026),
  members:['A','B','C'].map(id=>({id,code:id,seniority:''})),requests:[],awards:[]};
 const a=award('a','A','2026-01-01'),b=award('b','B','2026-01-09');
 const start=row('start','start',{format:'election-undo-v1',state:null,awards:[]},{});
 const first=row('first','choose',snap(0,[]),{choices:[choice('A',a.cycle_date)]});
 const second=row('second','choose',snap(1,[a]),{choices:[choice('B',b.cycle_date)]});
 const undo=row('undo','election_undo',null,{});
 const redo=row('redo','election_redo',null,{});
 ctx.awards=[a];
 assert.deepEqual(buildElectionTimeline([start,first,second,undo],ctx,state(1)).filter(e=>e.kind==='choice').map(e=>e.id),['first']);
 ctx.awards=[a,b];
 assert.deepEqual(buildElectionTimeline([start,first,second,undo,redo],ctx,state(2)).filter(e=>e.kind==='choice').map(e=>e.id),['second','first']);
 const fork=row('fork','defer',snap(1,[a]),{memberId:'B',choices:[]});
 ctx.awards=[a];
 const forked=buildElectionTimeline([start,first,second,undo,fork,redo],ctx,state(2,{B:1}));
 assert.deepEqual(forked.map(e=>e.id),['fork','first']);
});

test('cuatro empatados rotan dentro del grupo, sin mover a terceros',()=>{
 const ctx:ElectionContext={year:2026,team:'C',config:defaultConfig(2026),
  members:['X','A','B','C','D','Y'].map(id=>({id,code:id,seniority:''})),requests:[],awards:[]};
 const source:ElectionState={...state(0),order:['X','A','B','C','D','Y'],tieGroups:[['A','B','C','D']]};
 assert.deepEqual(orderForRound(source,0),['X','A','B','C','D','Y']);
 assert.deepEqual(orderForRound(source,1),['X','B','C','D','A','Y']);
 assert.deepEqual(orderForRound(source,2),['X','C','D','A','B','Y']);
 assert.deepEqual(orderForRound(source,3),['X','D','A','B','C','Y']);
});
