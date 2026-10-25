import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildElectionTimeline,publicElectionTimeline} from '../server/election-timeline.ts';
import {orderForRound,type ElectionContext,type ElectionState} from '../domain/election.ts';
import {defaultConfig} from '../domain/defaults.ts';
import {numberTimelineCycles} from '../domain/timeline-numbering.ts';

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
 const numbers=numberTimelineCycles(events);
 assert.deepEqual(numbers.get('one'),[1]);
 assert.deepEqual(numbers.get('three'),[2]);
 assert.deepEqual(numbers.get('double'),[1,2]);
 assert.deepEqual(numbers.get('five'),[3]);
 assert.deepEqual(numbers.get('seven'),[1]);
 assert.equal(numbers.has('draw'),false);
 assert.equal(numbers.has('skip'),false);
});

test('simulación con orden heredado sin start local conserva adjudicaciones después del sorteo',()=>{
 const a=award('a','A','2026-01-01'),b=award('b','B','2026-01-09');
 const ctx:ElectionContext={year:2026,team:'C',config:defaultConfig(2026),
  members:['A','B','C'].map(id=>({id,code:id,seniority:''})),requests:[],awards:[a,b]};
 const rows=[
  row('resume','resume',snap(0,[]),{}),
  row('draw','resolve_tie',null,{resolution}),
  row('first','choose',snap(0,[]),{choices:[choice('A',a.cycle_date)]}),
  row('second','advance',snap(1,[a]),{choices:[choice('B',b.cycle_date)]})
 ];
 const events=buildElectionTimeline(rows,ctx,state(2));
 assert.deepEqual(events.map(e=>[e.id,e.kind]),[['second','choice'],['first','choice'],['draw','tie']]);
 assert.deepEqual(numberTimelineCycles(events).get('second'),[2]);
 const undone=buildElectionTimeline([...rows,row('undo','election_undo',null,{})],{...ctx,awards:[a]},state(1));
 assert.deepEqual(undone.map(e=>e.id),['first','draw']);
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

test('la reconstrucción guiada sustituye turnos históricos sin mostrar decisiones archivadas',()=>{
 const ctx:ElectionContext={year:2026,team:'C',config:defaultConfig(2026),
  members:['A','B','C'].map(id=>({id,code:id,seniority:''})),requests:[],awards:[]};
 const a=award('a','A','2026-01-01'),old=award('old','B','2026-01-09'),replacement=award('new','B','2026-01-17');
 const start=row('start','start',{format:'election-undo-v1',state:null,awards:[]},{});
 const first=row('first','choose',snap(0,[]),{choices:[choice('A',a.cycle_date)]});
 const second=row('second','choose',snap(1,[a]),{choices:[choice('B',old.cycle_date)]});
 const rewind=row('rewind','reconstruction_start',null,{targetId:'second',keepCount:2,originalIds:['second']});
 const rebuild=row('rebuild','reconstruction_step',snap(1,[a]),{kind:'choose',choices:[choice('B',replacement.cycle_date)]});
 ctx.awards=[a,replacement];
 const events=buildElectionTimeline([start,first,second,rewind,rebuild],ctx,state(2));
 assert.deepEqual(events.filter(e=>e.kind==='choice').map(e=>e.id),['rebuild','first']);
 assert.equal(events.find(e=>e.id==='rebuild')?.choices[0].cycle_date,replacement.cycle_date);
 assert.ok(!events.some(e=>e.id==='second'));
});

test('impacto auditado: el timeline conserva solo decisiones vigentes tras undo y redo',()=>{
 const ctx:ElectionContext={year:2027,team:'A',config:defaultConfig(2027),
  members:['A','B'].map(id=>({id,code:id,seniority:''})),requests:[],awards:[]};
 const a=award('a','A','2027-01-08'),b=award('b','B','2027-01-16');
 const start=row('start','start',snap(0,[]),{});
 const first=row('first','choose',snap(0,[]),{
  choices:[choice('A',a.cycle_date)],impact:{
   policyVersion:'lecs-2027-occupancy-v2',status:'exact',
   campaignVersionBefore:10,campaignVersionAfter:11,
   changes:[{cycle:'2027-02-01',delta:-1}],events:[{code:'FOURTH_PERIOD_LIMIT_REACHED',period:1,cycles:['2027-02-01']}]
  }
 });
 const second=row('second','choose',snap(1,[a]),{
  choices:[choice('B',b.cycle_date)],impact:{
   policyVersion:'lecs-2027-occupancy-v2',status:'indeterminate',
   campaignVersionBefore:11,campaignVersionAfter:12,
   changes:[{cycle:'2027-03-01',delta:null}],events:[]
  }
 });
 ctx.awards=[a,b];
 const active=buildElectionTimeline([start,first,second],ctx,state(2));
 assert.equal(active.find(e=>e.id==='first')?.impact?.changes[0].delta,-1);
 assert.equal(active.find(e=>e.id==='second')?.impact?.status,'indeterminate');
 ctx.awards=[a];
 const undone=buildElectionTimeline([... [start,first,second],row('undo','election_undo',null,{})],ctx,state(1));
 assert.deepEqual(undone.filter(e=>e.kind==='choice').map(e=>e.id),['first']);
 assert.equal(undone[0].impact?.campaignVersionBefore,10);
 ctx.awards=[a,b];
 const redone=buildElectionTimeline([start,first,second,row('undo','election_undo',null,{}),
  row('redo','election_redo',null,{})],ctx,state(2));
 assert.equal(redone.find(e=>e.id==='second')?.impact?.changes[0].delta,null);
});

test('timeline projects impact summaries without removing certified audit snapshots',()=>{
 const a=award('a','A','2027-01-08');
 const ctx:ElectionContext={year:2027,team:'A',config:defaultConfig(2027),
  members:['A','B','C'].map(id=>({id,code:id,seniority:''})),requests:[],awards:[a]};
 const impact={policyVersion:'lecs-2027-occupancy-v2',status:'exact',
  campaignVersionBefore:2,campaignVersionAfter:3,changes:[],events:[],
  availabilityBefore:{privateSnapshot:'before'},availabilityAfter:{privateSnapshot:'after'}};
 const decision=row('choice','choose',snap(0,[]),{choices:[choice('A',a.cycle_date)],impact});
 const persisted=decision.after_json;
 const event=buildElectionTimeline([decision],ctx,state(1))[0];
 assert.deepEqual(event.impact,{policyVersion:impact.policyVersion,status:impact.status,
  campaignVersionBefore:2,campaignVersionAfter:3,changes:[],events:[]});
 assert.equal(decision.after_json,persisted);
 assert.deepEqual(JSON.parse(decision.after_json).impact.availabilityBefore,impact.availabilityBefore);
 assert.deepEqual(JSON.parse(decision.after_json).impact.availabilityAfter,impact.availabilityAfter);
});

test('historial: muestra cada aviso normativo solo en la adjudicación que lo introduce',()=>{
 const ctx:ElectionContext={year:2026,team:'C',config:{...defaultConfig(2026),cyclesPerPerson:6},
  members:['A','B','C'].map(id=>({id,code:id,seniority:''})),requests:[],awards:[]};
 const a=award('a','A','2026-01-01'),b=award('b','B','2026-01-09'),c=award('c','C','2026-01-17');
 ctx.awards=[a,b,c];
 const cross={code:'CROSS_PERIOD_FLEXIBILITY',message:'Aviso territorial'};
 const summer={code:'SUMMER_REFERENCE',message:'Aviso estival',period:1};
 const rows=[
  row('start','start',{format:'election-undo-v1',state:null,awards:[]},{}),
  row('draw','resolve_tie',{state:{...state(0),pendingTieGroups:[['A','B','C']]},awards:[]},{resolution}),
  row('one','choose',snap(0,[]),{choices:[choice('A',a.cycle_date)],warnings:[cross]}),
  row('two','choose',snap(1,[a]),{choices:[choice('B',b.cycle_date)],warnings:[cross]}),
  row('three','choose',snap(2,[a,b]),{choices:[choice('C',c.cycle_date)],warnings:[cross,summer]}),
 ];
 const byId=new Map(buildElectionTimeline(rows,ctx,state(3)).map(e=>[e.id,e]));
 assert.deepEqual(byId.get('one')?.warnings,[cross]);
 assert.equal(byId.get('two')?.warnings,undefined);
 assert.deepEqual(byId.get('three')?.warnings,[summer]);
});


test('el historial público solo incluye campos permitidos y marca avances automáticos',()=>{
 const privateEvent={
  id:'auto',kind:'choice',round:2,createdAt:'2026-10-25T00:00:00Z',
  memberIds:['A'],choices:[{member_id:'A',cycle_date:'2027-07-12'}],
  deferredTurns:1,ties:[{memberId:'A',position:1,total:2,order:['A','B']}],
  impact:{secret:'private'},warnings:[{code:'INTERNAL',message:'private'}],
  snapshot:{preferences:['private']},
 } as any;
 const publicEvents=publicElectionTimeline([privateEvent,
  {...privateEvent,id:'manual',kind:'choice'},
  {...privateEvent,id:'draw',kind:'tie',method:'random',order:['A','B']}],
  [{id:'auto',action:'advance'},{id:'manual',action:'choose'},{id:'draw',action:'resolve_tie'}] as any);
 assert.deepEqual(publicEvents[0],{
  id:'auto',kind:'choice',round:2,memberIds:['A'],
  choices:[{member_id:'A',cycle_date:'2027-07-12'}],
  deferredTurns:1,automatic:true
 });
 assert.equal(publicEvents[1].automatic,undefined);
 assert.equal(publicEvents[2].method,'random');
 assert.deepEqual(publicEvents[2].order,['A','B']);
 assert.equal(publicEvents[2].automatic,undefined);
 const text=JSON.stringify(publicEvents);
 for(const forbidden of ['createdAt','impact','warnings','snapshot','ties','private','secret'])
  assert.equal(text.includes(forbidden),false,'Se filtró '+forbidden);
});
