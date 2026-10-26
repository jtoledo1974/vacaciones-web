import type {ElectionState} from '../domain/election.ts';
import {turnsUntil} from '../domain/sequence.ts';
export {peopleAhead,turnsUntil} from '../domain/sequence.ts';

type Cycle={date:string;end:string;score:number;occupied:number;max:number};
type Award={member_id:string;cycle_date:string};
type Preference={member_id:string;dates:string[];persistent?:boolean;active?:boolean;mode?:'immediate'|'wait'|'manual';waitMinutes?:number;labels?:Record<string,string>};
type Turn={memberId:string|null;participants?:string[];needed?:number;round?:number};

export type MyElectionInput={
 myMemberId:string|null|undefined;
 cyclesPerPerson:number;
 cycles:Cycle[];
 awards:Award[];
 preferences:Preference[];
 /** How many of the people ahead have an active list; the server sends only this count. */
 automaticAhead?:number|null;
 state:ElectionState|null|undefined;
 turn:Turn|null|undefined;
};

export type MyListState='none'|'active-next'|'active-all'|'used'|'paused'|'manual';
export type MyListEntry={date:string;end:string;score:number;position:number;mine:boolean;free:number;label:string};

export type MyElection={
 phase:'not-started'|'paused'|'my-turn'|'waiting'|'finished'|'complete';
 turnsAhead:number|null;
 automaticAhead:number|null;
 needed:number;
 round:number|null;
 cycles:{date:string;end:string;score:number}[];
 entitlement:number;
 list:{state:MyListState;entries:MyListEntry[];unavailable:number;firstViable:string|null;mode:'immediate'|'wait'|'manual';waitMinutes:number;persistent:boolean};
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
  return {date,end:c?.end??date,score:c?.score??0,position:i+1,mine:cycles.some(x=>x.date===date),free:c?Math.max(0,c.max-c.occupied):0,label:pref?.labels?.[date]??''};
 });
 const viable=entries.filter(e=>!e.mine&&e.free>0);
 const listState:MyListState=!entries.length?'none'
  :pref?.active===false?'used'
  :pref?.mode==='manual'?'manual'
  :(state as any)?.automaticPaused?'paused'
  :pref?.persistent?'active-all':'active-next';
 const list={state:listState,entries,unavailable:entries.filter(e=>!e.mine&&e.free===0).length,firstViable:viable[0]?.date??null,mode:pref?.mode??'immediate',waitMinutes:pref?.waitMinutes??0,persistent:!!pref?.persistent};

 const base={cycles,entitlement,list,needed:0,round:turn?.round??null,turnsAhead:null as number|null,automaticAhead:input.automaticAhead??null};
 if(cycles.length>=entitlement)return {...base,phase:state?.status==='complete'?'complete':'finished'};
 if(!state)return {...base,phase:'not-started'};
 if(state.status==='complete')return {...base,phase:'complete'};
 if(state.status!=='active')return {...base,phase:'paused'};
 if(turn?.memberId&&(turn.participants??[turn.memberId]).includes(me))
  return {...base,phase:'my-turn',needed:turn.needed??1,turnsAhead:0};

 return {...base,phase:'waiting',turnsAhead:turnsUntil(state,input.awards,entitlement,me)};
}

/** When lists ahead resolve instantly, the wait depends only on those who
 * choose by hand. At least one does (usually whoever is choosing now): if all
 * of them had active lists, their turns would already be resolved. */
export function aheadNote(me:Pick<MyElection,'phase'|'turnsAhead'|'automaticAhead'>):string|null{
 const total=me.turnsAhead,auto=me.automaticAhead;
 if(me.phase!=='waiting'||total===null||!auto||auto>=total)return null;
 const byHand=total-auto;
 if(byHand===1)return 'Tu turno puede llegar en cuanto termine quien está eligiendo ahora: '
  +(auto===1?'la otra persona que va delante elegirá':'las otras '+auto+' personas que van delante elegirán')+' automáticamente con sus preferencias.';
 return auto+' de las '+total+' personas que van delante '+(auto===1?'elegirá':'elegirán')+' automáticamente con sus preferencias. Tu turno puede llegar en cuanto elijan las otras '+byHand+'.';
}

/** «2 h», «1 h 30 min», «45 min». */
export function formatWait(minutes:number):string{
 const h=Math.floor(minutes/60),m=minutes%60;
 return h&&m?`${h} h ${m} min`:h?`${h} h`:`${m} min`;
}
/** Wall-clock time in Spain, where every team works: «14:30», or «mañana 09:15». */
export function formatDeadline(iso:string,now=Date.now()):string{
 const zone='Europe/Madrid',day=(t:number)=>new Date(t).toLocaleDateString('es-ES',{timeZone:zone});
 const time=new Date(iso).toLocaleTimeString('es-ES',{hour:'2-digit',minute:'2-digit',timeZone:zone});
 const t=Date.parse(iso);
 return day(t)===day(now)?time:day(t)===day(now+86400_000)?'mañana '+time:new Date(t).toLocaleDateString('es-ES',{weekday:'long',timeZone:zone})+' '+time;
}
/** «quedan 1 h 12 min», rounded up to the minute so it never reads 0 before the deadline. */
export function remainingText(iso:string,now=Date.now()):string|null{
 const left=Math.ceil((Date.parse(iso)-now)/60_000);
 return left>0?'quedan '+formatWait(left):null;
}
