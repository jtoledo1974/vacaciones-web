import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SQLiteRepo} from './sqlite-repo.ts';
import {notificationSettings,sendTestPush} from '../server/notifications.ts';
import type {Principal} from '../server/permissions.ts';

const superadmin:Principal={id:'chatgpt:admin',emailKey:'chatgpt-email:admin@example.test',role:'superadmin',teams:[]};
const controller:Principal={id:'chatgpt:controller',role:'viewer',teams:[]};
const teamAdmin:Principal={id:'chatgpt:teamadmin',role:'team_admin',teams:['B']};
const config={VAPID_PUBLIC_KEY:'test-public',VAPID_PRIVATE_JWK:'test-private',VAPID_SUBJECT:'mailto:admin@example.test'};
const myEndpoint='https://push.example.test/my-device';
const otherEndpoint='https://push.example.test/other-device';

async function fixture(){
 const repo=new SQLiteRepo();
 await repo.batch([
  {sql:'INSERT INTO push_subscriptions(endpoint,owner_key,p256dh,auth,created_at) VALUES(?,?,?,?,?)',args:[myEndpoint,superadmin.emailKey,'test-key','test-auth',new Date().toISOString()]},
  {sql:'INSERT INTO push_subscriptions(endpoint,owner_key,p256dh,auth,created_at) VALUES(?,?,?,?,?)',args:[otherEndpoint,controller.id,'other-key','other-auth',new Date().toISOString()]},
 ]);
 return repo;
}

test('diagnóstico Push visible solo a superadmin y dirigido a su propio dispositivo',async()=>{
 const repo=await fixture();
 const adminSettings=await notificationSettings(repo,superadmin,config);
 assert.equal(adminSettings.canTest,true);
 assert.deepEqual(adminSettings.subscriptions.map((s:any)=>s.endpoint),[myEndpoint]);
 assert.equal((await notificationSettings(repo,controller,config)).canTest,false);
 let sent=0;
 const result=await sendTestPush(repo,superadmin,myEndpoint,config,async (_config,subscription,payload)=>{
  sent++;
  assert.equal(subscription.endpoint,myEndpoint);
  assert.deepEqual(Object.keys(payload as object).sort(),['body','tag','title','url']);
  assert.equal((payload as {url:string}).url,'/notificaciones');
  return new Response(null,{status:201});
 });
 assert.deepEqual(result,{accepted:true});
 assert.equal(sent,1);
 assert.deepEqual(await repo.all('SELECT * FROM turn_notifications'),[]);
 assert.deepEqual(await repo.all('SELECT * FROM push_deliveries'),[]);
});

test('diagnóstico Push rechaza roles inferiores y dispositivos ajenos',async()=>{
 const repo=await fixture();
 let sent=0;
 const sender=async()=>{sent++;return new Response(null,{status:201});};
 await assert.rejects(sendTestPush(repo,controller,otherEndpoint,config,sender),/superadministrador/);
 await assert.rejects(sendTestPush(repo,teamAdmin,myEndpoint,config,sender),/superadministrador/);
 await assert.rejects(sendTestPush(repo,superadmin,otherEndpoint,config,sender),/no está registrado/);
 await assert.rejects(sendTestPush(repo,superadmin,'http://push.example.test/invalid',config,sender),/dispositivo registrado/);
 await assert.rejects(sendTestPush(repo,superadmin,myEndpoint,{},sender),/no configuradas/);
 assert.equal(sent,0);
});

test('diagnóstico Push informa si proveedor rechaza una suscripción caducada',async()=>{
 const repo=await fixture();
 await assert.rejects(sendTestPush(repo,superadmin,myEndpoint,config,async()=>new Response(null,{status:410})),/caducado/);
 assert.equal((await repo.all('SELECT endpoint FROM push_subscriptions')).length,2);
});
