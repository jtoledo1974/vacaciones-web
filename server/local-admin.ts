import type {Identity} from './permissions.ts';
import type {Repository} from './repository.ts';

export interface LocalAdminConfig {
 LOCAL_ADMIN_USERNAME?:string;
 LOCAL_ADMIN_PASSWORD?:string;
 LOCAL_ADMIN_SESSION_SECRET?:string;
}
const COOKIE='__Host-vacaciones-local-admin';
const SESSION_SECONDS=8*60*60;
const WINDOW_SECONDS=15*60;
const MAX_ATTEMPTS=5;
const encoder=new TextEncoder();
export function localAdminEnabled(config:LocalAdminConfig):boolean{
 return typeof config.LOCAL_ADMIN_USERNAME==='string'
  &&/^[a-zA-Z0-9._@-]{3,100}$/.test(config.LOCAL_ADMIN_USERNAME)
  &&typeof config.LOCAL_ADMIN_PASSWORD==='string'
  &&config.LOCAL_ADMIN_PASSWORD.length>=24&&config.LOCAL_ADMIN_PASSWORD.length<=512
  &&typeof config.LOCAL_ADMIN_SESSION_SECRET==='string'
  &&config.LOCAL_ADMIN_SESSION_SECRET.length>=32
  &&config.LOCAL_ADMIN_SESSION_SECRET!==config.LOCAL_ADMIN_PASSWORD;
}
function response(value:object,status=200,cookie?:string):Response{
 return Response.json(value,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
 ...(status===429?{'Retry-After':String(WINDOW_SECONDS)}:{}),...(cookie?{'Set-Cookie':cookie}:{})}});
}
function b64url(bytes:Uint8Array):string{
 let binary='';for(const b of bytes)binary+=String.fromCharCode(b);
 return btoa(binary).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
async function hmacKey(secret:string):Promise<CryptoKey>{
 return crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);
}
async function payload(config:LocalAdminConfig,expires:number,nonce:string):Promise<Uint8Array<ArrayBuffer>>{
 // Password rotation revokes existing sessions as well as signing-key rotation.
 const fingerprint=b64url(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(config.LOCAL_ADMIN_PASSWORD!))));
 return encoder.encode('vacaciones-local-admin:v2:'+config.LOCAL_ADMIN_USERNAME+':'+fingerprint+':'+expires+':'+nonce);
}
function cookieValue(value:string,maxAge:number):string{
 return COOKIE+'='+value+'; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age='+maxAge;
}
function tokenParts(request:Request):RegExpExecArray|null{
 const cookies=request.headers.get('cookie')?.split(';').map(p=>p.trim()).filter(p=>p.startsWith(COOKIE+'='))??[];
 if(cookies.length!==1)return null;
 return /^v2\.(\d{10})\.([a-f0-9-]{36})\.([A-Za-z0-9_-]{43})$/.exec(cookies[0].slice(COOKIE.length+1));
}
/** Verify signature, expiry, credential rotation and server-side session revocation. */
export async function localAdminIdentity(request:Request,config:LocalAdminConfig,repo:Repository):Promise<Identity>{
 if(!localAdminEnabled(config))return null;
 const parts=tokenParts(request);if(!parts)return null;
 const expires=Number(parts[1]),now=Math.floor(Date.now()/1000);
 if(expires<=now||expires>now+SESSION_SECONDS)return null;
 try{
  const signature=Uint8Array.from(atob(parts[3].replace(/-/g,'+').replace(/_/g,'/')+'='),c=>c.charCodeAt(0));
  const valid=await crypto.subtle.verify('HMAC',await hmacKey(config.LOCAL_ADMIN_SESSION_SECRET!),signature,await payload(config,expires,parts[2]));
  if(!valid)return null;
  const sessions=await repo.all('SELECT id FROM local_admin_sessions WHERE id=? AND actor=? AND expires_at=? AND revoked_at IS NULL',[parts[2],'local_admin:'+config.LOCAL_ADMIN_USERNAME,expires]);
  return sessions.length===1?{provider:'local_admin',subject:config.LOCAL_ADMIN_USERNAME!,email:'',emailVerified:false}:null;
 }catch{return null;}
}
async function passwordMatch(input:string,expected:string):Promise<boolean>{
 const hashes=await Promise.all([input,expected].map(s=>crypto.subtle.digest('SHA-256',encoder.encode(s))));
 const a=new Uint8Array(hashes[0]),b=new Uint8Array(hashes[1]);let different=0;
 for(let i=0;i<a.length;i++)different|=a[i]^b[i];return different===0;
}
function validOrigin(request:Request):boolean{
 return request.method==='POST'&&request.headers.get('origin')===new URL(request.url).origin;
}
async function attemptKey(request:Request,secret:string):Promise<string>{
 const ip=request.headers.get('cf-connecting-ip')??'no-cloudflare-ip';
 return 'local-login:'+b64url(new Uint8Array(await crypto.subtle.sign('HMAC',await hmacKey(secret),encoder.encode(ip))));
}
/** Session start and end are the only local admin events in audit: no token, IP or credential. */
function auditEvent(action:'local_admin_login'|'local_admin_logout',actor:string,at:string){
 return {sql:"INSERT INTO audit(id,actor,action,created_at,after_json) VALUES(?,?,?,?,'{}')",args:[crypto.randomUUID(),actor,action,at]};
}
async function boundedText(request:Request):Promise<string|null>{
 const reader=request.body?.getReader();if(!reader)return '';
 const chunks:Uint8Array[]=[];let size=0;
 try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;
 if(size>2048){await reader.cancel();return null;}chunks.push(value);}}
 finally{reader.releaseLock();}
 const result=new Uint8Array(size);let offset=0;for(const c of chunks){result.set(c,offset);offset+=c.length;}
 return new TextDecoder().decode(result);
}
/** Reserve each attempt atomically before checking credentials, including concurrent requests. */
export async function localAdminLogin(request:Request,config:LocalAdminConfig,repo:Repository):Promise<Response>{
 if(!localAdminEnabled(config))return response({error:'Acceso local desactivado'},404);
 if(!validOrigin(request))return response({error:'Origen no válido'},403);
 if(request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json')return response({error:'Se requiere JSON'},415);
 const input=await boundedText(request);if(input===null)return response({error:'Solicitud demasiado grande'},413);
 let body:unknown;try{body=JSON.parse(input);}catch{return response({error:'JSON no válido'},400);}
 if(!body||typeof body!=='object'||Array.isArray(body))return response({error:'Credenciales no válidas'},401);
 const {username,password}=body as Record<string,unknown>;
 const key=await attemptKey(request,config.LOCAL_ADMIN_SESSION_SECRET!);
 const cutoff=new Date(Date.now()-WINDOW_SECONDS*1000).toISOString();
 const reservation=await repo.batch([
  {sql:'DELETE FROM local_admin_attempts WHERE created_at<?',args:[cutoff]},
  {sql:'INSERT INTO local_admin_attempts(id,attempt_key,created_at) SELECT ?,?,? WHERE (SELECT COUNT(*) FROM local_admin_attempts WHERE attempt_key=? AND created_at>=?)<? RETURNING id',args:[crypto.randomUUID(),key,new Date().toISOString(),key,cutoff,MAX_ATTEMPTS]}]);
 if(!reservation[1].results.length)return response({error:'Demasiados intentos. Espera 15 minutos.'},429);
 if(typeof username!=='string'||username.length>100||typeof password!=='string'||password.length>512)return response({error:'Credenciales no válidas'},401);
 const matches=await passwordMatch(password,config.LOCAL_ADMIN_PASSWORD!);
 if(!matches||username!==config.LOCAL_ADMIN_USERNAME)return response({error:'Credenciales no válidas'},401);
 const expires=Math.floor(Date.now()/1000)+SESSION_SECONDS,nonce=crypto.randomUUID();
 const signature=new Uint8Array(await crypto.subtle.sign('HMAC',await hmacKey(config.LOCAL_ADMIN_SESSION_SECRET!),await payload(config,expires,nonce)));
 const actor='local_admin:'+config.LOCAL_ADMIN_USERNAME,at=new Date().toISOString();
 await repo.batch([{sql:'INSERT INTO local_admin_sessions(id,actor,created_at,expires_at) VALUES(?,?,?,?)',args:[nonce,actor,at,expires]},auditEvent('local_admin_login',actor,at)]);
 return response({ok:true},200,cookieValue('v2.'+expires+'.'+nonce+'.'+b64url(signature),SESSION_SECONDS));
}
export async function localAdminLogout(request:Request,config:LocalAdminConfig,repo:Repository):Promise<Response>{
 if(!validOrigin(request))return response({error:'Origen no válido'},403);
 if(await localAdminIdentity(request,config,repo)){
  const at=new Date().toISOString();
  await repo.batch([{sql:'UPDATE local_admin_sessions SET revoked_at=? WHERE id=? AND revoked_at IS NULL',args:[at,tokenParts(request)![2]]},auditEvent('local_admin_logout','local_admin:'+config.LOCAL_ADMIN_USERNAME,at)]);
 }
 return response({ok:true},200,cookieValue('',0));
}
