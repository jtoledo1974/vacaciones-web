import {currentTurn,type ElectionContext,type JointChoice} from '../domain/election.ts';
import {applyStep,evaluateScenario,reconcileScenario,MAX_SIMULATION_STEPS,type PersonalScenario} from '../domain/personal-simulation.ts';
import type {Principal} from './permissions.ts';
import type {Repository} from './repository.ts';
import type {ElectionService} from './election-service.ts';
import {ApiError} from './errors.ts';
import {occupancyFor} from '../domain/policy.ts';

type Host={load:(cid:string)=>Promise<any>;election:()=>ElectionService};
const context=(d:any):ElectionContext=>({year:d.campaign.year,team:d.campaign.team_id,config:d.config,members:d.members,requests:d.requests,awards:d.awards});

/**
 * The controller's private simulator. Writes go straight to its own table,
 * without audit or app revision: nobody else can see or is affected by them.
 * Preferences are never loaded here.
 */
export class PersonalSimulationService{
 constructor(private repo:Repository,private actor:Principal,private host:Host){}
 private async setup(cid:string){
  if(!this.actor.id)throw new ApiError('Inicia sesión para usar el simulador',401);
  if(this.actor.preview)throw new ApiError('El simulador personal no está disponible en la vista previa',403);
  const d=await this.host.load(cid);
  if(d.campaign.scope_key!=='live')throw new ApiError('El simulador personal solo está disponible en la campaña real',403);
  if(!occupancyFor(d.campaign.year))throw new ApiError('El simulador personal requiere un motor de ocupación para este ejercicio',400);
  const me=await this.host.election().memberForAccount(d);
  if(!me)throw new ApiError('Tu cuenta no está vinculada a ningún controlador de esta campaña',403);
  const raw=await this.host.election().read(cid);
  const ready=d.campaign.status==='open'&&raw.state?.status==='active';
  // `state` is only read when `ready`, which implies an active election state.
  return {d,me,state:raw.state!,ready};
 }
 private async load(cid:string):Promise<PersonalScenario>{
  const rows=await this.repo.all('SELECT json FROM personal_simulations WHERE owner_key=? AND campaign_id=?',[this.actor.id,cid]);
  if(!rows[0])return {steps:[]};
  try{const parsed=JSON.parse(rows[0].json);return Array.isArray(parsed?.steps)?parsed:{steps:[]};}catch{return {steps:[]};}
 }
 private async save(cid:string,me:string,scenario:PersonalScenario){
  if(!scenario.steps.length){await this.clear(cid);return;}
  await this.repo.batch([{sql:'INSERT INTO personal_simulations(owner_key,campaign_id,member_id,json,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(owner_key,campaign_id) DO UPDATE SET member_id=excluded.member_id,json=excluded.json,updated_at=excluded.updated_at',
   args:[this.actor.id,cid,me,JSON.stringify(scenario),new Date().toISOString()]}]);
 }
 private async clear(cid:string){
  await this.repo.batch([{sql:'DELETE FROM personal_simulations WHERE owner_key=? AND campaign_id=?',args:[this.actor.id,cid]}]);
 }
 async view(cid:string){
  const {d,me,state,ready}=await this.setup(cid);
  if(!ready){
   // Nothing to simulate while the election is not running; a finished election also ends the simulation.
   if((await this.load(cid)).steps.length)await this.clear(cid);
   return {version:d.campaign.version,available:false,memberId:me};
  }
  const ctx=context(d),scenario=await this.load(cid);
  const reconciled=reconcileScenario(ctx,state,scenario);
  if(!reconciled.valid){
   await this.clear(cid);
   return {...this.present(d,me,reconcileScenario(ctx,state,{steps:[]})),
    notice:'Tu simulación se ha borrado porque las elecciones reales ya no encajan con ella.'};
  }
  if(reconciled.replaced>0)await this.save(cid,me,{steps:reconciled.steps});
  return {...this.present(d,me,reconciled),
   ...(reconciled.replaced>0?{replaced:reconciled.replaced}:{})};
 }
 private present(d:any,me:string,reconciled:ReturnType<typeof reconcileScenario>){
  if(!reconciled.valid)throw new ApiError('Simulación no válida',409);
  const {replay,steps}=reconciled;
  const turn=currentTurn(replay.ctx,replay.state);
  return {version:d.campaign.version,available:true,memberId:me,steps,
   awards:replay.ctx.awards.map(a=>({member_id:a.member_id,cycle_date:a.cycle_date,simulated:String(a.id).startsWith('simulated-')})),
   turn:{memberId:turn.memberId,participants:turn.participants,needed:turn.needed,requiredByMember:turn.requiredByMember,round:turn.round,
    pendingTie:!!(turn as any).pendingTie,complete:turn.state.status==='complete'},
   ...evaluateScenario(replay,me)};
 }
 async mutate(cid:string,body:any){
  const {d,me,state,ready}=await this.setup(cid);
  if(!ready)throw new ApiError('La elección no está en curso',409);
  const ctx=context(d);
  if(body?.action==='clear'){await this.clear(cid);return this.view(cid);}
  const reconciled=reconcileScenario(ctx,state,await this.load(cid));
  if(!reconciled.valid){await this.clear(cid);return this.view(cid);}
  if(body?.action==='undo'){
   await this.save(cid,me,{steps:reconciled.steps.slice(0,-1)});
   return this.view(cid);
  }
  if(body?.action!=='add')throw new ApiError('Acción de simulación desconocida');
  if(reconciled.steps.length>=MAX_SIMULATION_STEPS)throw new ApiError('La simulación admite como máximo '+MAX_SIMULATION_STEPS+' turnos. Deshaz o bórrala para seguir.');
  const entries=body.entries as JointChoice[];
  if(!Array.isArray(entries)||!entries.length||entries.length>3||entries.some(e=>typeof e?.member_id!=='string'||!Array.isArray(e.dates)||e.dates.length>3||e.dates.some((x:unknown)=>typeof x!=='string')))
   throw new ApiError('Turno simulado no válido');
  let step;
  try{step=applyStep(reconciled.replay.ctx,reconciled.replay.state,entries).step;}
  catch(error:any){throw new ApiError(error?.message??'Turno simulado no válido',409);}
  await this.save(cid,me,{steps:[...reconciled.steps,step]});
  return this.view(cid);
 }
}
