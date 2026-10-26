import type { Config } from './calendar.ts';
import type { Member, Award } from './vacations.ts';
import type { OccupancyRules, PolicyCampaign, PolicyState, PolicyReview, ReviewOptions } from './occupancy.ts';
import { policyState2027, cyclesEntitlement2027 } from './election-2027.ts';
import {
  OCCUPANCY_POLICY_2027,
  evaluate2027Candidate,
  evaluate2027Final,
  canComplete2027,
  immediate2027Issues,
  partialAssessment2027,
  permitCounts2027,
  legalChoices2027,
} from './policy-2027.ts';
import {
  availabilityByCycle,
  recordedAvailabilityByCycle2027,
  restoredAvailabilityByCycle2027,
  availabilityImpact,
  previewChoiceImpact,
  compactAvailability,
} from './availability-2027.ts';
import { hr2027FourthExcluded } from './hr-2027.ts';

export type * from './occupancy.ts';

export type VacationPolicy = {
  /** Cycles a member must take this year. */
  entitlement(config: Config, member: Pick<Member, 'code'>): number;
  occupancy: OccupancyRules | null;
};

const LEGACY: VacationPolicy = {
  entitlement: (config) => config.cyclesPerPerson,
  occupancy: null,
};

const BUDGETS_2027 = { commit: 2000, options: { total: 256, perCandidate: 32 }, review: 500 };

const OCCUPANCY_2027: OccupancyRules = {
  version: OCCUPANCY_POLICY_2027,
  authority: 'RRHH 2027',
  name: 'normas 2027',
  budgets: BUDGETS_2027,
  state: (c, members, awards) => policyState2027(c.year, c.team, c.config, members, awards as Award[]),
  cycleMaximum: (c, date) => Math.min(c.config.specialQuotas?.[date] ?? 4, hr2027FourthExcluded(c.team, date) ? 3 : 4),
  legalChoices: (state, memberId, o = {}) => legalChoices2027(state, memberId, o, BUDGETS_2027),
  review: (c, state, o) => proofReview(OCCUPANCY_2027, c, state, o, { min: 1, base: 2 }),
  evaluateCandidate: (state, choices, o = {}) =>
    evaluate2027Candidate(state, choices, o.maxChecks, o.witness, o.warnings, { exact: o.exact }),
  evaluateFinal: (state) => evaluate2027Final(state),
  canComplete: (state, o = {}) => canComplete2027(state, o),
  immediateIssues: immediate2027Issues,
  partialAssessment: (state, o = {}) => partialAssessment2027(state, o.maxChecks),
  availability: availabilityByCycle,
  recordedAvailability: recordedAvailabilityByCycle2027,
  restoredAvailability: restoredAvailabilityByCycle2027,
  impact: availabilityImpact,
  previewChoiceImpact,
  permitReport: (state, o = {}) => permitCounts2027(state, o.maxChecks),
  compact: compactAvailability,
};

const LECS_2027: VacationPolicy = {
  entitlement: cyclesEntitlement2027,
  occupancy: OCCUPANCY_2027,
};

/**
 * Review shared by proof-based engines: per-cycle maxima, then the final
 * assessment of a complete allocation or the completion proof of a partial
 * one. Partial states are not invalid merely because cycles lack their FINAL
 * minimum; `shape` gives the minimum and base shown for every cycle.
 */
export function proofReview(
  rules: OccupancyRules,
  campaign: PolicyCampaign,
  state: PolicyState,
  options: ReviewOptions,
  shape: { min: number; base: number },
): PolicyReview {
  const issues: string[] = [];
  const occupiedByDate = new Map<string, number>(),
    takenByMember = new Map<string, number>();
  for (const a of state.awards) {
    occupiedByDate.set(a.cycle_date, (occupiedByDate.get(a.cycle_date) ?? 0) + 1);
    takenByMember.set(a.member_id, (takenByMember.get(a.member_id) ?? 0) + 1);
  }
  const limits = state.cycles.map((cycle) => {
    const max = rules.cycleMaximum(campaign, cycle.date);
    if ((occupiedByDate.get(cycle.date) ?? 0) > max)
      issues.push(cycle.date + ': supera el cupo máximo autorizado por RRHH');
    return { date: cycle.date, min: shape.min, base: shape.base, max };
  });
  const complete = state.members.every((m) => (takenByMember.get(m.id) ?? 0) === m.entitlement);
  const final = complete ? rules.evaluateFinal(state) : null;
  // Warnings that every completion would trigger (summer-total deviation) persist after each adjudication.
  // They are not inferred from provisional occupation (which may still
  // be completed), and they never turn into blocking errors.
  const partial =
    !options.skipProof && !complete && options.structurallyValid && !issues.length && state.awards.length
      ? rules.partialAssessment(state, { maxChecks: rules.budgets.review })
      : null;
  if (final) issues.push(...final.issues.map((i) => i.message));
  else if (partial?.completion.status === 'impossible')
    issues.push('Las adjudicaciones actuales no permiten completar las vacaciones restantes');
  return {
    limits,
    issues,
    warnings: final?.warnings ?? partial?.warnings ?? [],
    completionStatus: final ? (final.valid ? 'possible' : 'impossible') : (partial?.completion.status ?? 'not-checked'),
  };
}

const POLICIES: Record<number, VacationPolicy> = { 2027: LECS_2027 };

/** The rules that govern a campaign year. Generic code must ask this, not test the year. */
export function policyFor(year: number): VacationPolicy {
  return POLICIES[year] ?? LEGACY;
}

/**
 * Tests only: plug a policy for a year and get back the undo. Production
 * policies are listed in POLICIES above; nothing else may call this.
 */
export function registerPolicy(year: number, policy: VacationPolicy): () => void {
  const had = Object.hasOwn(POLICIES, year),
    previous = POLICIES[year];
  POLICIES[year] = policy;
  return () => {
    if (had) POLICIES[year] = previous;
    else delete POLICIES[year];
  };
}

/** The year's occupancy engine, or null for years that use legacy quotas. */
export function occupancyFor(year: number): OccupancyRules | null {
  return policyFor(year).occupancy;
}

/** The policy view of a stored campaign row and its configuration. */
export function campaignOf(row: { year: number; team_id: string }, config: Config): PolicyCampaign {
  return { year: row.year, team: row.team_id, config };
}
