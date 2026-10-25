import {calendar, type Config} from './calendar.ts';
import {hr2027FourthExcluded} from './hr-2027.ts';
import type {Member,Award} from './vacations.ts';
import {summerTarget2027,type PolicyState} from './policy-2027.ts';

/** Exceptions are issued for named controllers by RRHH; no exception is inferred. */
export function cyclesEntitlement2027(config:Config,member:Pick<Member,'code'>):number {
  return config.individualEntitlements?.[member.code]?.cycles??config.cyclesPerPerson;
}

/** Compose campaign snapshot for the 2027 evaluator without changing legacy runs. */
export function policyState2027(year:number,team:string,config:Config,members:Member[],awards:Award[]):PolicyState {
  if(year!==2027)throw new Error('La política de ocupación 2027 no aplica a este ejercicio');
  const policyMembers=members.map(m=>({id:m.id,entitlement:cyclesEntitlement2027(config,m)}));
  return {
    cycles: calendar(year,team,config).map(c=>({
      date:c.date,
      period:c.period as 0|1|2,
      fourthExcluded:hr2027FourthExcluded(team,c.date),
      maximum:config.specialQuotas?.[c.date]
    })),
    members:policyMembers,
    awards:awards.map(a=>({member_id:a.member_id,cycle_date:a.cycle_date})),
    summerTotal:summerTarget2027(policyMembers)
  };
}
