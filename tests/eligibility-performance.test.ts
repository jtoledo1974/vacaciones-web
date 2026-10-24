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

test('dense occupancy: second and third cupos produce the same eligibility as full Excel-derived recalculation',()=>{
 const config=defaultConfig(2026);
 const members=Array.from({length:20},(_,i)=>({id:'ATC'+i,code:'ATC'+i,seniority:''}));
 const dates=calendar(2026,'C',config).map(c=>c.date);
 const ctx:ElectionContext={year:2026,team:'C',config,members,requests:[],awards:[]};
 const counts=new Map(members.map(m=>[m.id,0]));
 const add=(id:string,date:string)=>{
  ctx.awards.push({id:'award'+ctx.awards.length,member_id:id,cycle_date:date});
  counts.set(id,counts.get(id)!+1);
 };
 // Fill 45 cycles to the standard base of two before exercising surplus cups.
 for(let round=0;round<2;round++)for(const date of dates){
  const member=members.find(m=>counts.get(m.id)!<6&&!ctx.awards.some(a=>a.member_id===m.id&&a.cycle_date===date)&&reference(ctx,m.id,[date]).length===0);
  assert.ok(member,`base cycle ${date} needs a legal assignee`);
  add(member!.id,date);
 }
 assert.equal(ctx.awards.length,90);
 let thirdCups=0;
 for(const date of dates){
  const member=members.find(m=>counts.get(m.id)!<6&&!ctx.awards.some(a=>a.member_id===m.id&&a.cycle_date===date)&&reference(ctx,m.id,[date]).length===0);
  if(member){add(member.id,date);thirdCups++;}
 }
 assert.ok(thirdCups>0);
 const baseline=calculate(2026,'C',config,members,ctx.requests,ctx.awards);
 assert.deepEqual(baseline.issues,[]);
 const fast=createChoiceChecker(ctx,baseline);
 for(const member of members){
  for(const date of dates)assert.deepEqual(fast(member.id,[date]),reference(ctx,member.id,[date]),`dense: ${member.id} ${date}`);
 }
});

test('unchanged relation capacity does not mask global quotas or explicit extra HR limits',()=>{
 const config=defaultConfig(2026);
 const members=Array.from({length:5},(_,i)=>({id:'X'+i,code:'X'+i,seniority:''}));
 const dates=calendar(2026,'C',config).map(c=>c.date);
 const ctx:ElectionContext={year:2026,team:'C',config,members,requests:[],awards:[]};
 config.specialQuotas={[dates[0]]:1,[dates[1]]:4};
 ctx.awards=[{id:'a',member_id:'X0',cycle_date:dates[0]},{id:'b',member_id:'X1',cycle_date:dates[1]},{id:'c',member_id:'X2',cycle_date:dates[1]},{id:'d',member_id:'X3',cycle_date:dates[1]}];
 const fast=createChoiceChecker(ctx);
 for(const choices of [[dates[0]],[dates[1]],[dates[1],dates[2]],[dates[0],dates[1]],[dates[2],dates[3]]])
  assert.deepEqual(fast('X4',choices),reference(ctx,'X4',choices));
});

test('preverano 2027 B: 19 ciclos con tres plazas agotan los extracupos no estivales al incluir una cuarta plaza autorizada',()=>{
 const config=defaultConfig(2027);
 config.excludeLast=false;
 const dates=calendar(2027,'B',config);
 assert.equal(dates.length,46);
 assert.equal(dates[0].date,'2027-01-01');
 assert.deepEqual([0,1,2].map(period=>dates.filter(c=>c.period===period).length),[19,16,11]);
 // Three individual RRHH exceptions: one pre-summer and two in summer.
 config.specialQuotas={[dates[1].date]:4,[dates[19].date]:4,[dates[20].date]:4};
 // Pseudonymous transcription of 69 choices: 9 members have four cycles,
 // the other 11 have three. No real controller names are stored in this test.
 const assignments=[
  [0,1,2],[3,4,5,2],[0,1,6],[7,8,9],[10,11,12],[13,14,15],
  [16,17,18],[4,5,19],[3,1,2],[0,8,6],[7,11,9],[10,15,12],
  [13,14,17],[16,19,18],[3,4,5],[0,1,2],[8,9,6],[7,11,12],
  [13,10,15],[14,16,17,18],[3,4,5,19],[8,9,6]
 ];
 const members=Array.from({length:20},(_,i)=>({id:'P'+i,code:'P'+i,seniority:''}));
 const awards:Award[]=assignments.flatMap((ids,index)=>ids.map((i,slot)=>({
  id:'prior-'+index+'-'+slot,member_id:'P'+i,cycle_date:dates[index].date
 })));
 const ctx:ElectionContext={year:2027,team:'B',config,members,requests:[],awards};
 assert.equal(awards.length,69);
 const result=calculate(2027,'B',config,members,ctx.requests,awards);
 assert.deepEqual(result.issues,[]);
 assert.equal(result.totals.conventionWinter,20);
 assert.equal(result.totals.conventionSummer,8);
 assert.equal(result.cycles.filter(c=>c.period===0).reduce((n,c)=>n+Math.max(0,c.occupied-2),0),20);
 assert.equal(result.cycles.filter(c=>c.period===1).reduce((n,c)=>n+Math.max(0,c.occupied-2),0),5);
 const post=dates.find(c=>c.period===2)!.date;
 const twoMore:Award[]=[
  {id:'post-a',member_id:'P0',cycle_date:post},
  {id:'post-b',member_id:'P1',cycle_date:post}
 ];
 const next={...ctx,awards:[...awards,...twoMore]};
 const nextResult=calculate(2027,'B',config,members,ctx.requests,next.awards);
 assert.deepEqual(nextResult.issues,[]);
 // Post-summer still has 2 standard seats, but a third is illegal: the
 // winter surplus is already spent before reaching the fourth round.
 const issues=createChoiceChecker(next,nextResult)('P2',[post]);
 assert.ok(issues.some(issue=>issue.includes('extracupos de no verano')));
 assert.deepEqual(issues,reference(next,'P2',[post]));
 // The summer sector retains three of its eight authorized extra seats.
 assert.equal(8-result.cycles.filter(c=>c.period===1).reduce((n,c)=>n+Math.max(0,c.occupied-2),0),3);
});
