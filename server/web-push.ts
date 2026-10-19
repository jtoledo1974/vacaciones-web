/** RFC 8291 aes128gcm Web Push encryption + RFC 8292 VAPID for Cloudflare WebCrypto. */
function decode(v:string):Uint8Array<ArrayBuffer>{const s=atob(v.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-v.length%4)%4));return Uint8Array.from(s,c=>c.charCodeAt(0));}
function encode(v:Uint8Array):string{return btoa(String.fromCharCode(...v)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');}
function bytes(v:ArrayBuffer|Uint8Array):Uint8Array<ArrayBuffer>{return new Uint8Array(v instanceof Uint8Array?v:new Uint8Array(v));}
function join(...parts:Uint8Array[]):Uint8Array<ArrayBuffer>{const out=new Uint8Array(parts.reduce((n,a)=>n+a.length,0));let at=0;for(const p of parts){out.set(p,at);at+=p.length;}return out;}
const utf=(s:string)=>new TextEncoder().encode(s);
// WebCrypto expects an ArrayBuffer, not a typed array backed by ArrayBufferLike.
// Copying the short cryptographic fields avoids unsafe BufferSource casts.
function buffer(v:Uint8Array):ArrayBuffer{const copy=new Uint8Array(v.byteLength);copy.set(v);return copy.buffer;}
async function hkdf(ikm:Uint8Array,salt:Uint8Array,info:Uint8Array,length:number):Promise<Uint8Array<ArrayBuffer>>{
 const key=await crypto.subtle.importKey('raw',buffer(ikm),'HKDF',false,['deriveBits']);
 return bytes(await crypto.subtle.deriveBits({name:'HKDF',hash:'SHA-256',salt:buffer(salt),info:buffer(info)},key,length*8));
}
export type PushConfig={VAPID_PRIVATE_JWK?:string;VAPID_PUBLIC_KEY?:string;VAPID_SUBJECT?:string};
export function publicPushKey(config:PushConfig){return config.VAPID_PRIVATE_JWK&&config.VAPID_SUBJECT&&config.VAPID_PUBLIC_KEY?config.VAPID_PUBLIC_KEY:null;}
export async function deliverPush(config:PushConfig,subscription:{endpoint:string;p256dh:string;auth:string},data:unknown):Promise<Response>{
 const publicKey=publicPushKey(config);if(!publicKey)throw new Error('VAPID not configured');
 const url=new URL(subscription.endpoint);
 if(url.protocol!=='https:')throw new Error('Invalid push endpoint');
 const origin=url.origin,issued=Math.floor(Date.now()/1000);
 const header=encode(utf(JSON.stringify({typ:'JWT',alg:'ES256'})));
 const payload=encode(utf(JSON.stringify({aud:origin,exp:issued+3600,sub:config.VAPID_SUBJECT})));
 const privateKey=await crypto.subtle.importKey('jwk',JSON.parse(config.VAPID_PRIVATE_JWK!),{name:'ECDSA',namedCurve:'P-256'},false,['sign']);
 const sig=bytes(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},privateKey,buffer(utf(header+'.'+payload))));
 const token=header+'.'+payload+'.'+encode(sig);
 const pair=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
 const serverPublic=bytes(await crypto.subtle.exportKey('raw',pair.publicKey));
 const clientPublic=decode(subscription.p256dh),auth=decode(subscription.auth);
 if(clientPublic.length!==65||auth.length!==16)throw new Error('Invalid subscription keys');
 const clientKey=await crypto.subtle.importKey('raw',buffer(clientPublic),{name:'ECDH',namedCurve:'P-256'},false,[]);
 const secret=bytes(await crypto.subtle.deriveBits({name:'ECDH',public:clientKey},pair.privateKey,256));
 const ikm=await hkdf(secret,auth,join(utf('WebPush: info\0'),clientPublic,serverPublic),32);
 const salt=crypto.getRandomValues(new Uint8Array(16));
 const cek=await hkdf(ikm,salt,utf('Content-Encoding: aes128gcm\0'),16);
 const nonce=await hkdf(ikm,salt,utf('Content-Encoding: nonce\0'),12);
 const key=await crypto.subtle.importKey('raw',buffer(cek),'AES-GCM',false,['encrypt']);
 const content=join(utf(JSON.stringify(data)),new Uint8Array([2]));
 const encrypted=bytes(await crypto.subtle.encrypt({name:'AES-GCM',iv:buffer(nonce)},key,buffer(content)));
 const record=join(salt,new Uint8Array([0,0,16,0,65]),serverPublic,encrypted);
 return fetch(subscription.endpoint,{method:'POST',headers:{'Authorization':'vapid t='+token+', k='+publicKey,'Content-Encoding':'aes128gcm','Content-Type':'application/octet-stream','TTL':'3600','Urgency':'high'},body:buffer(record)});
}
