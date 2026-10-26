import type {Config} from './calendar.ts';
import type {Member,Award} from './vacations.ts';
import type {OccupancyRules,PolicyCampaign} from './occupancy.ts';
import {policyState2027,cyclesEntitlement2027} from './election-2027.ts';
import {
  OCCUPANCY_POLICY_2027,evaluate2027Candidate,evaluate2027Final,canComplete2027,immediate2027Issues,partialAssessment2027,permitCounts2027
} from './policy-2027.ts';
import {
  availabilityByCycle,recordedAvailabilityByCycle2027,restoredAvailabilityByCycle2027,availabilityImpact,previewChoiceImpact,compactAvailability
} from './availability-2027.ts';
import {hr2027FourthExcluded} from './hr-2027.ts';

export type * from './occupancy.ts';

export type VacationPolicy = {
  /** Cycles a member must take this year. */
  entitlement(config:Config,member:Pick<Member,'code'>):number;
  occupancy:OccupancyRules|null;
};

const LEGACY:VacationPolicy = {
  entitlement:config=>config.cyclesPerPerson,
  occupancy:null
};

const LECS_2027:VacationPolicy = {
  entitlement:cyclesEntitlement2027,
  occupancy:{
    version:OCCUPANCY_POLICY_2027,
    authority:'RRHH 2027',
    name:'normas 2027',
    budgets:{commit:2000,options:{total:256,perCandidate:32},review:500},
    state:(c,members,awards)=>policyState2027(c.year,c.team,c.config,members,awards as Award[]),
    cycleMaximum:(c,date)=>Math.min(c.config.specialQuotas?.[date]??4,hr2027FourthExcluded(c.team,date)?3:4),
    evaluateCandidate:(state,choices,o={})=>
      evaluate2027Candidate(state,choices,o.maxChecks,o.witness,o.warnings,{exact:o.exact}),
    evaluateFinal:state=>evaluate2027Final(state),
    canComplete:(state,o={})=>canComplete2027(state,o),
    immediateIssues:immediate2027Issues,
    partialAssessment:(state,o={})=>partialAssessment2027(state,o.maxChecks),
    availability:availabilityByCycle,
    recordedAvailability:recordedAvailabilityByCycle2027,
    restoredAvailability:restoredAvailabilityByCycle2027,
    impact:availabilityImpact,
    previewChoiceImpact,
    permitReport:(state,o={})=>permitCounts2027(state,o.maxChecks),
    compact:compactAvailability
  }
};

const POLICIES:Record<number,VacationPolicy> = {2027:LECS_2027};

/** The rules that govern a campaign year. Generic code must ask this, not test the year. */
export function policyFor(year:number):VacationPolicy {
  return POLICIES[year]??LEGACY;
}

/** The year's occupancy engine, or null for years that use legacy quotas. */
export function occupancyFor(year:number):OccupancyRules|null {
  return policyFor(year).occupancy;
}

/** The policy view of a stored campaign row and its configuration. */
export function campaignOf(row:{year:number;team_id:string},config:Config):PolicyCampaign {
  return {year:row.year,team:row.team_id,config};
}
