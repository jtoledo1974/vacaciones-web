import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SQLiteRepo} from './sqlite-repo.ts';
import {dispatchNotifications,enqueueAutomaticChoices} from '../server/notifications.ts';

const config={VAPID_PUBLIC_KEY:'test-public',VAPID_PRIVATE_JWK:'test-private',VAPID_SUBJECT:'mailto:admin@example.test'};
const now=Date.parse('2027-03-10T10:00:00Z');
const recent=new Date(now-60_000).toISOString();
const endpoint='https://push.example.test/fran';

/** Live campaign B-2027 where FRAN's list chose 12 jul in round 1. */
async function fixture({scope='live',status='active',awarded=true,linked=true,at=recent}={}){
 const repo=new SQLiteRepo();
 await repo.batch([
  {sql:"INSERT INTO teams(id,name) VALUES('B','Equipo B')",args:[]},
  {sql:"INSERT INTO people(id,team_id,code,seniority) VALUES('p-fran','B','FRAN','2001-01-01'),('p-juan','B','JUAN','2000-01-01')",args:[]},
  {sql:"INSERT INTO campaigns(id,team_id,year,scope_key,created_at) VALUES('c1','B',2027,?,?)",args:[scope,recent]},
  {sql:"INSERT INTO parameters(campaign_id,json) VALUES('c1','{}')",args:[]},
  {sql:"INSERT INTO campaign_members(id,campaign_id,person_id,code,seniority) VALUES('m-fran','c1','p-fran','FRAN','2001-01-01'),('m-juan','c1','p-juan','JUAN','2000-01-01')",args:[]},
  {sql:'INSERT INTO election_states(campaign_id,json) VALUES(?,?)',args:['c1',JSON.stringify({status,order:['m-juan','m-fran'],cursor:2})]},
  {sql:'INSERT INTO audit(id,actor,action,team_id,campaign_id,before_json,after_json,created_at) VALUES(?,?,?,?,?,?,?,?)',args:['a-juan','chatgpt:juan','choose','B','c1',JSON.stringify({state:{order:['m-juan','m-fran'],cursor:0}}),JSON.stringify({choices:[{member_id:'m-juan',cycle_date:'2027-08-02'}]}),recent]},
  {sql:'INSERT INTO audit(id,actor,action,team_id,campaign_id,before_json,after_json,created_at) VALUES(?,?,?,?,?,?,?,?)',args:['a-auto','chatgpt:juan','advance','B','c1',JSON.stringify({state:{order:['m-juan','m-fran'],cursor:1}}),JSON.stringify({choices:[{member_id:'m-fran',cycle_date:'2027-07-12'}]}),at]},
  {sql:"INSERT INTO awards(id,campaign_id,member_id,cycle_date) VALUES('w-juan','c1','m-juan','2027-08-02')",args:[]},
  ...(awarded?[{sql:"INSERT INTO awards(id,campaign_id,member_id,cycle_date) VALUES('w-fran','c1','m-fran','2027-07-12')",args:[]}]:[]),
  ...(linked?[{sql:"INSERT INTO controller_accounts(person_id,principal_key) VALUES('p-fran','chatgpt-email:fran@example.test')",args:[]}]:[]),
  {sql:'INSERT INTO push_subscriptions(endpoint,owner_key,p256dh,auth,created_at) VALUES(?,?,?,?,?)',args:[endpoint,'chatgpt-email:fran@example.test','k','a',recent]},
 ]);
 return repo;
}

test('una elección automática reciente avisa solo a quien su lista eligió',async()=>{
 const repo=await fixture();
 await enqueueAutomaticChoices(repo,'c1',now);
 const rows=await repo.all('SELECT id,owner_key,member_id,round,push_status FROM turn_notifications');
 assert.deepEqual(rows.map(r=>({...r})),[{id:'auto:a-auto:m-fran:2027-07-12',owner_key:'chatgpt-email:fran@example.test',member_id:'m-fran',round:1,push_status:'pending'}]);
 await enqueueAutomaticChoices(repo,'c1',now);
 assert.equal((await repo.all('SELECT id FROM turn_notifications')).length,1);
});

test('no avisa de elecciones deshechas, sin cuenta vinculada, antiguas ni simuladas',async()=>{
 for(const options of [{awarded:false},{linked:false},{at:new Date(now-7*3600_000).toISOString()},{scope:'sim:prueba'}]){
  const repo=await fixture(options);
  await enqueueAutomaticChoices(repo,'c1',now);
  assert.deepEqual(await repo.all('SELECT id FROM turn_notifications'),[],JSON.stringify(options));
 }
});

test('el aviso dice qué ha elegido la lista y abre su equipo y año, aunque la elección haya terminado',async()=>{
 const repo=await fixture({status:'completed'});
 const sent:any[]=[];
 await dispatchNotifications(repo,config,undefined,async(_c,sub,payload)=>{sent.push({endpoint:sub.endpoint,...payload as object});return new Response(null,{status:201});},now);
 assert.equal(sent.length,1);
 assert.equal(sent[0].endpoint,endpoint);
 assert.equal(sent[0].title,'Vacaciones · Tu lista ha elegido por ti');
 assert.match(sent[0].body,/12 jul/);
 assert.match(sent[0].body,/ronda 1/);
 assert.equal(sent[0].url,'/?equipo=B&year=2027');
 assert.deepEqual((await repo.all("SELECT push_status FROM turn_notifications")).map(r=>({...r})),[{push_status:'sent'}]);
});
