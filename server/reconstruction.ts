import {choose,chooseJoint,currentTurn,defer,consumePreferences,preferredChoice,choiceIssues,entitlementFor,resolveTie,registerJointAgreement,cancelJointAgreement,PREFERENCE_COLUMNS,preferenceRow,type ElectionContext,type ElectionState,type Preference} from '../domain/election.ts';
import {calculate} from '../domain/vacations.ts';
import type {AvailabilitySnapshot,CompactAvailabilitySnapshot} from '../domain/occupancy.ts';
import {occupancyFor,campaignOf} from '../domain/policy.ts';
import {canWrite,type Principal} from './permissions.ts';
import {cas,insertRows,type Repository,type Statement} from './repository.ts';
import {ApiError} from './errors.ts';
import {AuditContext,appliedAudit,auditBefore,auditAfter} from './audit-context.ts';
export {appliedAudit} from './audit-context.ts';

type Snapshot={format?:string;state:ElectionState|null;preferences:Preference[];awards:any[];requests:any[]};
type Historical={id:string;action:string;before:Snapshot;after:any;round:number;participants:string[];memberId:string|null};
type Applied={before:Snapshot;usedId:string|null;kind:string;dates?:string[];entries?:any[];order?:string[];agreementIds?:string[];actor:string;at:string;beforeAvailability?:AvailabilitySnapshot|CompactAvailabilitySnapshot};
type Session={status:'active'|'review'|'completed';startedBy:string;startedAt:string;targetId:string;targetCursor:number;keepCount:number;origin:Snapshot;originalEvents:Historical[];originalAuditIds:string[];applied:Applied[];undone:Applied[];completedAt?:string;impact?:any[];originAvailability?:AvailabilitySnapshot|CompactAvailabilitySnapshot};
type Host={load:(cid:string)=>Promise<any>;commit:(statements:Statement[])=>Promise<any>;audit:(action:string,c:any,before:any,after:any)=>Statement};
const ctx=(d:any,awards=d.awards,requests=d.requests):ElectionContext=>({year:d.campaign.year,team:d.campaign.team_id,config:d.config,members:d.members,awards,requests});
const snap=(state:ElectionState|null,preferences:Preference[],d:any):Snapshot=>({state:structuredClone(state),preferences:structuredClone(preferences),awards:structuredClone(d.awards),requests:structuredClone(d.requests)});
const statement=(cid:string,state:ElectionState|null):Statement=>state?{sql:'INSERT INTO election_states(campaign_id,json) VALUES(?,?) ON CONFLICT(campaign_id) DO UPDATE SET json=excluded.json',args:[cid,JSON.stringify(state)]}:{sql:'DELETE FROM election_states WHERE campaign_id=?',args:[cid]};
function restore(cid:string,s:Snapshot):Statement[]{
 return [
  {sql:'DELETE FROM awards WHERE campaign_id=?',args:[cid]},
  {sql:'DELETE FROM requests WHERE campaign_id=?',args:[cid]},
  {sql:'DELETE FROM preferences WHERE campaign_id=?',args:[cid]},
  ...insertRows('awards',['id','campaign_id','member_id','cycle_date','version'],s.awards.map(a=>[a.id,cid,a.member_id,a.cycle_date,a.version])),
  ...insertRows('requests',['id','campaign_id','member_id','slot','cycle_date','version'],s.requests.map(r=>[r.id,cid,r.member_id,r.slot,r.cycle_date,r.version])),
  ...insertRows('preferences',PREFERENCE_COLUMNS,s.preferences.map(p=>preferenceRow(p,cid))),
  statement(cid,s.state)
 ];
}
function sameList(a:Preference,b:Preference){return JSON.stringify([a.dates,a.persistent===true,a.mode??'immediate',a.waitMinutes??0,a.labels??{}])===JSON.stringify([b.dates,b.persistent===true,b.mode??'immediate',b.waitMinutes??0,b.labels??{}]);}
const isDecision=(action:string)=>['choose','choose_joint','defer','advance','resolve_tie','reconstruction_step','register_joint','cancel_joint'].includes(action);
function historical(d:any,row:any):Historical|null{
 if(!isDecision(row.action)||!row.before_json)return null;
 const before=auditBefore(row) as Snapshot;
 if(before.format!=='election-undo-v1'||!before.state)return null;
 let turn;try{turn=currentTurn(ctx(d,before.awards,before.requests),before.state);}catch{return null;}
 const after=auditAfter(row)??{};
 return {id:row.id,action:row.action,before,after,round:after?.joint?.round??turn.round,participants:after?.joint?.members??turn.pendingTie??turn.participants,memberId:['register_joint','cancel_joint'].includes(row.action)?null:turn.memberId};
}
// The session keeps only what replaying a decision reads: the cursor state, the
// participants' own lists and the decision itself. Awards, requests, other lists
// and the availability report stay in the audit row (they made sessions ~1.7 MB).
function sessionEvent(e:Historical):Historical{
 const {impact:_impact,...after}=e.after??{};
 return {...e,after,before:{format:e.before.format,state:e.before.state,awards:[],requests:[],
  preferences:e.before.preferences.filter(p=>e.participants.includes(p.member_id))}};
}
export class ReconstructionService{
 constructor(private repo:Repository,private actor:Principal,private host:Host){}
 async read(cid:string):Promise<Session|null>{
  const rows=await this.repo.all('SELECT json FROM reconstruction_sessions WHERE campaign_id=?',[cid]);
  return rows[0]?JSON.parse(rows[0].json):null;
 }
 private write(cid:string,s:Session):Statement{return {sql:'INSERT INTO reconstruction_sessions(campaign_id,json) VALUES(?,?) ON CONFLICT(campaign_id) DO UPDATE SET json=excluded.json',args:[cid,JSON.stringify(s)]};}
 private async auditRows(cid:string){return this.repo.all('SELECT id,action,before_json,after_json,created_at FROM audit WHERE campaign_id=? ORDER BY rowid ASC',[cid]);}
 async candidates(d:any,audit?:AuditContext){
  const rows=await (audit?.rows()??this.auditRows(d.campaign.id)),current=audit?await audit.replay():appliedAudit(rows);
  const currentIds=new Set(current.done.map(row=>row.id));
  return rows.map(row=>historical(d,row)).filter((entry):entry is Historical=>!!entry&&!['register_joint','cancel_joint'].includes(entry.action)).map(entry=>({
   id:entry.id,action:entry.action,round:entry.round,memberIds:entry.participants,choices:entry.after.choices??[],cursor:entry.before.state?.cursor??0,archived:!currentIds.has(entry.id)
  })).reverse();
 }
 private pick(d:any,s:Session,state:ElectionState,awards:any[],requests:any[],skipProof=false){
  // Replay round-scoped agreements at their original point in the cursor history.
  // The dry-run also drives the preview, so it matches what the next step commits.
  const used=new Set(s.applied.flatMap(step=>step.agreementIds??[]));
  let working=structuredClone(state);const agreementIds:string[]=[];
  for(const event of s.originalEvents){
   if(!['register_joint','cancel_joint'].includes(event.action)||used.has(event.id)||!event.before.state||event.before.state.cursor>working.cursor)continue;
   const agreement=event.after?.joint;
   if(!agreement)continue;
   const context=ctx(d,awards,requests);
   working=event.action==='register_joint'
    ?registerJointAgreement(context,working,agreement.members,agreement.round,event.after.actor??s.startedBy,event.after.at??new Date().toISOString())
    :cancelJointAgreement(context,working,agreement.members,agreement.round,event.after.actor??s.startedBy,event.after.at??new Date().toISOString());
   agreementIds.push(event.id);
  }
  const turn=currentTurn(ctx(d,awards,requests),working);
  const original=s.originalEvents.find(e=>!['register_joint','cancel_joint'].includes(e.action)&&!s.applied.some(a=>a.usedId===e.id)&&e.round===turn.round&&
   (turn.pendingTie?e.action==='resolve_tie'&&e.participants.length===turn.pendingTie.length&&turn.pendingTie.every((id:string)=>e.participants.includes(id)):e.memberId===turn.memberId&&e.participants.length===turn.participants.length&&turn.participants.every((id:string)=>e.participants.includes(id))));
  const historicalPreferences=original?.before.preferences.filter(p=>turn.participants.includes(p.member_id))??[];
  const first=!skipProof&&turn.participants.length===1&&turn.memberId&&historicalPreferences.length?preferredChoice(ctx(d,awards,requests),{...turn.state,automaticPaused:false},historicalPreferences.map(p=>({...p,active:true,mode:p.mode==='wait'?'immediate':p.mode}))):null;
  const originalChoices=(original?.after?.choices??[]) as {member_id:string;cycle_date:string}[];
  const originalEntries=turn.participants.map((id:string)=>({member_id:id,dates:originalChoices.filter(a=>a.member_id===id).map(a=>a.cycle_date)}));
  let canOriginal=false;
  if(!skipProof&&original&&(original.action==='defer'||original.action==='reconstruction_step'&&original.after.kind==='defer')){try{if(!turn.memberId)throw Error();defer(ctx(d,awards,requests),working,turn.memberId);canOriginal=true;}catch{canOriginal=false;}}
  else if(!skipProof&&original&&(original.action==='resolve_tie'||original.action==='reconstruction_step'&&original.after.kind==='resolve_tie'))canOriginal=!!turn.pendingTie&&Array.isArray(original.after?.resolution?.order??original.after?.order);
  else if(!skipProof&&original&&turn.participants.length>1){
   // The preview must use exactly the same atomic joint validation as replay.
   // Per-person checks against the old state can incorrectly approve a batch
   // that consumes a single shared policy quota more than once.
   try{chooseJoint(ctx(d,awards,requests),working,originalEntries);canOriginal=true;}catch{canOriginal=false;}
  }else if(!skipProof&&original&&turn.memberId){
   try{choose(ctx(d,awards,requests),working,turn.memberId,originalEntries[0]?.dates??[]);canOriginal=true;}catch{canOriginal=false;}
  }
  const rules=occupancyFor(d.campaign.year);
  const available=turn.participants.length===1&&turn.memberId
   ?calculate(d.campaign.year,d.campaign.team_id,d.config,d.members,requests,awards,{skipProof:skipProof}).cycles.filter(c=>
     skipProof&&rules
      ?rules.immediateIssues(rules.state(campaignOf(d.campaign,d.config),d.members,awards),
        [{member_id:turn.memberId!,cycle_date:c.date}]).length===0
      :!choiceIssues(ctx(d,awards,requests),turn.memberId!,[c.date]).length
    ).map(c=>c.date):[];
  return {turn,original,first,originalEntries,canOriginal,available,historicalPreferences,workingState:working,agreementIds};
 }
 private impact(d:any,s:Session,awards:any[],requests:any[]){
  const base=ctx(d,s.origin.awards,s.origin.requests),now=ctx(d,awards,requests);
  const result:any[]=[];
  for(const member of d.members){
   const oldCount=s.origin.awards.filter(a=>a.member_id===member.id).length;
   const newCount=awards.filter(a=>a.member_id===member.id).length;
   if(newCount>=entitlementFor(now,member.id)&&oldCount>=entitlementFor(base,member.id))continue;
   const pref=s.origin.preferences.find(p=>p.member_id===member.id);
   const previous=pref?.dates.filter(date=>!choiceIssues(base,member.id,[date]).length)??[];
   const current=pref?.dates.filter(date=>!choiceIssues(now,member.id,[date]).length)??[];
   if(previous.join('|')!==current.join('|')||oldCount!==newCount)result.push({memberId:member.id,previous,current,previousFirst:previous[0]??null,currentFirst:current[0]??null,oldCount,newCount});
  }
  return result;
 }
 async view(d:any,raw:{state:ElectionState|null;preferences:Preference[]},skipProof=false,audit?:AuditContext){
  const s=await this.read(d.campaign.id);
  if(this.actor.preview||!canWrite(this.actor,d.campaign.team_id))return {active:!!s&&s.status!=='completed'};
  const candidates=await this.candidates(d,audit);
  if(!s)return {active:false,candidates};
  const active=s.status!=='completed',state=raw.state;
  const pick=active&&state?this.pick(d,s,state,d.awards,d.requests,skipProof):null;
  return {active,status:s.status,candidates:s.status==='completed'?candidates:[],progress:s.applied.length,total:s.originalEvents.filter(e=>!['register_joint','cancel_joint'].includes(e.action)).length,startedAt:s.startedAt,startedBy:s.startedBy,targetId:s.targetId,
   targetCursor:s.targetCursor,canFinish:s.status==='review',canBack:s.applied.length>0,canForward:s.undone.length>0,
   original:s.origin.awards.map(a=>({memberId:a.member_id,date:a.cycle_date})),
   current:pick?{round:pick.turn.round,memberId:pick.turn.memberId,participants:pick.turn.participants,needed:pick.turn.needed,pendingTie:pick.turn.pendingTie??null,requiredByMember:pick.turn.requiredByMember,
    historicalPreference:pick.first,preferences:pick.historicalPreferences,originalChoice:pick.originalEntries,originalAction:pick.original?.action==='reconstruction_step'?(pick.original.after?.kind??'choose'):(pick.original?.action??null),originalTie:pick.original?.after?.resolution??null,originalPossible:pick.canOriginal,available:pick.available}:null,
   changes:s.applied.map(a=>({kind:a.kind,dates:a.dates,entries:a.entries,actor:a.actor,at:a.at})),
   impact:s.status==='completed'?s.impact??[]:skipProof?[]:this.impact(d,s,d.awards,d.requests)};
 }
 async mutate(d:any,raw:{state:ElectionState|null;preferences:Preference[]},body:any){
  const c=d.campaign,cid=c.id,action=body.action;
  if(this.actor.preview)throw new ApiError('La vista previa no permite reconstrucciones administrativas',403);
  if(!canWrite(this.actor,c.team_id))throw new ApiError('Solo un administrador del equipo puede reconstruir elecciones',403);
  if(c.status!=='open')throw new ApiError('La campaña está cerrada');
  if(body.version!==c.version)throw new ApiError('Otro administrador modificó la campaña. Actualiza la pantalla.',409);
  const existing=await this.read(cid);
  const before=snap(raw.state,raw.preferences,d),ops=cas(cid,c.version);
  if(action==='reconstruction_start'){
   if(existing&&existing.status!=='completed')throw new ApiError('Ya existe una reconstrucción abierta',409);
   const audit=await this.auditRows(cid),applied=appliedAudit(audit),index=applied.done.findIndex(row=>row.id===body.historyId);
   const pos=audit.findIndex(row=>row.id===body.historyId);
   if(pos<0)throw new ApiError('La decisión no existe en la auditoría',409);
   const target=historical(d,audit[pos]);if(!target?.before.state)throw new ApiError('Selecciona un turno de elección recuperable');
   // After undo + a new choice, old decisions form an archived branch. The guided
   // recovery must still find them, even though normal redo has been invalidated.
   const breakpoint=audit.findIndex((row,i)=>i>pos&&['election_undo','election_redo','reconstruction_start','reconstruction_cancel','reconstruction_back'].includes(row.action));
   const records=index>=0?applied.done.slice(index):audit.slice(pos,breakpoint<0?undefined:breakpoint);
   const originalEvents=records.map(row=>historical(d,row)).filter((e):e is Historical=>!!e).map(sessionEvent);
   let keepCount=index;
   if(keepCount<0)keepCount=applied.done.findIndex(row=>{
    if(!row.before_json)return false;
    const before=JSON.parse(row.before_json);
    return before.format==='election-undo-v1'&&(before.state?.cursor??-1)>=target.before.state!.cursor;
   });
   if(keepCount<0)keepCount=applied.done.length;
   const originalAuditIds=applied.done.slice(keepCount).map(row=>row.id);
   if(!originalEvents.length||originalEvents.length>1500)throw new ApiError('Número de decisiones no admitido para la reconstrucción');
   const previous=target.before,origin=before;
   // Keep lists edited after the rewind point, but restore the active bit when the same
   // one-turn list was consumed by one of the decisions being reconstructed.
   const working:Preference[]=origin.preferences.map(p=>{
    const old=previous.preferences.find(q=>q.member_id===p.member_id);
    return old&&sameList(p,old)?{...p,active:old.active}:p;
   });
   for(const p of previous.preferences)if(!working.some(q=>q.member_id===p.member_id))working.push(p);
   const restoreTo:Snapshot={...previous,requests:origin.requests,preferences:working,state:{...previous.state!,automaticPaused:true}};
   const last=originalEvents.at(-1);
   const lastCursor=(last?.before.state?.cursor??0)+(last&&['choose','choose_joint','advance','defer','reconstruction_step'].includes(last.action)?1:0);
   const rules=occupancyFor(c.year);
   const originAvailability=rules?rules.compact(rules.availability(rules.state(campaignOf(c,d.config),d.members,d.awards))):undefined;
   const s:Session={originAvailability,status:'active',startedBy:this.actor.id!,startedAt:new Date().toISOString(),targetId:target.id,targetCursor:Math.max(origin.state?.cursor??0,lastCursor),keepCount,origin,originalEvents,originalAuditIds,applied:[],undone:[]};
   const completed=restoreTo.state!.status==='complete'||restoreTo.state!.cursor>=s.targetCursor;
   if(completed)s.status='review';
   ops.push(...restore(cid,restoreTo),this.write(cid,s),this.host.audit('reconstruction_start',c,null,{targetId:target.id,keepCount,originalIds:originalAuditIds,version:c.version+1}));
   await this.host.commit(ops);return;
  }
  if(!existing||existing.status==='completed')throw new ApiError('No hay una reconstrucción abierta',409);
  const s=structuredClone(existing) as Session;
  if(action==='reconstruction_cancel'){
   ops.push(...restore(cid,s.origin),{sql:'DELETE FROM reconstruction_sessions WHERE campaign_id=?',args:[cid]},this.host.audit('reconstruction_cancel',c,null,{targetId:s.targetId,keepCount:s.keepCount,originalIds:s.originalAuditIds,recordedAvailability:s.originAvailability,version:c.version+1}));
   await this.host.commit(ops);return;
  }
  if(action==='reconstruction_back'){
   const previous=s.applied.pop();if(!previous)throw new ApiError('No hay decisiones reconstruidas que deshacer');
   s.undone.push(previous);s.status='active';
   ops.push(...restore(cid,{...previous.before,state:previous.before.state?{...previous.before.state,automaticPaused:true}:null}),this.write(cid,s),this.host.audit('reconstruction_back',c,null,{version:c.version+1,recordedAvailability:previous.beforeAvailability}));
   await this.host.commit(ops);return;
  }
  if(action==='reconstruction_finish'){
   if(s.status!=='review')throw new ApiError('Quedan turnos anteriores por reconstruir');
   s.status='completed';s.completedAt=new Date().toISOString();s.impact=this.impact(d,s,d.awards,d.requests);
   ops.push(this.write(cid,s),this.host.audit('reconstruction_finish',c,null,{version:c.version+1,changes:s.applied.length,affected:s.impact.length}));
   await this.host.commit(ops);return;
  }
  if(action!=='reconstruction_step'&&action!=='reconstruction_forward')throw new ApiError('Operación de reconstrucción no válida');
  if(s.status==='review')throw new ApiError('La secuencia está reconstruida. Finaliza o deshaz el último paso.');
  if(!raw.state)throw new ApiError('No existe estado de elección');
  const pick=this.pick(d,s,raw.state,d.awards,d.requests);
  const {turn,original,first,originalEntries,agreementIds}=pick;
  const redo=action==='reconstruction_forward'?s.undone.at(-1):null;
  if(action==='reconstruction_forward'&&!redo)throw new ApiError('No hay decisiones para rehacer');
  const kind=redo?.kind??body.kind;
  const mode=redo?'manual':body.mode;
  let dates:string[]=redo?.dates??body.dates,entries:any[]=redo?.entries??body.entries,order:string[]=redo?.order??body.order;
  if(mode==='preference'){
   if(!first)throw new ApiError('No hay preferencias históricas aplicables a este turno');
   dates=first;
  }else if(mode==='original'){
   if(!pick.canOriginal||!original)throw new ApiError('La elección original ya no es válida');
   if(original.action==='defer')dates=[];
   else if(original.action==='resolve_tie'||original.action==='reconstruction_step'&&original.after?.kind==='resolve_tie')order=original.after?.resolution?.order??original.after?.order;
   else if(turn.participants.length>1)entries=originalEntries;
   else dates=originalEntries[0]?.dates;
  }
  let state:ElectionState=pick.workingState,choices:{member_id:string;cycle_date:string}[]=[];
  try{
   const context=ctx(d);
   if(kind==='defer'){if(!turn.memberId||turn.participants.length!==1)throw new Error('No corresponde aplazar ahora');state=defer(context,state,turn.memberId);}
   else if(kind==='resolve_tie'){
    if(!turn.pendingTie)throw new Error('No hay un empate pendiente');
    state=resolveTie(context,state,order,'external',this.actor.id!,new Date().toISOString());
   }else if(kind==='choose_joint'){
    const next=chooseJoint(context,state,entries);state=next.state;choices=next.choices;
   }else if(kind==='choose'){
    if(!turn.memberId||turn.participants.length!==1)throw new Error('No corresponde elegir individualmente');
    const next=choose(context,state,turn.memberId,dates);state=next.state;choices=next.choices;
   }else throw new Error('Indica una elección, un turno conjunto, un sorteo o un aplazamiento');
  }catch(e:any){throw new ApiError(e.message??'Decisión de reconstrucción no válida');}
  state={...state,automaticPaused:true};
  const preferences=consumePreferences(raw.preferences,choices.map(a=>a.member_id));
  const awardRows=choices.map(a=>[crypto.randomUUID(),cid,a.member_id,a.cycle_date,1]);
  const newRequests:any[][]=[],used=new Map<string,Set<number>>();
  for(const [index,a] of choices.entries()){
   // An original request remains the scoring reference even when a reconstructed
   // award changes to another cycle; do not silently overwrite or duplicate it.
   const requested=d.requests.filter((r:any)=>r.member_id===a.member_id).length+newRequests.filter(row=>row[2]===a.member_id).length;
   const awarded=d.awards.filter((r:any)=>r.member_id===a.member_id).length+choices.slice(0,index+1).filter(r=>r.member_id===a.member_id).length;
   if(requested>=awarded)continue;
   if(d.requests.some((r:any)=>r.member_id===a.member_id&&r.cycle_date===a.cycle_date)||newRequests.some(row=>row[2]===a.member_id&&row[4]===a.cycle_date))continue;
   let slots=used.get(a.member_id);
   if(!slots){slots=new Set(d.requests.filter((r:any)=>r.member_id===a.member_id).map((r:any)=>r.slot));used.set(a.member_id,slots);}
   const slot=Array.from({length:d.config.cyclesPerPerson},(_,i)=>i+1).find(v=>!slots!.has(v));
   if(slot===undefined)throw new ApiError('No quedan posiciones para guardar la solicitud original');
   slots.add(slot);newRequests.push([crypto.randomUUID(),cid,a.member_id,slot,a.cycle_date,1]);
  }
  const usedId=original?.id??null;
  s.applied.push({before,usedId,kind,agreementIds,dates:kind==='choose'?dates:undefined,entries:kind==='choose_joint'?entries:undefined,order:kind==='resolve_tie'?order:undefined,actor:this.actor.id!,at:new Date().toISOString()});
  if(redo)s.undone.pop();else s.undone=[];
  if(state.status==='complete'||state.cursor>=s.targetCursor)s.status='review';
  // A chosen historic preference is never applied automatically: the administrator
  // selected it explicitly. The exact choice and associated request are one transaction.
  ops.push(statement(cid,state),...insertRows('awards',['id','campaign_id','member_id','cycle_date','version'],awardRows),
   ...insertRows('requests',['id','campaign_id','member_id','slot','cycle_date','version'],newRequests));
  for(const p of preferences){const previous=raw.preferences.find(q=>q.member_id===p.member_id);if(previous&&previous.active!==p.active)ops.push({sql:'UPDATE preferences SET active=? WHERE member_id=? AND campaign_id=?',args:[p.active!==false?1:0,p.member_id,cid]});}
  const rules=occupancyFor(c.year);
  const impact=rules&&choices.length
   ?rules.impact(
     rules.state(campaignOf(c,d.config),d.members,d.awards),
     rules.state(campaignOf(c,d.config),d.members,[...d.awards,...choices])
   ):null;
  if(impact&&rules&&s.applied.length)s.applied[s.applied.length-1].beforeAvailability=rules.compact(impact.before);
  const auditImpact=impact&&rules?{
   policyVersion:impact.policyVersion,status:impact.status,
   campaignVersionBefore:c.version,campaignVersionAfter:c.version+1,
   changes:impact.changes,events:impact.events,
   availabilityBefore:rules.compact(impact.before),availabilityAfter:rules.compact(impact.after)
  }:null;
  ops.push(this.write(cid,s),this.host.audit('reconstruction_step',c,{format:'election-undo-v1',...before},{version:c.version+1,choices,kind,usedId,impact:auditImpact,...(kind==='resolve_tie'?{order}: {})}));
  await this.host.commit(ops);
 }
}
