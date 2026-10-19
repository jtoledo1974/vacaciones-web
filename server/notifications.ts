import {currentTurn} from '../domain/election.ts';
import type {Repository} from './repository.ts';
import {requireSuper,type Principal} from './permissions.ts';
import {deliverPush,publicPushKey,type PushConfig} from './web-push.ts';
import {ApiError} from './errors.ts';
export function ownerKey(actor:Principal):string{
 if(!actor.id)throw new ApiError('Inicia sesión',401);
 return actor.emailKey??actor.id;
}
export async function notificationSettings(repo:Repository,actor:Principal,config:PushConfig){
 const key=ownerKey(actor);
 return {canTest:actor.role==='superadmin',publicKey:publicPushKey(config),subscriptions:(await repo.all('SELECT endpoint,created_at FROM push_subscriptions WHERE owner_key=?',[key])).map(s=>({endpoint:s.endpoint,createdAt:s.created_at})),notifications:await repo.all('SELECT n.id,n.campaign_id,n.round,n.created_at,c.team_id,c.year FROM turn_notifications n JOIN campaigns c ON c.id=n.campaign_id WHERE n.owner_key=? ORDER BY n.created_at DESC LIMIT 25',[key])};
}
function validateString(v:unknown,max:number):v is string{return typeof v==='string'&&v.length>0&&v.length<=max;}
export async function updateSubscription(repo:Repository,actor:Principal,body:any,config:PushConfig){
 const key=ownerKey(actor);
 if(body.action==='subscribe'){
  if(!publicPushKey(config))throw new ApiError('Notificaciones push no configuradas',503);
  const s=body.subscription;
  if(!s||!validateString(s.endpoint,2048)||!s.endpoint.startsWith('https://')||!validateString(s.keys?.p256dh,150)||!validateString(s.keys?.auth,100))throw new ApiError('Suscripción incorrecta');
  // Never transfer another account's endpoint silently.
  const existing=await repo.all('SELECT owner_key FROM push_subscriptions WHERE endpoint=?',[s.endpoint]);
  if(existing.length&&existing[0].owner_key!==key)throw new ApiError('Este dispositivo está vinculado a otra cuenta. Elimina primero su suscripción',409);
  await repo.batch([{sql:'INSERT INTO push_subscriptions(endpoint,owner_key,p256dh,auth,created_at) VALUES(?,?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh,auth=excluded.auth',args:[s.endpoint,key,s.keys.p256dh,s.keys.auth,new Date().toISOString()]}]);
 }else if(body.action==='unsubscribe'){
  if(!validateString(body.endpoint,2048))throw new ApiError('Suscripción incorrecta');
  await repo.batch([{sql:'DELETE FROM push_subscriptions WHERE endpoint=? AND owner_key=?',args:[body.endpoint,key]}]);
 }else throw new ApiError('Acción desconocida');
 return {ok:true};
}

/**
 * Send a real Web Push to exactly one subscription owned by the authenticated superadmin.
 * This is independent of elections, simulations, the notification queue and Cron.
 * Provider acceptance does not guarantee that the operating system will display it.
 */
export async function sendTestPush(
 repo:Repository,actor:Principal,endpoint:unknown,config:PushConfig,
 sender:typeof deliverPush=deliverPush,
):Promise<{accepted:true}>{
 requireSuper(actor);
 if(!publicPushKey(config))throw new ApiError('Notificaciones Push no configuradas',503);
 if(!validateString(endpoint,2048)||!endpoint.startsWith('https://'))throw new ApiError('Selecciona un dispositivo registrado',400);
 const subscription=(await repo.all('SELECT endpoint,p256dh,auth FROM push_subscriptions WHERE owner_key=? AND endpoint=?',[ownerKey(actor),endpoint]))[0];
 if(!subscription)throw new ApiError('Este dispositivo no está registrado en tu sesión',403);
 let response:Response;
 try{
  response=await sender(config,subscription,{
   title:'Vacaciones · Prueba de notificación',
   body:'Este es un aviso de prueba. No se ha modificado ningún turno.',
   url:'/notificaciones',
   tag:'admin-push-test-'+crypto.randomUUID(),
  });
 }catch{throw new ApiError('Error de conexión con el servicio Push',502);}
 if(!response.ok)throw new ApiError(
  response.status===404||response.status===410?'La suscripción ha caducado. Vuelve a activar las notificaciones.':'El servicio Push ha rechazado la prueba',502
 );
 return {accepted:true};
}

