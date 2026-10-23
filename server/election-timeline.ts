import {currentTurn,orderForRound,type ElectionContext,type ElectionState} from '../domain/election.ts';
import {appliedAudit} from './reconstruction.ts';

type AuditRow={id:string;action:string;before_json:string|null;after_json:string|null;created_at:string};
type LoggedChoice={member_id:string;cycle_date:string};
export type ElectionTimelineItem={
 id:string;kind:'choice'|'defer'|'tie'|'legacy'|'joint';round:number|null;createdAt:string;
 memberIds:string[];choices:LoggedChoice[];deferredTurns:number;
 ties:{memberId:string;position:number;total:number;order:string[]}[];
 method?:'random'|'external';order?:string[];anticipated?:boolean;jointAction?:'register_joint'|'cancel_joint';
};

function parse(value:string|null):any{
 try{return value?JSON.parse(value):null;}catch{return null;}
}

function roundAt(row:AuditRow,ctx:ElectionContext):number|null{
 const before=parse(row.before_json),state=before?.state as ElectionState|null;
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
export function buildElectionTimeline(rows:AuditRow[],ctx:ElectionContext,state:ElectionState|null):ElectionTimelineItem[]{
 // Reuse the canonical audit replay so guided reconstruction, undo, redo,
 // cancelled reconstructions and new branches share exactly one definition
 // of which historical choices remain effective.
 const done=appliedAudit(rows).done as AuditRow[];
 const draws=rows.filter(row=>row.action==='resolve_tie');
 const lastStart=done.findLastIndex(row=>row.action==='start');
 // Simulations inherit a paused order without a local `start` audit entry.
 const active=lastStart>=0?done.slice(lastStart+1):done;
 const awardKeys=new Set(ctx.awards.map(a=>a.member_id+'|'+a.cycle_date));
 const accounted=new Set<string>();
 const indices=new Map(rows.map((row,i)=>[row.id,i]));
 const events:{sequence:number;item:ElectionTimelineItem}[]=[];
 if(state){
  for(const row of active){
   if(!['choose','choose_joint','advance','defer','reconstruction_step','register_joint','cancel_joint'].includes(row.action))continue;
   const before=parse(row.before_json),after=parse(row.after_json);
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
   events.push({sequence:indices.get(row.id)??0,item:{
    id:row.id,kind:kind==='defer'?'defer':'choice',round,createdAt:row.created_at,
    memberIds,choices,deferredTurns:memberIds.length===1?(previous.credits?.[memberIds[0]]??0):0,ties
   }});
  }
  for(const row of draws){
   const resolution=parse(row.after_json)?.resolution;
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
