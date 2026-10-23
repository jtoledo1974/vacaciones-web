import {calendar, type Config} from './calendar.ts';
import {hr2027FourthExcluded} from './hr-2027.ts';
import type {Member,Award} from './vacations.ts';
import type {PolicyState} from './policy-2027.ts';

/** Compose campaign snapshot for the 2027 evaluator without changing legacy runs. */
export function policyState2027(year:number,team:string,config:Config,members:Member[],awards:Award[]):PolicyState {
  if(year!==2027)throw new Error('La política de ocupación 2027 no aplica a este ejercicio');
  return {
    cycles: calendar(year,team,config).map(c=>({
      date:c.date,
      period:c.period as 0|1|2,
      fourthExcluded:hr2027FourthExcluded(team,c.date)
    })),
    members:members.map(m=>({
      id:m.id,
      entitlement:config.cyclesPerPerson
    })),
    awards:awards.map(a=>({member_id:a.member_id,cycle_date:a.cycle_date}))
  };
}