const MAX_DELIVERIES_PER_RUN = 6;
const DELIVERY_LEASE_MS = 90000;

/**
 * Per-device checkpoints ensure a retry cannot send a successful device twice.
 * CAS leases prevent concurrent immediate and Cron dispatchers claiming the same device.
 */
export async function flushTurnNotifications(repo:Repository,config:PushConfig,campaignId:string,budget:{remaining:number}={remaining:MAX_DELIVERIES_PER_RUN}){
 if(!publicPushKey(config))return;
 const rows=await repo.all("SELECT * FROM turn_notifications WHERE campaign_id=? AND push_status='pending' ORDER BY created_at LIMIT 25",[campaignId]);
 const campaign=(await repo.all('SELECT team_id,year FROM campaigns WHERE id=?',[campaignId]))[0];
 if(!campaign)return;
 const targetUrl='/?equipo='+encodeURIComponent(campaign.team_id)+'&year='+encodeURIComponent(String(campaign.year));
 for(const row of rows){
  if(budget.remaining<=0)break;
  const subscriptions=await repo.all('SELECT * FROM push_subscriptions WHERE owner_key=?',[row.owner_key]);
  if(!subscriptions.length)continue;
  for(const sub of subscriptions){
   if(budget.remaining<=0)break;
   await repo.batch([{sql:"INSERT OR IGNORE INTO push_deliveries(event_id,endpoint,status,lease_expires_at,attempts) VALUES(?,?,'pending',0,0)",args:[row.id,sub.endpoint]}]);
   const token=crypto.randomUUID(),now=Date.now();
   const claim=await repo.batch([
    {sql:"UPDATE push_deliveries SET status='sending',lease_token=?,lease_expires_at=?,attempts=attempts+1 WHERE event_id=? AND endpoint=? AND (status='pending' OR (status='sending' AND lease_expires_at<?))",args:[token,now+DELIVERY_LEASE_MS,row.id,sub.endpoint,now]},
    {sql:'SELECT lease_token,status FROM push_deliveries WHERE event_id=? AND endpoint=?',args:[row.id,sub.endpoint]}
   ]);
   if(claim[1].results[0]?.lease_token!==token||claim[1].results[0]?.status!=='sending')continue;
   budget.remaining--;
   try{
    const response=await deliverPush(config,sub,{title:'Vacaciones · Es tu turno',body:'Ronda '+row.round+'. Ya puedes elegir tus vacaciones.',url:targetUrl,tag:row.id});
    if(response.status===404||response.status===410){
     await repo.batch([
      {sql:'DELETE FROM push_subscriptions WHERE endpoint=? AND owner_key=?',args:[sub.endpoint,row.owner_key]},
      {sql:"UPDATE push_deliveries SET status='revoked',lease_token=NULL WHERE event_id=? AND endpoint=? AND lease_token=?",args:[row.id,sub.endpoint,token]}
     ]);
    }else{
     await repo.batch([{sql:"UPDATE push_deliveries SET status=?,lease_token=NULL WHERE event_id=? AND endpoint=? AND lease_token=?",args:[response.ok?'sent':'pending',row.id,sub.endpoint,token]}]);
    }
   }catch{
    await repo.batch([{sql:"UPDATE push_deliveries SET status='pending',lease_token=NULL WHERE event_id=? AND endpoint=? AND lease_token=?",args:[row.id,sub.endpoint,token]}]).catch(()=>undefined);
   }
  }
  const incomplete=await repo.all("SELECT s.endpoint FROM push_subscriptions s LEFT JOIN push_deliveries d ON d.endpoint=s.endpoint AND d.event_id=? WHERE s.owner_key=? AND (d.status IS NULL OR d.status<>'sent') LIMIT 1",[row.id,row.owner_key]);
  const count=await repo.all('SELECT endpoint FROM push_subscriptions WHERE owner_key=? LIMIT 1',[row.owner_key]);
  if(count.length&&!incomplete.length)await repo.batch([{sql:"UPDATE turn_notifications SET push_status='sent' WHERE id=? AND push_status='pending'",args:[row.id]}]);
 }
}

