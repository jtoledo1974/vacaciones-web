import {getChatGPTUser} from '../app/chatgpt-auth';
import type {Identity} from './permissions';

// Providers verify credentials; permissions are resolved separately by principal().
export interface Authenticator {
    authenticate(request:Request):Promise<Identity>;
}

export const sitesAuthenticator:Authenticator={
    async authenticate(_request){
        const user=await getChatGPTUser();
        return user?{provider:'chatgpt',subject:user.userId,email:user.email,emailVerified:true}:null;
    }
};
