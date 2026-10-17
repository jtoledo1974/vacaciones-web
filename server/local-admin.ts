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
const MAX_FAILURES=5;
const encoder=new TextEncoder();

export function localAdminEnabled(config:LocalAdminConfig):boolean{
 return typeof config.LOCAL_ADMIN_USERNAME==='string'
  &&/^[a-zA-Z0-9._@-]{3,100}$/.test(config.LOCAL_ADMIN_USERNAME)
  &&typeof config.LOCAL_ADMIN_PASSWORD==='string'
  &&config.LOCAL_ADMIN_PASSWORD.length>=20&&config.LOCAL_ADMIN_PASSWORD.length<=512
  &&typeof config.LOCAL_ADMIN_SESSION_SECRET==='string'
  &&config.LOCAL_ADMIN_SESSION_SECRET.length>=32;
}

function response(value:object,status=200,cookie?:string):Response{
 return Response.json(value,{status,headers:{
  'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
  ...(cookie?{'Set-Cookie':cookie}:{})
 }});
}
function b64url(bytes:Uint8Array):string{
 let binary='';for(const b of bytes)binary+=String.fromCharCode(b);
 return btoa(binary).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function unb64url(value:string):Uint8Array<ArrayBuffer>|null{
 if(!/^[A-Za-z0-9_-]{43}$/.test(value))return null;
 try{
  const binary=atob(value.replace(/-/g,'+').replace(/_/g,'/')+'=');
  return Uint8Array.from(binary,c=>c.charCodeAt(0));
 }catch{return null;}
}
async function hmacKey(secret:string):Promise<CryptoKey>{
 return crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);
}
function payload(config:LocalAdminConfig,expires:number):Uint8Array<ArrayBuffer>{
 return encoder.encode('vacaciones-local-admin:v1:'+config.LOCAL_ADMIN_USERNAME+':'+expires);
}
function cookieValue(value:string,maxAge:number):string{
 return COOKIE+'='+value+'; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age='+maxAge;
}
async function createCookie(config:LocalAdminConfig):Promise<string>{
 const expires=Math.floor(Date.now()/1000)+SESSION_SECONDS;
 const signature=new Uint8Array(await crypto.subtle.sign('HMAC',await hmacKey(config.LOCAL_ADMIN_SESSION_SECRET!),payload(config,expires)));
 return cookieValue('v1.'+expires+'.'+b64url(signature),SESSION_SECONDS);
}

/** A signed, short-lived, HttpOnly session; no password is stored in the cookie or in D1. */
export async function localAdminIdentity(request:Request,config:LocalAdminConfig):Promise<Identity>{
 if(!localAdminEnabled(config))return null;
 const match=request.headers.get('cookie')?.split(';').map(p=>p.trim()).find(p=>p.startsWith(COOKIE+'='));
 if(!match)return null;
 const token=match.slice(COOKIE.length+1);
 const parts=/^v1\.(\d{10})\.([A-Za-z0-9_-]{43})$/.exec(token);
 if(!parts)return null;
 const expires=Number(parts[1]),now=Math.floor(Date.now()/1000);
 if(expires<=now||expires>now+SESSION_SECONDS)return null;
 const signature=unb64url(parts[2]);
 if(!signature)return null;
 try{
  const valid=await crypto.subtle.verify('HMAC',await hmacKey(config.LOCAL_ADMIN_SESSION_SECRET!),signature,payload(config,expires));
  return valid?{provider:'local_admin',subject:config.LOCAL_ADMIN_USERNAME!,email:'',emailVerified:false}:null;
 }catch{return null;}
}
async function constantTimePasswordMatch(input:string,expected:string):Promise<boolean>{
 const [a,b]=await Promise.all([crypto.subtle.digest('SHA-256',encoder.encode(input)),crypto.subtle.digest('SHA-256',encoder.encode(expected))]);
 const one=new Uint8Array(a),two=new Uint8Array(b);
 let different=0;
 for(let i=0;i<one.length;i++)different|=one[i]^two[i];
 return different===0;
}
function validOrigin(request:Request):boolean{
 return request.headers.get('origin')===new URL(request.url).origin;
}
async function attemptKey(request:Request,secret:string):Promise<string>{
 // Cloudflare supplies CF-Connecting-IP on the deployment; never persist the raw address.
 const ip=request.headers.get('cf-connecting-ip')??'no-cloudflare-ip';
 const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(secret+':'+ip)));
 return 'local-login:'+b64url(digest).slice(0,32);
}

/** Optional break-glass superadmin: credentials are private deployment secrets, not repo defaults. */
export async function localAdminLogin(request:Request,config:LocalAdminConfig,repo:Repository):Promise<Response>{
 if(!localAdminEnabled(config))return response({error:'Acceso local desactivado'},404);
 if(!validOrigin(request))return response({error:'Origen no válido'},403);
 if(!request.headers.get('content-type')?.startsWith('application/json'))return response({error:'Se requiere JSON'},415);
 const input=await request.text();
 if(input.length>2048)return response({error:'Solicitud demasiado grande'},413);
 let username:unknown,password:unknown;
 try{({username,password}=JSON.parse(input));}catch{return response({error:'JSON no válido'},400);}
 if(typeof username!=='string'||username.length>100||typeof password!=='string'||password.length>512){
  return response({error:'Credenciales no válidas'},401);
 }
 const actor=await attemptKey(request,config.LOCAL_ADMIN_SESSION_SECRET!);
 const cutoff=new Date(Date.now()-WINDOW_SECONDS*1000).toISOString();
 const attempts=await repo.all<{count:number}>(
  "SELECT COUNT(*) AS count FROM audit WHERE actor=? AND action='local_admin_login_failed' AND created_at>=?",
  [actor,cutoff]
 );
 if(Number(attempts[0]?.count??0)>=MAX_FAILURES)return response({error:'Demasiados intentos. Espera 15 minutos.'},429);
 const passwordMatches=await constantTimePasswordMatch(password,config.LOCAL_ADMIN_PASSWORD!);
 const userMatches=username===config.LOCAL_ADMIN_USERNAME;
 if(!passwordMatches||!userMatches){
  await repo.batch([{sql:'INSERT INTO audit(id,actor,action,created_at,after_json) VALUES(?,?,?,?,?)',
   args:[crypto.randomUUID(),actor,'local_admin_login_failed',new Date().toISOString(),'{}']}]);
  return response({error:'Credenciales no válidas'},401);
 }
 return response({ok:true},200,await createCookie(config));
}
export function localAdminLogout(request:Request):Response{
 if(!validOrigin(request))return response({error:'Origen no válido'},403);
 return response({ok:true},200,cookieValue('',0));
}