/**
 * Scheduled, independent dispatcher. Never invoked from the election write path.
 * A failed push or missing notifications table cannot block a vacation choice.
 * Call via a separately scheduled HTTPS POST authenticated with
 * NOTIFICATIONS_DISPATCH_SECRET (e.g. every minute).
 */
export async function dispatchNotifications(repo:Repository,config:PushConfig,campaignId?:string){
 const campaigns=await repo.all(`SELECT c.id,c.year,c.team_id,c.version,c.status,e.json,p.json AS config_json
    FROM campaigns c JOIN election_states e ON e.campaign_id=c.id
    JOIN parameters p ON p.campaign_id=c.id
    WHERE c.scope_key='live' AND c.status='open' ${campaignId?'AND c.id=?':''} LIMIT 100`,campaignId?[campaignId]:[]);
 let enqueued=0,errors=0;
 const budget={remaining:MAX_DELIVERIES_PER_RUN};
 for(const campaign of campaigns){
  try{
   const state=JSON.parse(campaign.json);
   if(state.status!=='active'||state.automaticPaused)continue;
   const parts=await repo.batch([
    {sql:'SELECT * FROM campaign_members WHERE campaign_id=?',args:[campaign.id]},
    {sql:'SELECT * FROM awards WHERE campaign_id=?',args:[campaign.id]},
    {sql:'SELECT * FROM requests WHERE campaign_id=?',args:[campaign.id]}
   ]);
   const members=parts[0].results;
   const ctx={year:campaign.year,team:campaign.team_id,config:JSON.parse(campaign.config_json),members,awards:parts[1].results,requests:parts[2].results};
   const turn=currentTurn(ctx,state);
   if(turn.pendingTie||!turn.memberId)continue;
   const participants:string[]=turn.participants?.length?turn.participants:[turn.memberId];
   for(const memberId of participants){
    const member=members.find((m:any)=>m.id===memberId);
    if(!member)continue;
    const accounts=await repo.all('SELECT principal_key FROM controller_accounts WHERE person_id=?',[member.person_id]);
    if(!accounts[0])continue;
    // Stable turn event id across periodic polls; do not spam the same turn.
    const id=[campaign.id,memberId,turn.round,state.cursor].join(':');
    await repo.batch([{sql:'INSERT OR IGNORE INTO turn_notifications(id,owner_key,campaign_id,member_id,round,created_at) VALUES(?,?,?,?,?,?)',args:[id,accounts[0].principal_key,campaign.id,memberId,turn.round,new Date().toISOString()]}]);
    enqueued++;
   }
  }catch{errors++;}
 }
 // Delivery failures are retained as pending and retried next time.
 for(const campaign of campaigns){
  try{
   // Drop obsolete pending alerts: never notify a controller after their turn passed.
   const state=JSON.parse(campaign.json);
   if(state.status!=='active'||state.automaticPaused)continue;
   const rows=await repo.batch([{sql:'SELECT * FROM campaign_members WHERE campaign_id=?',args:[campaign.id]},{sql:'SELECT * FROM awards WHERE campaign_id=?',args:[campaign.id]},{sql:'SELECT * FROM requests WHERE campaign_id=?',args:[campaign.id]}]);
   const turn=currentTurn({year:campaign.year,team:campaign.team_id,config:JSON.parse(campaign.config_json),members:rows[0].results,awards:rows[1].results,requests:rows[2].results},state);
   const participants:string[]=turn.pendingTie?[]:turn.participants?.length?turn.participants:turn.memberId?[turn.memberId]:[];
   const valid=participants.map(memberId=>[campaign.id,memberId,turn.round,state.cursor].join(':'));
   const pending=await repo.all("SELECT id FROM turn_notifications WHERE campaign_id=? AND push_status='pending'",[campaign.id]);
   for(const row of pending)if(!valid.includes(row.id))await repo.batch([{sql:"UPDATE turn_notifications SET push_status='obsolete' WHERE id=?",args:[row.id]}]);
   if(valid.length&&budget.remaining>0)await flushTurnNotifications(repo,config,campaign.id,budget);
  }catch{errors++;}
 }
 return {campaigns:campaigns.length,enqueued,errors};
}
