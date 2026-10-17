import {test} from 'node:test';
import assert from 'node:assert/strict';
import {localAdminEnabled,localAdminIdentity,localAdminLogin,localAdminLogout,type LocalAdminConfig} from '../server/local-admin.ts';
import {principal} from '../server/service.ts';
import {SQLiteRepo} from './sqlite-repo.ts';

const config:LocalAdminConfig={
 LOCAL_ADMIN_USERNAME:'qa-superadmin',
 LOCAL_ADMIN_PASSWORD:'A-long-independent-demo-passphrase-53',
 LOCAL_ADMIN_SESSION_SECRET:'local-test-session-key-with-at-least-32-characters'
};
const url='https://vacaciones.example.test/api/local-admin/login';
function loginRequest(username:string,password:string,ip='203.0.113.10'):Request{
 return new Request(url,{method:'POST',headers:{
  'Origin':'https://vacaciones.example.test','Content-Type':'application/json',
  'CF-Connecting-IP':ip
 },body:JSON.stringify({username,password})});
}
test('local password bootstrap is disabled unless all strong deployment secrets are present',()=>{
 assert.equal(localAdminEnabled({}),false);
 assert.equal(localAdminEnabled({...config,LOCAL_ADMIN_PASSWORD:'short'}),false);
 assert.equal(localAdminEnabled({...config,LOCAL_ADMIN_SESSION_SECRET:'short'}),false);
 assert.equal(localAdminEnabled(config),true);
});
test('local password login returns a signed HttpOnly session with superadmin permissions',async()=>{
 const repo=new SQLiteRepo();
 const login=await localAdminLogin(loginRequest('qa-superadmin',config.LOCAL_ADMIN_PASSWORD!),config,repo);
 assert.equal(login.status,200);
 const header=login.headers.get('set-cookie')??'';
 assert.match(header,/^__Host-vacaciones-local-admin=v1\./);
 for(const attribute of ['Secure','HttpOnly','SameSite=Strict','Path=/'])assert.ok(header.includes(attribute));
 assert.ok(!header.includes(config.LOCAL_ADMIN_PASSWORD!));
 const cookie=header.split(';')[0];
 const request=new Request('https://vacaciones.example.test/api/session',{headers:{Cookie:cookie}});
 const identity=await localAdminIdentity(request,config);
 assert.deepEqual(identity,{provider:'local_admin',subject:'qa-superadmin',email:'',emailVerified:false});
 const role=await principal(repo,identity,'');
 assert.equal(role.role,'superadmin');
 assert.equal(role.id,'local_admin:qa-superadmin');
 assert.equal(await localAdminIdentity(request,{...config,LOCAL_ADMIN_SESSION_SECRET:'different-signing-secret-with-more-than-32-characters'}),null);
 const forged=new Request('https://vacaciones.example.test/api/session',{headers:{Cookie:cookie.replace('v1.','v1.9')}});
 assert.equal(await localAdminIdentity(forged,config),null);
 const signedPart=cookie.split('.');
 const tampered=new Request('https://vacaciones.example.test/api/session',{headers:{Cookie:[signedPart[0],signedPart[1],'A'+signedPart[2].slice(1)].join('.')}});
 assert.equal(await localAdminIdentity(tampered,config),null);
 const logout=localAdminLogout(new Request(url,{method:'POST',headers:{Origin:'https://vacaciones.example.test'}}));
 assert.equal(logout.status,200);
 assert.match(logout.headers.get('set-cookie')??'',/Max-Age=0/);
});
test('local password login enforces origin, valid JSON, invalid credentials and per-IP throttling',async()=>{
 const repo=new SQLiteRepo();
 assert.equal((await localAdminLogin(new Request(url,{method:'POST',headers:{Origin:'https://outside.invalid','Content-Type':'application/json'},body:'{}'}),config,repo)).status,403);
 assert.equal((await localAdminLogin(loginRequest('wrong',config.LOCAL_ADMIN_PASSWORD!),{},repo)).status,404);
 for(let i=0;i<5;i++){
  const response=await localAdminLogin(loginRequest('qa-superadmin','wrong password'),config,repo);
  assert.equal(response.status,401);
  assert.equal(response.headers.get('set-cookie'),null);
 }
 assert.equal((await localAdminLogin(loginRequest('qa-superadmin',config.LOCAL_ADMIN_PASSWORD!),config,repo)).status,429);
 assert.equal((await localAdminLogin(loginRequest('qa-superadmin',config.LOCAL_ADMIN_PASSWORD!,'203.0.113.11'),config,repo)).status,200);
 const logs=await repo.all<{actor:string;action:string;after_json:string}>("SELECT actor,action,after_json FROM audit WHERE action='local_admin_login_failed'");
 assert.equal(logs.length,5);
 assert.ok(logs.every(x=>!x.actor.includes('203.0.113.10')&&!x.after_json.includes('password')));
});
