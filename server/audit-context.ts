import type {Repository} from './repository.ts';

export type AuditRow={id:string;action:string;before_json:string|null;after_json:string|null;created_at:string};

// Parsed snapshots belong to the row objects of one read context. They are
// deliberately non-enumerable: serializing an audit row still returns its
// original persisted representation, never an extra copy of its private data.
function parsedRow(row:AuditRow):AuditRow{
 const result={...row};
 let before:any,after:any,hasBefore=false,hasAfter=false;
 Object.defineProperties(result,{
  parsedBefore:{get(){if(!hasBefore){before=row.before_json?JSON.parse(row.before_json):null;hasBefore=true;}return before;}},
  parsedAfter:{get(){if(!hasAfter){after=row.after_json?JSON.parse(row.after_json):null;hasAfter=true;}return after;}}
 });
 return result;
}
export function auditBefore(row:AuditRow):any{
 return Object.hasOwn(row,'parsedBefore')?(row as any).parsedBefore:row.before_json?JSON.parse(row.before_json):null;
}
export function auditAfter(row:AuditRow):any{
 return Object.hasOwn(row,'parsedAfter')?(row as any).parsedAfter:row.after_json?JSON.parse(row.after_json):null;
}

/** The canonical undo/redo replay, shared by history, reconstruction and timeline. */
export function appliedAudit(rows:any[]){
 const done:any[]=[],redo:{original:any;undo:any;index:number}[]=[];
 const byId=new Map(rows.map(row=>[row.id,row]));
 for(const row of rows){
  if(row.action==='election_undo'){
   // A manager's undo may skip newer private-list edits, so remove the entry it
   // targeted; rows without a recorded target always undid the newest entry.
   const target=auditAfter(row)?.undoTargetId,found=target?done.findIndex(e=>e.id===target):-1;
   const index=found>=0?found:done.length-1;
   if(index>=0)redo.push({original:done.splice(index,1)[0],undo:row,index});
  }else if(row.action==='election_redo'){
   const item=redo.pop();if(item)done.splice(Math.min(item.index,done.length),0,item.original);
  }else if(row.action==='reconstruction_start'){
   const after=auditAfter(row)??{},index=done.findIndex(e=>e.id===after.targetId);
   const keep=index>=0?index:after.keepCount;
   if(Number.isInteger(keep)&&keep>=0)done.splice(keep);redo.length=0;
  }else if(row.action==='reconstruction_back'){
   done.pop();redo.length=0;
  }else if(row.action==='reconstruction_cancel'){
   const after=auditAfter(row)??{};
   const index=done.findIndex(e=>e.id===after.targetId);
   const keep=index>=0?index:after.keepCount;
   if(Number.isInteger(keep)&&keep>=0)done.splice(keep);
   for(const id of after.originalIds??[]){const original=byId.get(id);if(original)done.push(original);}
   redo.length=0;
  }else if(row.before_json&&auditBefore(row).format==='election-undo-v1'){
   // Editing a list does not discard redo: undo and redo keep current lists.
   done.push(row);if(row.action!=='preferences')redo.length=0;
  }else if(row.action==='resolve_tie'){
   redo.length=0;
  }
 }
 return {done,undo:done.at(-1)??null,redo:redo.at(-1)?.undo??null,redoOriginal:redo.at(-1)?.original??null};
}

/** One immutable read snapshot per Service.view, never a cross-request cache. */
export class AuditContext{
 private loaded?:Promise<AuditRow[]>;
 private replayed?:Promise<ReturnType<typeof appliedAudit>>;
 constructor(private repo:Repository,readonly campaignId:string,readonly version:number){}
 rows():Promise<AuditRow[]>{
  return this.loaded??=this.repo.all<AuditRow>('SELECT id,action,before_json,after_json,created_at FROM audit WHERE campaign_id=? ORDER BY rowid ASC',[this.campaignId]).then(rows=>rows.map(parsedRow));
 }
 replay():Promise<ReturnType<typeof appliedAudit>>{
  return this.replayed??=this.rows().then(appliedAudit);
 }
}
