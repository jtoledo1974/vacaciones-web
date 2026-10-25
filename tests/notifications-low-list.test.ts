import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SQLiteRepo} from './sqlite-repo.ts';
import {enqueueLowListAlerts,notificationText} from '../server/notifications.ts';

const now=Date.parse('2027-03-10T10:00:00Z');
const recent=new Date(now-60_000).toISOString();
const fran={id:'m-fran',person_id:'p-fran'},juan={id:'m-juan',person_id:'p-juan'};

async function fixture({linked=true,active=true,decisionAt=recent}={}){
 const repo=new SQLiteRepo();
 await repo.batch([
  {sql:"INSERT INTO teams(id,name) VALUES('B','Equipo B')",args:[]},
  {sql:"INSERT INTO people(id,team_id,code,seniority) VALUES('p-fran','B','FRAN','2001-01-01'),('p-juan','B','JUAN','2000-01-01')",args:[]},
  {sql:"INSERT INTO campaigns(id,team_id,year,created_at) VALUES('c1','B',2027,?)",args:[recent]},
  {sql:"INSERT INTO campaign_members(id,campaign_id,person_id,code,seniority) VALUES('m-fran','c1','p-fran','FRAN','2001-01-01'),('m-juan','c1','p-juan','JUAN','2000-01-01')",args:[]},
  {sql:'INSERT INTO audit(id,actor,action,team_id,campaign_id,created_at) VALUES(?,?,?,?,?,?)',args:['a1','chatgpt:juan','choose','B','c1',decisionAt]},
  ...(linked?[{sql:"INSERT INTO controller_accounts(person_id,principal_key) VALUES('p-fran','chatgpt-email:fran@example.test')",args:[]}]:[]),
 ]);
 const preferences=[{member_id:'m-fran',dates:['2027-07-12','2027-07-19','2027-08-02','2027-08-09'],automatic:true,persistent:false,active}];
 return {repo,preferences};
}

// JUAN took 12 jul and 19 jul: only two of FRAN's four options remain.
const viable=(_member:string,date:string)=>!['2027-07-12','2027-07-19'].includes(date);
const input=(preferences:any[])=>({campaignId:'c1',members:[fran,juan],awards:[],preferences,turnMemberIds:['m-juan'],needs:(_id:string)=>true,viable,now});

test('avisa cuando a tu lista solo le quedan dos opciones viables, una vez por recuento',async()=>{
 const {repo,preferences}=await fixture();
 await enqueueLowListAlerts(repo,input(preferences));
 await enqueueLowListAlerts(repo,input(preferences));
 const rows=(await repo.all('SELECT id,owner_key,member_id,push_status FROM turn_notifications')).map(r=>({...r}));
 assert.deepEqual(rows,[{id:'low:c1:m-fran:2',owner_key:'chatgpt-email:fran@example.test',member_id:'m-fran',push_status:'pending'}]);
});

test('no avisa sin cambios recientes, sin cuenta, con la lista inactiva, si es su turno o si ya tiene sus ciclos',async()=>{
 const cases:[any,any][]=[
  [{decisionAt:new Date(now-3600_000).toISOString()},{}],
  [{linked:false},{}],
  [{active:false},{}],
  [{},{turnMemberIds:['m-fran']}],
  [{},{needs:()=>false}],
 ];
 for(const [setup,override] of cases){
  const {repo,preferences}=await fixture(setup);
  await enqueueLowListAlerts(repo,{...input(preferences),...override});
  assert.deepEqual(await repo.all('SELECT id FROM turn_notifications'),[],JSON.stringify({setup,override:Object.keys(override)}));
 }
});

test('con opciones de sobra no avisa',async()=>{
 const {repo,preferences}=await fixture();
 await enqueueLowListAlerts(repo,{...input(preferences),viable:()=>true});
 assert.deepEqual(await repo.all('SELECT id FROM turn_notifications'),[]);
});

test('el texto dice cuántas opciones quedan, o que no queda ninguna',()=>{
 assert.deepEqual(notificationText({id:'low:c1:m-fran:2',round:1}),{title:'Vacaciones · Tu lista se queda sin opciones',body:'Solo quedan 2 opciones disponibles en tus preferencias. Añade alguna más antes de tu turno.'});
 assert.match(notificationText({id:'low:c1:m-fran:1',round:1}).body,/Solo queda 1 opción disponible/);
 assert.match(notificationText({id:'low:c1:m-fran:0',round:1}).body,/Ninguna de tus preferencias está disponible/);
});

test('la viabilidad usa las reglas de la elección: un ciclo lleno o ya tuyo no cuenta',async()=>{
 const {lowListInput}=await import('../server/notifications.ts');
 const {defaultConfig}=await import('../domain/defaults.ts');
 const {calendar}=await import('../domain/calendar.ts');
 const config={...defaultConfig(2026),cyclesPerPerson:2,summerPerPerson:0};
 const dates=calendar(2026,'C',config).map(c=>c.date);
 const ctx={year:2026,team:'C',config,members:['A','B','C'].map(id=>({id,code:id,seniority:'',person_id:'p-'+id})),requests:[],
  awards:[{id:'x',member_id:'A',cycle_date:dates[0]},{id:'y',member_id:'C',cycle_date:dates[0]},{id:'z',member_id:'B',cycle_date:dates[2]}]};
 const built=lowListInput(ctx as any,{participants:['A'],memberId:'A'},[{member_id:'B',dates_json:JSON.stringify([dates[0],dates[1],dates[2]]),active:1}],'c1',now);
 assert.deepEqual(built.turnMemberIds,['A']);
 assert.deepEqual(built.preferences[0].dates.filter(d=>built.viable('B',d)),[dates[1]]);
 assert.equal(built.needs('B'),true);
 assert.equal(built.needs('A'),true);
});
