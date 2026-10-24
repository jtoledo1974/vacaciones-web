type Command = {action:string;version?:number;[key:string]:unknown};
type ElectionResult = {campaign:{id:string;version:number};election:{pendingAutomatic?:boolean}};

export const MAX_AUTOMATIC_STEPS=1000;
const stopsAutomatic=(action:string)=>['election_undo','election_redo','pause','link_account','resolve_tie'].includes(action)||action.startsWith('reconstruction_');

/** Publish committed steps in order; a failed continuation cannot undo its predecessor. */
export async function runElectionCommand<T extends ElectionResult>(
 request:(body:Command)=>Promise<T>,body:Command,version:number,confirmed:(result:T)=>void
):Promise<{result:T;continuationError?:unknown}>{
 let result=await request({...body,version});
 confirmed(result);
 if(stopsAutomatic(body.action))return {result};
 // A whole team may resolve every remaining turn automatically (20 × 6 =
 // 120 awards). The bound only guards against a server that never settles,
 // and reaching it is reported instead of silently leaving turns pending.
 for(let step=0;step<MAX_AUTOMATIC_STEPS&&result.election.pendingAutomatic;step++){
  try{result=await request({action:'advance',version:result.campaign.version});}
  catch(continuationError){return {result,continuationError};}
  confirmed(result);
 }
 if(result.election.pendingAutomatic)
  return {result,continuationError:new Error('Quedan elecciones automáticas pendientes')};
 return {result};
}
