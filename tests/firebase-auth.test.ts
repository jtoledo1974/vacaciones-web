import {test} from 'node:test';
import assert from 'node:assert/strict';
import {verifyFirebaseIdToken} from '../server/firebase-auth.ts';
import {principal,Service} from '../server/service.ts';
import {SQLiteRepo} from './sqlite-repo.ts';

function base64url(bytes:Uint8Array):string{
 return Buffer.from(bytes).toString('base64url');
}
function jsonPart(value:object){return base64url(new TextEncoder().encode(JSON.stringify(value)));}
let kidSequence=0;
async function fixture(overrides:Record<string,unknown>={}){
 const kid="test-kid-"+(++kidSequence);
 const keyPair=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
 const jwk=await crypto.subtle.exportKey('jwk',keyPair.publicKey);
 const now=Math.floor(Date.now()/1000),header={alg:'RS256',kid,typ:'JWT'};
 const claims={aud:'cambios-76578',iss:'https://securetoken.google.com/cambios-76578',sub:'stable-firebase-uid-1',
  email:'controller@example.test',email_verified:true,iat:now-10,auth_time:now-20,exp:now+600,...overrides};
 const data=jsonPart(header)+'.'+jsonPart(claims);
 const sig=new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',keyPair.privateKey,new TextEncoder().encode(data)));
 const fakeFetch=(async()=>new Response(JSON.stringify({keys:[{...jwk,kid}]}),{headers:{'Cache-Control':'max-age=60'}})) as typeof fetch;
 return {token:data+'.'+base64url(sig),fakeFetch};
}

test('Firebase ID token: issuer, audience, signature, timestamps and verified email',async()=>{
 const f=await fixture();
 const identity=await verifyFirebaseIdToken(f.token,'cambios-76578',f.fakeFetch);
 assert.deepEqual(identity,{provider:'firebase',subject:'stable-firebase-uid-1',email:'controller@example.test',emailVerified:true});
 await assert.rejects(verifyFirebaseIdToken(f.token,'wrong-project',f.fakeFetch),/Identidad/);
 const [h,p,s]=f.token.split('.');
 const altered=p.slice(0,-2)+(p.slice(-2)==='aa'?'bb':'aa');
 await assert.rejects(verifyFirebaseIdToken(h+'.'+altered+'.'+s,'cambios-76578',f.fakeFetch));
 for(const wrong of [{exp:0},{iat:Math.floor(Date.now()/1000)+60},{iss:'https://evil.invalid'},{auth_time:Math.floor(Date.now()/1000)+30}]){
  const token=await fixture(wrong);
  await assert.rejects(verifyFirebaseIdToken(token.token,'cambios-76578',token.fakeFetch),/Identidad/);
 }
 const unverified=await fixture({email_verified:false});
 assert.equal((await verifyFirebaseIdToken(unverified.token,'cambios-76578',unverified.fakeFetch)).emailVerified,false);
});
test('Firebase UID has independent role and controller binding, without auto-link by email',async()=>{
 const repo=new SQLiteRepo(),owner=new Service(repo,{id:'chatgpt:owner',role:'superadmin',teams:[]});
 await owner.init();
 const fb={provider:'firebase',subject:'stable-firebase-uid-1',email:'controller@example.test',emailVerified:true};
 assert.equal((await principal(repo,fb,'')).role,'viewer');
 await owner.configureUser({provider:'firebase',subject:fb.subject,role:'team_admin',teams:['C'],version:0});
 const p=await principal(repo,fb,'');
 assert.equal(p.id,'firebase:'+fb.subject);assert.equal(p.role,'team_admin');
 assert.deepEqual(p.teams,['C']);
 const sites=await principal(repo,{provider:'chatgpt',subject:fb.subject,email:fb.email},'');
 assert.equal(sites.role,'viewer');
 assert.equal((await principal(repo,{...fb,emailVerified:false},fb.email)).role,'team_admin');
});
