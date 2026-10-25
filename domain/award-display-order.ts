/**
 * Show effective selections in the order they happened, regardless of the
 * storage order of the award rows (which is not specified by SQL).
 *
 * Timeline events arrive newest first. Undo, redo and reconstruction are
 * already reflected in that effective timeline. Untraced imports/manual
 * awards cannot be dated reliably: keep their incoming order before the
 * traced choices instead of inventing their history.
 */
export type AwardReference={member_id:string;cycle_date:string};
export type ChoiceTimelineEvent={kind:string;choices:AwardReference[]};

function awardKey(award:AwardReference):string{
 return JSON.stringify([award.member_id,award.cycle_date]);
}

/** Reorder only for display; never mutate awards used by allocation rules. */
export function orderAwardsBySelection<A extends AwardReference>(
 awards:readonly A[],newestFirstTimeline:readonly ChoiceTimelineEvent[]|null|undefined
):A[]{
 const positions=new Map<string,number>();
 for(const event of [...(newestFirstTimeline??[])].reverse()){
  if(event.kind!=='choice')continue;
  for(const choice of event.choices){
   const key=awardKey(choice);
   if(!positions.has(key))positions.set(key,positions.size);
  }
 }
 return [...awards].sort((a,b)=>{
  const first=positions.get(awardKey(a)),second=positions.get(awardKey(b));
  if(first===undefined)return second===undefined?0:-1;
  if(second===undefined)return 1;
  return first-second;
 });
}
