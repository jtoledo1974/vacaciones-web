import {getChatGPTUser} from '../app/chatgpt-auth';
import type {Identity} from './permissions';
import {verifyFirebaseIdToken} from './firebase-auth';

export interface Authenticator {
 authenticate(request:Request):Promise<Identity>;
}

export const sitesAuthenticator:Authenticator={
 async authenticate(_request){
  const user=await getChatGPTUser();
  return user?{provider:'chatgpt',subject:user.userId,email:user.email,emailVerified:true}:null;
 }
};

/** A valid Firebase bearer ID token takes precedence; absent it, Sites remains available. */
export function federatedAuthenticator(firebaseProjectId:string):Authenticator{
 return {
  async authenticate(request){
   const authorization=request.headers.get('authorization');
   if(authorization!==null){
    const token=/^Bearer ([A-Za-z0-9._-]+)$/.exec(authorization)?.[1];
    if(!firebaseProjectId||!token)throw Object.assign(new Error('Token de Firebase no autorizado'),{status:401});
    try{return await verifyFirebaseIdToken(token,firebaseProjectId);}
    catch{throw Object.assign(new Error('La sesión Firebase ha caducado o no es válida'),{status:401});}
   }
   return sitesAuthenticator.authenticate(request);
  }
 };
}
