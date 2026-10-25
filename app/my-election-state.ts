import {orderForRound,type ElectionState} from '../domain/election.ts';

type Cycle={date:string;end:string;score:number;occupied:number;max:number};
type Award={member_id:string;cycle_date:string};
type Preference={member_id:string;dates:string[];persistent?:boolean;active?:boolean};
type Turn={memberId:string|null;participants?:string[];needed?:number;round?:number};

export type MyElectionInput={
 myMemberId:string|null|undefined;
 cyclesPerPerson:number;
 cycles:Cycle[];
 awards:Award[];
 preferences:Preference[];
 state:ElectionState|null|undefined;
 turn:Turn|null|undefined;
};

export type MyListState='none'|'active-next'|'active-all'|'used'|'paused';
export type MyListEntry={date:string;end:string;score:number;position:number;mine:boolean;free:number};

export type MyElection={
 phase:'not-started'|'paused'|'my-turn'|'waiting'|'finished'|'complete';
 turnsAhead:number|null;
 needed:number;
 round:number|null;
 cycles:{date:string;end:string;score:number}[];
 entitlement:number;
 list:{state:MyListState;entries:MyListEntry[];unavailable:number;firstViable:string|null};
};

/**
 * Everything a controller needs to answer "when is my turn, what do I have and
 * what will my list do", derived from the campaign view already in the client.
 * turnsAhead counts people who still have cycles to choose before me; joint
 * agreements and deferrals can shift it, so the UI presents it as an estimate.
 */
export function myElection(input:MyElectionInput):MyElection|null{
 const me=input.myMemberId;
 if(!me)return null;
 const byDate=new Map(input.cycles.map(c=>[c.date,c]));
 const cycles=input.awards.filter(a=>a.member_id===me).map(a=>byDate.get(a.cycle_date)).filter((c):c is Cycle=>!!c)
  .sort((a,b)=>a.date.localeCompare(b.date)).map(({date,end,score})=>({date,end,score}));
 const entitlement=input.cyclesPerPerson;
 const state=input.state,turn=input.turn;

 const pref=input.preferences.find(p=>p.member_id===me);
 const entries:MyListEntry[]=(pref?.dates??[]).map((date,i)=>{
  const c=byDate.get(date);
  return {date,end:c?.end??date,score:c?.score??0,position:i+1,mine:cycles.some(x=>x.date===date),free:c?Math.max(0,c.max-c.occupied):0};
 });
 const viable=entries.filter(e=>!e.mine&&e.free>0);
 const listState:MyListState=!entries.length?'none'
  :pref?.active===false?'used'
  :(state as any)?.automaticPaused?'paused'
  :pref?.persistent?'active-all':'active-next';
 const list={state:listState,entries,unavailable:entries.filter(e=>!e.mine&&e.free===0).length,firstViable:viable[0]?.date??null};

 const base={cycles,entitlement,list,needed:0,round:turn?.round??null,turnsAhead:null as number|null};
 if(cycles.length>=entitlement)return {...base,phase:state?.status==='complete'?'complete':'finished'};
 if(!state)return {...base,phase:'not-started'};
 if(state.status==='complete')return {...base,phase:'complete'};
 if(state.status!=='active')return {...base,phase:'paused'};
 if(turn?.memberId&&(turn.participants??[turn.memberId]).includes(me))
  return {...base,phase:'my-turn',needed:turn.needed??1,turnsAhead:0};

 return {...base,phase:'waiting',turnsAhead:turnsUntil(state,input.awards,entitlement,me)};
}

/** People with cycles still to choose before `me`, from the current cursor.
 * null when `me` never comes up. Shared with the server's Push alerts. */
export function turnsUntil(state:ElectionState,awards:{member_id:string}[],entitlement:number,me:string):number|null{
 const counts=new Map<string,number>();
 for(const a of awards)counts.set(a.member_id,(counts.get(a.member_id)??0)+1);
 const n=state.order.length;
 let ahead=0;
 for(let cursor=state.cursor;cursor<state.cursor+n*(entitlement+1);cursor++){
  const id=orderForRound(state,Math.floor(cursor/n))[cursor%n];
  if(id===me)return ahead;
  if((counts.get(id)??0)<entitlement)ahead++;
 }
 return null;
}
