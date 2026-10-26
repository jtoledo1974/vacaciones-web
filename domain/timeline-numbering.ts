import type {ElectionTimelineItem} from './election-timeline-types.ts';

/** Count individual awarded cycles chronologically, before UI pagination. */
export function numberTimelineCycles(events:ElectionTimelineItem[]){
 const rounds=new Map<number,number>();
 const numbers=new Map<string,number[]>();
 for(const event of [...events].reverse()){
  if(event.round===null||event.kind!=='choice')continue;
  const start=rounds.get(event.round)??0;
  numbers.set(event.id,event.choices.map((_,i)=>start+i+1));
  rounds.set(event.round,start+event.choices.length);
 }
 return numbers;
}
