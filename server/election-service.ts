import {advanceAutomatic,choose,chooseJoint,currentTurn,defer,choiceIssues,preferredChoice,validateOrder,validateElectionState,ELECTION_POLICY_VERSION,type ElectionState,type Preference,type ElectionContext} from '../domain/election.ts';
import {calculate} from '../domain/vacations.ts';
import {canWrite,requireSuper,type Principal} from './permissions.ts';
import {cas,type Repository,type Statement} from './repository.ts';
import {ApiError} from './errors.ts';

type Host={load:(cid:string)=>Promise<any>;commit:(ops:Statement[])=>Promise<any>;audit:(action:string,c:any,before:any,after:any)=>Statement};
const context=(d:any):ElectionContext=>({year:d.campaign.year,team:d.campaign.team_id,config:d.config,members:d.members,requests:d.requests,awards:d.awards});
export function electionStateStatement(cid:string,state:ElectionState|null):Statement{return state?{sql:'INSERT INTO election_states(campaign_id,json) VALUES(?,?) ON CONFLICT(campaign_id) DO UPDATE SET json=excluded.json',args:[cid,JSON.stringify(state)]}:{sql:'DELETE FROM election_states WHERE campaign_id=?',args:[cid]};}
function insertRows(table:string,columns:string[],rows:unknown[][]):Statement[]{
 const ops:Statement[]=[];for(let i=0;i<rows.length;i+=12){const chunk=rows.slice(i,i+12);ops.push({sql:`INSERT INTO ${table}(${columns.join(',')}) VALUES ${chunk.map(()=>`(${columns.map(()=>'?').join(',')})`).join(',')}`,args:chunk.flat()});}return ops;
}
export class ElectionService{
 constructor(private repo:Repository,private actor:Principal,private host:Host){}
 async read(cid:string){
  const result=await this.repo.batch([{sql:'SELECT json FROM election_states WHERE campaign_id=?',args:[cid]},{sql:'SELECT * FROM preferences WHERE campaign_id=?',args:[cid]}]);
  return {state:result[0].results[0]?JSON.parse(result[0].results[0].json) as ElectionState:null,preferences:result[1].results.map(p=>({member_id:p.member_id,dates:JSON.parse(p.dates_json),automatic:!!p.automatic})) as Preference[]};
 }
 async memberForAccount(d:any){if(!this.actor.id)return null;return (await this.repo.all('SELECT m.id FROM campaign_members m JOIN controller_accounts a ON a.person_id=m.person_id WHERE m.campaign_id=? AND a.principal_key=?',[d.campaign.id,this.actor.id]))[0]?.id??null;}
 async history(cid:string,version:number){return (await this.repo.all('SELECT * FROM audit WHERE campaign_id=? ORDER BY created_at DESC LIMIT 30',[cid])).find(e=>e.before_json&&JSON.parse(e.before_json).format==='election-undo-v1'&&JSON.parse(e.after_json).version===version)??null;}
 async options(cid:string,selected:string[]){
  const d=await this.host.load(cid),raw=await this.read(cid),mine=await this.memberForAccount(d);
  if(d.campaign.scope_key!=='live'&&!canWrite(this.actor,d.campaign.team_id))throw new ApiError('Simulación reservada a administradores',403);
  if(!raw.state||d.campaign.status!=='open')throw new ApiError('No hay un turno activo');
  const ctx=context(d),turn=currentTurn(ctx,raw.state);
  if(!turn.memberId||(!canWrite(this.actor,d.campaign.team_id)&&turn.memberId!==mine))throw new ApiError('No es tu turno',403);
  if(selected.length>=turn.needed||choiceIssues(ctx,turn.memberId,selected).length)throw new ApiError('Selección inicial no válida');
  return {version:d.campaign.version,available:resultDates(ctx).filter(date=>!choiceIssues(ctx,turn.memberId!,[...selected,date]).length)};
 }
 async view(d:any){
  const cid=d.campaign.id,manage=canWrite(this.actor,d.campaign.team_id),mine=await this.memberForAccount(d),raw=await this.read(cid),ctx=context(d);
  let turn:any=null;if(raw.state){try{turn=currentTurn(ctx,raw.state);}catch{turn=null;}}
  const focus=manage?turn?.memberId:mine;
  const result=calculate(ctx.year,ctx.team,ctx.config,ctx.members,ctx.requests,ctx.awards);
  const available=focus?result.cycles.filter(c=>!choiceIssues(ctx,focus,[c.date]).length).map(c=>c.date):[];
  const points=d.members.map((m:any)=>({member_id:m.id,cycles:d.awards.filter((a:any)=>a.member_id===m.id).length,points:(d.requests.some((r:any)=>r.member_id===m.id)?d.requests.filter((r:any)=>r.member_id===m.id):d.awards.filter((a:any)=>a.member_id===m.id)).reduce((sum:number,a:any)=>sum+(result.cycles.find(c=>c.date===a.cycle_date)?.score??0),0)}));
  const history=manage?await this.history(cid,d.campaign.version):null;
  const accounts=this.actor.role==='superadmin'?await this.repo.all('SELECT a.*,m.id AS member_id FROM controller_accounts a JOIN campaign_members m ON m.person_id=a.person_id WHERE m.campaign_id=?',[cid]):[];
  return {state:raw.state?{...raw.state,source:manage?raw.state.source:undefined}:null,turn:turn?{memberId:turn.memberId,needed:turn.needed,round:turn.round,participants:turn.participants,requiredByMember:turn.requiredByMember,canDefer:!!(turn.memberId&&turn.participants.length===1&&raw.state?.allowDeferral&&(raw.state.credits[turn.memberId]??0)<2&&ctx.awards.filter(a=>a.member_id===turn.memberId).length+2+(raw.state.credits[turn.memberId]??0)<=ctx.config.cyclesPerPerson)}:null,preferences:raw.preferences.filter(p=>manage||p.member_id===mine),myMemberId:mine,canManage:manage,available,points,accounts,undo:history&&history.action!=='election_undo'?history.id:null,redo:history?.action==='election_undo'?history.id:null,pendingAutomatic:!!(raw.state&&turn&&preferredChoice(ctx,turn.state,raw.preferences))};
 }
 async mutate(cid:string,body:any){
  const d=await this.host.load(cid),c=d.campaign,manage=canWrite(this.actor,c.team_id),mine=await this.memberForAccount(d),raw=await this.read(cid),ctx=context(d);
  if(c.scope_key!=='live'&&!manage)throw new ApiError('Simulación reservada a administradores',403);
  if(!this.actor.id)throw new ApiError('Inicia sesión para guardar preferencias',401);
  if(!manage&&!mine)throw new ApiError('Tu cuenta no está vinculada a un controlador de este equipo',403);
  if(c.status!=='open')throw new ApiError('La campaña está cerrada');
  if(body.version!==c.version)throw new ApiError('La campaña cambió. Recarga antes de guardar.',409);
  const action=body.action,ops=cas(cid,c.version),snapshot={format:'election-undo-v1',...raw,awards:d.awards,requests:d.requests};
  let state=raw.state,preferences=raw.preferences,choices:any[]=[],automaticAllowed=true,recordUndo=true;
  const authorizeMember=(memberId:string)=>{if(!d.members.some((m:any)=>m.id===memberId))throw new ApiError('Controlador ajeno al equipo');if(!manage&&memberId!==mine)throw new ApiError('Solo puedes modificar tus propias preferencias o elegir en tu turno',403);};
  try{
   if(action==='preferences'){
    authorizeMember(body.memberId);
    const dates=body.dates,validDates=new Set(resultDates(ctx));
    if(!Array.isArray(dates)||dates.length>100||dates.some(date=>typeof date!=='string'||!validDates.has(date))||new Set(dates).size!==dates.length||typeof body.automatic!=='boolean')throw new ApiError('Lista de preferencias no válida: usa ciclos del calendario, sin duplicados');
    preferences=[...preferences.filter(p=>p.member_id!==body.memberId),{member_id:body.memberId,dates,automatic:body.automatic}];
    ops.push({sql:'INSERT INTO preferences(member_id,campaign_id,dates_json,automatic) VALUES(?,?,?,?) ON CONFLICT(member_id) DO UPDATE SET dates_json=excluded.dates_json,automatic=excluded.automatic',args:[body.memberId,cid,JSON.stringify(dates),body.automatic?1:0]});
   }else if(action==='start'){
    requireSuper(this.actor);validateOrder(body.order,d.members);
    if(d.config.cyclesPerPerson<1||d.config.cyclesPerPerson>6)throw new ApiError('La elección provisional admite entre uno y seis ciclos por persona');
    if(state&&d.awards.length)throw new ApiError('No cambies el orden después de comenzar a elegir. Reanuda la elección o reinicia las vacaciones.');
    if(body.rulesConfirmed!==true||typeof body.source!=='string'||body.source.trim().length<10||body.source.length>500||typeof body.allowDeferral!=='boolean')throw new ApiError('Confirma las reglas y el origen del orden antes de activar la elección');
    state={status:'active',order:body.order,cursor:0,credits:{},source:body.source.trim(),allowDeferral:body.allowDeferral,policyVersion:ELECTION_POLICY_VERSION,tieGroups:body.tieGroups??[],jointGroups:body.jointGroups??[]};validateElectionState(state,d.members);
   }else if(action==='choose'||action==='choose_joint'||action==='defer'){
    if(action==='choose_joint'){if(!manage)throw new ApiError('El turno conjunto requiere la confirmación del responsable',403);}else authorizeMember(body.memberId);if(!state)throw new ApiError('El administrador debe confirmar el orden de elección primero');
    if(action==='choose'){if(!Array.isArray(body.dates)||body.dates.some((v:any)=>typeof v!=='string'))throw new ApiError('Selección no válida');const next=choose(ctx,state,body.memberId,body.dates);state=next.state;choices=next.choices;}
    else if(action==='choose_joint'){const next=chooseJoint(ctx,state,body.entries);state=next.state;choices=next.choices;}
    else state=defer(ctx,state,body.memberId);
   }else if(action==='pause'||action==='resume'){
    requireSuper(this.actor);if(!state)throw new ApiError('No hay una elección configurada');state={...state,status:action==='pause'?'paused':'active'};
   }else if(action==='advance'){
    if(!state)throw new ApiError('No hay una elección configurada');
    if(!preferredChoice(ctx,state,preferences))return {changed:false};
   }else if(action==='link_account'){
    if(c.scope_key!=='live')throw new ApiError('Vincula las cuentas desde una campaña real');
    requireSuper(this.actor);authorizeMember(body.memberId);automaticAllowed=false;recordUndo=false;
    const member=d.members.find((m:any)=>m.id===body.memberId),existing=(await this.repo.all('SELECT * FROM controller_accounts WHERE person_id=?',[member.person_id]))[0];
    if((existing?.version??0)!==body.accountVersion)throw new ApiError('La vinculación cambió. Recarga antes de guardar.',409);
    const subject=String(body.subject??'').trim();if(subject.length>250||/[\s\r\n]/.test(subject))throw new ApiError('Identificador de cuenta no válido');
    if(subject)ops.push({sql:'INSERT INTO controller_accounts(person_id,principal_key,version) VALUES(?,?,1) ON CONFLICT(person_id) DO UPDATE SET principal_key=excluded.principal_key,version=controller_accounts.version+1',args:[member.person_id,'chatgpt:'+subject]});
    else ops.push({sql:'DELETE FROM controller_accounts WHERE person_id=?',args:[member.person_id]});
   }else if(action==='election_undo'||action==='election_redo'){
    requireSuper(this.actor);automaticAllowed=false;const entry=await this.history(cid,c.version);
    if(!entry||entry.id!==body.historyId||(action==='election_redo')!==(entry.action==='election_undo'))throw new ApiError('El cambio ya no está disponible para deshacer o rehacer',409);
    const prior=JSON.parse(entry.before_json);state=prior.state;preferences=prior.preferences;
    ops.push({sql:'DELETE FROM awards WHERE campaign_id=?',args:[cid]},{sql:'DELETE FROM requests WHERE campaign_id=?',args:[cid]},{sql:'DELETE FROM preferences WHERE campaign_id=?',args:[cid]},...insertRows('awards',['id','campaign_id','member_id','cycle_date','version'],prior.awards.map((a:any)=>[a.id,cid,a.member_id,a.cycle_date,a.version])),...insertRows('requests',['id','campaign_id','member_id','slot','cycle_date','version'],(prior.requests??d.requests).map((a:any)=>[a.id,cid,a.member_id,a.slot,a.cycle_date,a.version])),...insertRows('preferences',['member_id','campaign_id','dates_json','automatic'],preferences.map(p=>[p.member_id,cid,JSON.stringify(p.dates),p.automatic?1:0])));
   }else throw new ApiError('Operación de elección no válida');
   if(state&&automaticAllowed){const updated={...ctx,awards:[...ctx.awards,...choices.map((a,i)=>({...a,id:'manual-'+i}))]},next=advanceAutomatic(updated,state,preferences);state=next.state;choices.push(...next.choices);}
  }catch(e:any){if(e.status)throw e;throw new ApiError(e.message);}
  ops.push(electionStateStatement(cid,state));
  ops.push(...insertRows('awards',['id','campaign_id','member_id','cycle_date','version'],choices.map(a=>[crypto.randomUUID(),cid,a.member_id,a.cycle_date,1])));
  // Criterios 1.1 p.2: the original selection persists even if an award is
  // later changed. Existing imported requests for the same cycle are reused.
  const newRequests:any[][]=[],usedByMember=new Map<string,Set<number>>();
  for(const a of choices){
   if(d.requests.some((r:any)=>r.member_id===a.member_id&&r.cycle_date===a.cycle_date))continue;
   let used=usedByMember.get(a.member_id);
   if(!used){used=new Set(d.requests.filter((r:any)=>r.member_id===a.member_id).map((r:any)=>r.slot));usedByMember.set(a.member_id,used);}
   const slot=Array.from({length:ctx.config.cyclesPerPerson},(_,i)=>i+1).find(n=>!used!.has(n));
   if(slot===undefined)throw new ApiError('No quedan posiciones para registrar la solicitud original');
   used.add(slot);newRequests.push([crypto.randomUUID(),cid,a.member_id,slot,a.cycle_date,1]);
  }
  ops.push(...insertRows('requests',['id','campaign_id','member_id','slot','cycle_date','version'],newRequests));
  ops.push(this.host.audit(action,c,recordUndo?snapshot:null,{version:c.version+1,choices,memberId:body.memberId??null}));
  await this.host.commit(ops);return {changed:true};
 }
}
function resultDates(ctx:ElectionContext){return calculate(ctx.year,ctx.team,ctx.config,ctx.members,ctx.requests,ctx.awards).cycles.map(c=>c.date);}


