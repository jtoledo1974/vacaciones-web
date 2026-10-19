import {currentTurn,orderForRound,type ElectionContext,type ElectionState} from '../domain/election.ts';

type AuditRow={id:string;action:string;before_json:string|null;after_json:string|null;created_at:string};
type LoggedChoice={member_id:string;cycle_date:string};
export type ElectionTimelineItem={
 id:string;kind:'choice'|'defer'|'tie'|'legacy';round:number|null;createdAt:string;
 memberIds:string[];choices:LoggedChoice[];deferredTurns:number;
 ties:{memberId:string;position:number;total:number;order:string[]}[];
 method?:'random'|'external';order?:string[];
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
 const done:AuditRow[]=[],redo:AuditRow[]=[],draws:AuditRow[]=[];
 for(const row of rows){
  if(row.action==='election_undo'){
   const undone=done.pop();if(undone)redo.push(undone);
  }else if(row.action==='election_redo'){
   const restored=redo.pop();if(restored)done.push(restored);
  }else if(row.action==='resolve_tie'){
   draws.push(row);redo.length=0;
  }else if(parse(row.before_json)?.format==='election-undo-v1'){
   done.push(row);redo.length=0;
  }
 }
 const lastStart=done.findLastIndex(row=>row.action==='start');
 const active=lastStart>=0?done.slice(lastStart+1):[];
 const awardKeys=new Set(ctx.awards.map(a=>a.member_id+'|'+a.cycle_date));
 const accounted=new Set<string>();
 const indices=new Map(rows.map((row,i)=>[row.id,i]));
 const events:{sequence:number;item:ElectionTimelineItem}[]=[];
 if(state){
  for(const row of active){
   if(!['choose','choose_joint','advance','defer'].includes(row.action))continue;
   const before=parse(row.before_json),after=parse(row.after_json);
   const previous=before?.state as ElectionState|undefined;
   if(!previous)continue;
   const round=roundAt(row,ctx);
   const choices:LoggedChoice[]=(Array.isArray(after?.choices)?after.choices:[])
    .filter((choice:any)=>typeof choice?.member_id==='string'&&typeof choice?.cycle_date==='string'&&awardKeys.has(choice.member_id+'|'+choice.cycle_date));
   for(const choice of choices)accounted.add(choice.member_id+'|'+choice.cycle_date);
   const memberIds:string[]=row.action==='defer'?[after?.memberId].filter((id):id is string=>typeof id==='string'):
    [...new Set(choices.map(choice=>choice.member_id))];
   if(row.action==='defer'&&!memberIds.length)continue;
   if(row.action!=='defer'&&!choices.length)continue;
   const ties:ElectionTimelineItem['ties']=[];
   if(round!==null)for(const memberId of memberIds){
    const group=previous.tieGroups?.find(group=>group.includes(memberId));
    if(!group)continue;
    const order=orderForRound(previous,round-1).filter(id=>group.includes(id));
    ties.push({memberId,position:order.indexOf(memberId)+1,total:group.length,order});
   }
   events.push({sequence:indices.get(row.id)??0,item:{
    id:row.id,kind:row.action==='defer'?'defer':'choice',round,createdAt:row.created_at,
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
    method:resolution.method,order:resolution.order
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
