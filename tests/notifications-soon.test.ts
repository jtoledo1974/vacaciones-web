import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SQLiteRepo} from './sqlite-repo.ts';
import {enqueueInactiveListAlerts,notificationText} from '../server/notifications.ts';
import {turnsUntil} from '../app/my-election-state.ts';

const now=Date.parse('2027-03-10T10:00:00Z');
const ids=['m-a','m-b','m-c','m-d','m-fran','m-z'];
const members=ids.map(id=>({id,person_id:'p-'+id}));
// Round 1, cursor 0: A elige ahora; FRAN va quinto (4 turnos por delante con A).
const state={status:'active',order:ids,cursor:0,credits:{}} as any;

async function fixture(linked=true){
 const repo=new SQLiteRepo();
 await repo.batch([
  {sql:"INSERT INTO teams(id,name) VALUES('B','Equipo B')",args:[]},
  {sql:"INSERT INTO people(id,team_id,code,seniority) VALUES('p-m-fran','B','FRAN','2001-01-01')",args:[]},
  ...(linked?[{sql:"INSERT INTO controller_accounts(person_id,principal_key) VALUES('p-m-fran','chatgpt-email:fran@example.test')",args:[]}]:[]),
 ]);
 return repo;
}
const input=(over:any={})=>({campaignId:'c1',members,state:{...state,cursor:1},awards:[],entitlement:6,round:1,turnMemberIds:['m-b'],preferences:[],now,...over});

test('turnsUntil cuenta solo a quien aún tiene ciclos por elegir',()=>{
 assert.equal(turnsUntil(state,[],6,'m-fran'),4);
 assert.equal(turnsUntil(state,Array.from({length:6},(_,i)=>({member_id:'m-c',cycle_date:'d'+i})),6,'m-fran'),3);
 assert.equal(turnsUntil(state,[],6,'m-a'),0);
});

test('avisa a quien le toca pronto sin preferencias activas, una vez por ronda',async()=>{
 const repo=await fixture();
 // cursor 1: B elige; por delante de FRAN quedan B, C y D.
 await enqueueInactiveListAlerts(repo,input());
 await enqueueInactiveListAlerts(repo,input());
 const rows=(await repo.all('SELECT id,owner_key,member_id,round FROM turn_notifications')).map(r=>({...r}));
 assert.deepEqual(rows,[{id:'soon:c1:m-fran:1',owner_key:'chatgpt-email:fran@example.test',member_id:'m-fran',round:1}]);
});

test('no avisa si falta mucho, si tiene lista activa, si no tiene cuenta, si es su turno o si ya tiene sus ciclos',async()=>{
 const cases:[boolean,any][]=[
  [true,{state}],
  [true,{preferences:[{member_id:'m-fran',dates:['2027-07-12'],active:true}]}],
  [false,{}],
  [true,{turnMemberIds:['m-fran']}],
  [true,{awards:Array.from({length:6},(_,i)=>({member_id:'m-fran',cycle_date:'d'+i}))}],
 ];
 for(const [linked,over] of cases){
  const repo=await fixture(linked);
  await enqueueInactiveListAlerts(repo,input(over));
  assert.deepEqual(await repo.all('SELECT id FROM turn_notifications'),[],JSON.stringify(Object.keys(over)));
 }
});

test('una lista ya usada cuenta como inactiva',async()=>{
 const repo=await fixture();
 await enqueueInactiveListAlerts(repo,input({preferences:[{member_id:'m-fran',dates:['2027-07-12'],active:false}]}));
 assert.equal((await repo.all('SELECT id FROM turn_notifications')).length,1);
});

test('el texto invita a preparar las preferencias',()=>{
 assert.deepEqual(notificationText({id:'soon:c1:m-fran:1',round:1}),{title:'Vacaciones · Tu turno se acerca',body:'Ronda 1. Te toca pronto y no tienes preferencias que se apliquen solas. Prepáralas por si no estás cuando llegue tu turno.'});
});
