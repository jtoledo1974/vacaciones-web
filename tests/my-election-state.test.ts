import { test } from 'node:test';
import assert from 'node:assert/strict';
import { myElection, type MyElectionInput } from '../app/my-election-state.ts';

const cycles=[
 {date:'2027-07-04',end:'2027-07-11',score:80,occupied:1,max:4},
 {date:'2027-07-12',end:'2027-07-19',score:80,occupied:3,max:4},
 {date:'2027-07-20',end:'2027-07-27',score:80,occupied:4,max:4},
];
const state:any={status:'active',order:['a','b','c','d'],cursor:1,credits:{}};
const base:MyElectionInput={myMemberId:'d',cyclesPerPerson:6,cycles,awards:[{member_id:'a',cycle_date:'2027-07-04'}],preferences:[],state,turn:{memberId:'b',participants:['b'],needed:1,round:1}};

test('sin controlador vinculado no hay estado personal', () => {
 assert.equal(myElection({...base,myMemberId:null}),null);
});

test('cuenta las personas pendientes por delante en la ronda', () => {
 const r=myElection(base)!;
 assert.equal(r.phase,'waiting');
 assert.equal(r.turnsAhead,2);
 assert.equal(r.list.state,'none');
});

test('reconoce el propio turno', () => {
 const r=myElection({...base,turn:{memberId:'d',participants:['d'],needed:2,round:1}})!;
 assert.equal(r.phase,'my-turn');
 assert.equal(r.needed,2);
});

test('la lista usada no figura como activa y marca lo ya adjudicado y lo copado', () => {
 const r=myElection({...base,awards:[{member_id:'d',cycle_date:'2027-07-12'}],
  preferences:[{member_id:'d',dates:['2027-07-12','2027-07-20','2027-07-04'],active:false}]})!;
 assert.equal(r.list.state,'used');
 assert.deepEqual(r.list.entries.map(e=>[e.mine,e.free]),[[true,1],[false,0],[false,3]]);
 assert.equal(r.list.unavailable,1);
 assert.equal(r.list.firstViable,'2027-07-04');
 assert.equal(r.cycles.length,1);
});

test('distingue lista para el próximo turno, para todas las rondas y automatismos detenidos', () => {
 const p={member_id:'d',dates:['2027-07-04']};
 assert.equal(myElection({...base,preferences:[p]})!.list.state,'active-next');
 assert.equal(myElection({...base,preferences:[{...p,persistent:true}]})!.list.state,'active-all');
 assert.equal(myElection({...base,preferences:[p],state:{...state,automaticPaused:true}})!.list.state,'paused');
});

test('fases sin elección activa', () => {
 assert.equal(myElection({...base,state:null})!.phase,'not-started');
 assert.equal(myElection({...base,state:{...state,status:'paused'}})!.phase,'paused');
});

test('quienes van delante con preferencias activas: cuándo puede llegar tu turno', async () => {
 const {aheadNote}=await import('../app/my-election-state.ts');
 const waiting=(automaticAhead:number|null,turnsAhead=2)=>({...myElection(base)!,turnsAhead,automaticAhead});
 assert.equal(myElection({...base,automaticAhead:1})!.automaticAhead,1);
 // Someone ahead always chooses by hand (usually whoever is choosing now):
 // if all of them had active lists, their turns would already be resolved.
 assert.equal(aheadNote(waiting(1,2)),'Tu turno puede llegar en cuanto termine quien está eligiendo ahora: la otra persona que va delante elegirá automáticamente con sus preferencias.');
 assert.equal(aheadNote(waiting(2,3)),'Tu turno puede llegar en cuanto termine quien está eligiendo ahora: las otras 2 personas que van delante elegirán automáticamente con sus preferencias.');
 assert.equal(aheadNote(waiting(1,3)),'1 de las 3 personas que van delante elegirá automáticamente con sus preferencias. Tu turno puede llegar en cuanto elijan las otras 2.');
 assert.equal(aheadNote(waiting(2,2)),null);
 assert.equal(aheadNote(waiting(0)),null);
 assert.equal(aheadNote(waiting(null)),null);
 assert.equal(aheadNote({...waiting(2),phase:'my-turn'}),null);
});
