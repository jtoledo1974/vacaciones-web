import {currentTurn,orderForRound,type ElectionContext,type ElectionState} from '../domain/election.ts';
import {appliedAudit,auditBefore,auditAfter,type AuditRow} from './audit-context.ts';
import type {ElectionTimelineItem} from '../domain/election-timeline-types.ts';
export type {ElectionTimelineItem} from '../domain/election-timeline-types.ts';

function parsed(row:AuditRow,side:'before'|'after'):any{
 try{return side==='before'?auditBefore(row):auditAfter(row);}catch{return null;}
}

function roundAt(row:AuditRow,ctx:ElectionContext):number|null{
 const before=parsed(row,'before'),state=before?.state as ElectionState|null;
 if(!state?.order?.length)return null;
 try{
  return currentTurn({...ctx,awards:before.awards??ctx.awards,requests:before.requests??ctx.requests},state).round;
 }catch{
  return Math.floor(state.cursor/state.order.length)+1;
 }
}

/**
 * Replay the same undo/redo stack as ElectionService.history(), then render
 * turn-level actions instead of inferring turns from individual awards.
 * Each action retains its original ordering even when it selected 2–3 cycles.
 */
export function buildElectionTimeline(rows:AuditRow[],ctx:ElectionContext,state:ElectionState|null,history=appliedAudit(rows)):ElectionTimelineItem[]{
 // Reuse the canonical audit replay so guided reconstruction, undo, redo,
 // cancelled reconstructions and new branches share exactly one definition
 // of which historical choices remain effective.
 const done=history.done as AuditRow[];
 const draws=rows.filter(row=>row.action==='resolve_tie');
 const lastStart=done.findLastIndex(row=>row.action==='start');
 // Simulations inherit a paused order without a local `start` audit entry.
 const active=lastStart>=0?done.slice(lastStart+1):done;
 const awardKeys=new Set(ctx.awards.map(a=>a.member_id+'|'+a.cycle_date));
 const accounted=new Set<string>();
 const indices=new Map(rows.map((row,i)=>[row.id,i]));
 const events:{sequence:number;item:ElectionTimelineItem}[]=[];
 // Warnings are stored as the full set after each decision; show only those
 // that a decision introduced, not every later repetition of the same one.
 let previousWarnings=new Set<string>();
 if(state){
  for(const row of active){
   if(!['choose','choose_joint','advance','defer','reconstruction_step','register_joint','cancel_joint'].includes(row.action))continue;
   const before=parsed(row,'before'),after=parsed(row,'after');
   const previous=before?.state as ElectionState|undefined;
   if(!previous)continue;
   if(row.action==='register_joint'||row.action==='cancel_joint'){
    const agreement=after?.joint;
    if(agreement&&Number.isInteger(agreement.round)&&Array.isArray(agreement.members))events.push({sequence:indices.get(row.id)??0,item:{id:row.id,kind:'joint',round:agreement.round,createdAt:row.created_at,memberIds:agreement.members,choices:[],deferredTurns:0,ties:[],jointAction:row.action}});
    continue;
   }
   const reconstructed=row.action==='reconstruction_step';
   const kind=reconstructed?after?.kind:row.action;
   const round=roundAt(row,ctx);
   const choices:LoggedChoice[]=(Array.isArray(after?.choices)?after.choices:[])
    .filter((choice:any)=>typeof choice?.member_id==='string'&&typeof choice?.cycle_date==='string'&&awardKeys.has(choice.member_id+'|'+choice.cycle_date));
   for(const choice of choices)accounted.add(choice.member_id+'|'+choice.cycle_date);
   let turn:ReturnType<typeof currentTurn>|null=null;
   if(reconstructed)try{
    turn=currentTurn({...ctx,awards:before.awards??ctx.awards,requests:before.requests??ctx.requests},previous);
   }catch{turn=null;}
   const memberIds:string[]=kind==='defer'
    ?[reconstructed?turn?.memberId:after?.memberId].filter((id):id is string=>typeof id==='string')
    :[...new Set(choices.map(choice=>choice.member_id))];
   if(kind==='resolve_tie'){
    const order=after?.order;
    if(!Array.isArray(order)||order.length<2)continue;
    events.push({sequence:indices.get(row.id)??0,item:{
     id:row.id,kind:'tie',round,createdAt:row.created_at,
     memberIds:order,choices:[],deferredTurns:0,ties:[],method:'external',order
    }});
    continue;
   }
   if(kind==='defer'&&!memberIds.length)continue;
   if(kind!=='defer'&&!choices.length)continue;
   const ties:ElectionTimelineItem['ties']=[];
   if(round!==null)for(const memberId of memberIds){
    const group=previous.tieGroups?.find(group=>group.includes(memberId));
    if(!group)continue;
    const order=orderForRound(previous,round-1).filter(id=>group.includes(id));
    ties.push({memberId,position:order.indexOf(memberId)+1,total:group.length,order});
   }
   let introduced:{code:string;message:string;period?:number}[]=[];
   if(Array.isArray(after?.warnings)){
    introduced=after.warnings.filter((w:any)=>!previousWarnings.has(w.code));
    previousWarnings=new Set(after.warnings.map((w:any)=>w.code));
   }
   events.push({sequence:indices.get(row.id)??0,item:{
    id:row.id,kind:kind==='defer'?'defer':'choice',round,createdAt:row.created_at,
    memberIds,choices,deferredTurns:memberIds.length===1?(previous.credits?.[memberIds[0]]??0):0,ties,
    ...(after?.impact?{impact:{policyVersion:after.impact.policyVersion,status:after.impact.status,
     campaignVersionBefore:after.impact.campaignVersionBefore,campaignVersionAfter:after.impact.campaignVersionAfter,
     changes:after.impact.changes,events:after.impact.events}}:{}),
    ...(introduced.length?{warnings:introduced}:{})
   }});
  }
  for(const row of draws){
   const resolution=parsed(row,'after')?.resolution;
   if(!resolution||!Array.isArray(resolution.order)||!state.tieResolutions?.some(r=>
    r.at===resolution.at&&r.method===resolution.method&&r.order.join('|')===resolution.order.join('|')))continue;
   events.push({sequence:indices.get(row.id)??0,item:{
    id:row.id,kind:'tie',round:roundAt(row,ctx),createdAt:row.created_at,
    memberIds:resolution.order,choices:[],deferredTurns:0,ties:[],
    method:resolution.method,order:resolution.order,anticipated:resolution.anticipated===true
   }});
  }
 }
 for(const [i,award] of ctx.awards.entries()){
  const key=award.member_id+'|'+award.cycle_date;
  if(accounted.has(key))continue;
  events.push({sequence:-i-1,item:{
   id:'legacy-'+award.id,kind:'legacy',round:null,createdAt:'',
   memberIds:[award.member_id],choices:[{member_id:award.member_id,cycle_date:award.cycle_date}],
   deferredTurns:0,ties:[]
  }});
 }
 return events.sort((a,b)=>b.sequence-a.sequence).map(entry=>entry.item);
}


/**
 * The public history is an explicit allowlist, never a serialized audit event.
 * In particular, undo/reconstruction snapshots, availability impacts, internal
 * warnings, actors and preference data must not leave the server.
 */
export type PublicElectionTimelineItem=Pick<ElectionTimelineItem,
 'id'|'kind'|'round'|'memberIds'|'choices'|'deferredTurns'|'method'|'order'> & {automatic?:true};

export function publicElectionTimeline(items:ElectionTimelineItem[],rows:Pick<AuditRow,'id'|'action'>[]):PublicElectionTimelineItem[]{
 const automaticallyChosen=new Set(rows.filter(row=>row.action==='advance').map(row=>row.id));
 return items.map(item=>({
  id:item.id,kind:item.kind,round:item.round,
  memberIds:[...item.memberIds],
  choices:item.choices.map(({member_id,cycle_date})=>({member_id,cycle_date})),
  deferredTurns:item.deferredTurns,
  ...(item.kind==='tie'&&item.method?{method:item.method}:{}),
  ...(item.kind==='tie'&&item.order?{order:[...item.order]}:{}),
  ...(item.kind==='choice'&&automaticallyChosen.has(item.id)?{automatic:true as const}:{})
 }));
}
