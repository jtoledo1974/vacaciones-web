import type {Identity} from './permissions.ts';

const GOOGLE_JWKS='https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
type Header={alg?:string;kid?:string;typ?:string};
type Claims={aud?:string;iss?:string;sub?:string;email?:string;email_verified?:boolean;exp?:number;iat?:number;auth_time?:number;user_id?:string};
type Keys={keys:Array<JsonWebKey & {kid?:string;alg?:string;use?:string}>};
const MAX_TOKEN_LENGTH=12000;
let cachedKeys:Keys|null=null;
let cachedUntil=0;

function decodePart<T>(part:string):T{
 if(!/^[A-Za-z0-9_-]+$/.test(part)||part.length>MAX_TOKEN_LENGTH)throw new Error('JWT mal formado');
 const text=atob(part.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-part.length%4)%4));
 return JSON.parse(new TextDecoder().decode(Uint8Array.from(text,c=>c.charCodeAt(0)))) as T;
}
function signatureBytes(part:string):Uint8Array<ArrayBuffer>{
 if(!/^[A-Za-z0-9_-]+$/.test(part))throw new Error('Firma JWT inválida');
 const text=atob(part.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-part.length%4)%4));
 return Uint8Array.from(text,c=>c.charCodeAt(0));
}
async function keys(fetcher:typeof fetch,force=false):Promise<Keys>{
 const now=Date.now();
 if(!force&&cachedKeys&&cachedUntil>now)return cachedKeys;
 const response=await fetcher(GOOGLE_JWKS,{headers:{'Accept':'application/json'}});
 if(!response.ok)throw new Error('No se pudo verificar la clave pública de Firebase');
 const value=await response.json() as Keys;
 if(!Array.isArray(value?.keys)||value.keys.length>100)throw new Error('Claves públicas Firebase inválidas');
 const maxAge=Number(/max-age=(\d+)/i.exec(response.headers.get('cache-control')??'')?.[1]??'300');
 cachedKeys=value;
 cachedUntil=now+Math.min(3600,Math.max(60,Number.isFinite(maxAge)?maxAge:300))*1000;
 return value;
}

/** Validate Firebase ID tokens using Google's published RSA keys, without service-account credentials. */
export async function verifyFirebaseIdToken(token:string,projectId:string,fetcher:typeof fetch=fetch):Promise<NonNullable<Identity>>{
 if(!projectId||!token||token.length>MAX_TOKEN_LENGTH)throw new Error('Identidad Firebase no válida');
 const parts=token.split('.');
 if(parts.length!==3)throw new Error('JWT mal formado');
 const header=decodePart<Header>(parts[0]),claims=decodePart<Claims>(parts[1]);
 const now=Math.floor(Date.now()/1000);
 if(header.alg!=='RS256'||typeof header.kid!=='string'||!header.kid||header.kid.length>200
  ||claims.aud!==projectId||claims.iss!=='https://securetoken.google.com/'+projectId
  ||typeof claims.sub!=='string'||!claims.sub||claims.sub.length>128
  ||typeof claims.exp!=='number'||claims.exp<=now
  ||typeof claims.iat!=='number'||claims.iat>now||claims.iat<0
  ||typeof claims.auth_time!=='number'||claims.auth_time>now||claims.auth_time<0
  ||(claims.email!==undefined&&(typeof claims.email!=='string'||claims.email.length>320))){
  throw new Error('Identidad Firebase no válida');
 }
 let jwks=await keys(fetcher);
 let jwk=jwks.keys.find(k=>k.kid===header.kid&&k.kty==='RSA');
 if(!jwk){jwks=await keys(fetcher,true);jwk=jwks.keys.find(k=>k.kid===header.kid&&k.kty==='RSA');}
 if(!jwk)throw new Error('Clave Firebase no reconocida');
 const key=await crypto.subtle.importKey('jwk',jwk,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['verify']);
 const valid=await crypto.subtle.verify('RSASSA-PKCS1-v1_5',key,signatureBytes(parts[2]),new TextEncoder().encode(parts[0]+'.'+parts[1]));
 if(!valid)throw new Error('Firma Firebase inválida');
 return {provider:'firebase',subject:claims.sub,email:claims.email??'',emailVerified:claims.email_verified===true};
}
