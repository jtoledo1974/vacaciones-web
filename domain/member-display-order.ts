/** Display-only sorting of the CTA summary. Awards in request order arrive from the effective choice timeline. */
export type MemberOrder='request'|'points';
export type CycleOrder='chronological'|'request';

/** Keep the original selection priority on ties. */
export function orderMemberIds(ids:readonly string[],totals:ReadonlyMap<string,number>,mode:MemberOrder):string[]{
 if(mode==='request')return [...ids];
 return ids.map((id,index)=>({id,index,total:totals.get(id)??0}))
  .sort((a,b)=>a.total-b.total||a.index-b.index).map(row=>row.id);
}

/** Keep effective selection order for 'request', including simultaneous choices. */
export function orderMemberAwards<A extends {cycle_date:string}>(awards:readonly A[],mode:CycleOrder):A[]{
 return mode==='chronological'?[...awards].sort((a,b)=>a.cycle_date.localeCompare(b.cycle_date)):[...awards];
}
