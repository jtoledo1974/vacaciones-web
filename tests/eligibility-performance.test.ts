import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defaultConfig} from '../domain/defaults.ts';
import {calendar} from '../domain/calendar.ts';
import {calculate,type Award} from '../domain/vacations.ts';
import {createChoiceChecker,type ElectionContext} from '../domain/election.ts';

// The independent reference deliberately calls the original complete calculator,
// including all coupled relationQuotas maxima and RRHH period limits.
function reference(ctx:ElectionContext,id:string,dates:string[]):string[]{
 if(!ctx.members.some(m=>m.id===id))return ['Controlador ajeno a la campaña'];
 if(new Set(dates).size!==dates.length)return ['No se puede elegir el mismo ciclo dos veces'];
 if(dates.some(date=>ctx.awards.some(a=>a.member_id===id&&a.cycle_date===date)))return ['Este controlador ya tiene uno de esos ciclos'];
 const awards=[...ctx.awards,...dates.map((date,i)=>({id:'candidate-'+i,member_id:id,cycle_date:date}))];
 return calculate(ctx.year,ctx.team,ctx.config,ctx.members,ctx.requests,awards).issues;
}

test('fast eligibility matches complete calculation across a real 45-cycle calendar and dynamic quotas',()=>{
 const config=defaultConfig(2026),members=Array.from({length:20},(_,i)=>({id:'P'+i,code:'P'+i,seniority:''}));
 const ctx:ElectionContext={year:2026,team:'C',config,members,awards:[],requests:[]};
 const dates=calendar(ctx.year,ctx.team,config).map(c=>c.date);
 const pick=(id:string,chosen:string[])=>{ctx.awards.push(...chosen.map((cycle_date,i)=>({id:id+'-'+ctx.awards.length+'-'+i,member_id:id,cycle_date})));};
 // Include non-summer and summer demand, two-per-cycle, and a candidate
 // third cupo that depends on available global extras.
 for(let step=0;step<24;step++){
  const id=members[step%members.length].id;
  const available=dates.find((date,index)=>index%3===step%3&&!reference(ctx,id,[date]).length);
  if(available)pick(id,[available]);
  const baseline=calculate(ctx.year,ctx.team,config,members,ctx.requests,ctx.awards);
  assert.deepEqual(baseline.issues,[]);
  const fast=createChoiceChecker(ctx,baseline);
  for(const memberId of [id,members[(step+3)%members.length].id]){
   for(const date of dates){
    assert.deepEqual(fast(memberId,[date]),reference(ctx,memberId,[date]),`step=${step} member=${memberId} cycle=${date}`);
   }
   for(let j=0;j<12;j++){
    const choices=[dates[(step+j)%dates.length],dates[(step+17+j)%dates.length]];
    assert.deepEqual(fast(memberId,choices),reference(ctx,memberId,choices));
    assert.deepEqual(fast(memberId,[...choices,dates[(step+29+j)%dates.length]]),reference(ctx,memberId,[...choices,dates[(step+29+j)%dates.length]]));
   }
  }
 }
});

test('fast eligibility respects explicit one-person RRHH caps and invalid imported dates',()=>{
 const config=defaultConfig(2026);
 const members=['A','B','C'].map(id=>({id,code:id,seniority:''}));
 const dates=calendar(2026,'C',config).map(c=>c.date);
 config.specialQuotas={[dates[0]]:1,[dates[1]]:2,[dates[2]]:3};
 const awards:Award[]=[{id:'a',member_id:'A',cycle_date:dates[0]},{id:'b',member_id:'A',cycle_date:dates[1]}];
 const ctx:ElectionContext={year:2026,team:'C',config,members,requests:[],awards};
 const fast=createChoiceChecker(ctx);
 for(const selections of [[dates[0]],[dates[1]],[dates[2]],[dates[0],dates[2]],[dates[2],dates[3],dates[4]],[dates[0],dates[0]],['1900-01-01'],[]]){
  assert.deepEqual(fast('B',selections),reference(ctx,'B',selections));
 }
 assert.deepEqual(fast('missing',[dates[2]]),reference(ctx,'missing',[dates[2]]));
});
