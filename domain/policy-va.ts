import type { Config } from './calendar.ts';
import type {
  AvailabilityImpact,
  AvailabilitySnapshot,
  CandidateAssessment,
  CycleAvailability,
  OccupancyRules,
  PolicyAward,
  PolicyCampaign,
  PolicyState,
  RuleProblem,
} from './occupancy.ts';
import type { Member } from './vacations.ts';

/**
 * Vacaciones de antigüedad (ADR 0002): one campaign a year on the reserved team `va`.
 * Units are single days with an HR daily quota; each person takes the days frozen in
 * their campaign membership, never the same day as their ordinary vacations. Two rounds:
 * one day first, then the rest. Days are independent of each other, so every proof is
 * direct: there is no completion search.
 */
export const VA_TEAM = 'va';
const VERSION = 'va-1';

/** The day quotas of the campaign, from HR (`va_quotas`), added by the server. */
const quotasOf = (campaign: PolicyCampaign) => campaign.external?.quotas ?? {};

function days(campaign: PolicyCampaign) {
  return Object.keys(quotasOf(campaign))
    .filter((date) => date.startsWith(campaign.year + '-') && quotasOf(campaign)[date] > 0)
    .sort()
    .map((date) => ({ date, end: date }));
}

/** Who already holds each day, who holds how many, and the days each member may not take. */
function tally(state: PolicyState) {
  const byDay = new Map<string, number>(),
    byMember = new Map<string, Set<string>>();
  for (const a of state.awards) {
    byDay.set(a.cycle_date, (byDay.get(a.cycle_date) ?? 0) + 1);
    const own = byMember.get(a.member_id) ?? new Set<string>();
    own.add(a.cycle_date);
    byMember.set(a.member_id, own);
  }
  return { byDay, byMember };
}

/** Every rule a batch of choices on `state` breaks. Each day is checked on its own. */
function issues(state: PolicyState, choices: PolicyAward[]): RuleProblem[] {
  const found: RuleProblem[] = [];
  const maximum = new Map(state.cycles.map((c) => [c.date, c.maximum ?? 0]));
  const entitlement = new Map(state.members.map((m) => [m.id, m.entitlement]));
  const { byDay, byMember } = tally(state);
  for (const choice of choices) {
    const own = byMember.get(choice.member_id) ?? new Set<string>();
    if (!maximum.has(choice.cycle_date))
      found.push({
        code: 'VA_NO_QUOTA',
        message: choice.cycle_date + ': día sin plazas de VA',
        cycle: choice.cycle_date,
      });
    else if (own.has(choice.cycle_date))
      found.push({ code: 'VA_REPEATED', message: choice.cycle_date + ': ya tiene ese día', cycle: choice.cycle_date });
    else if (state.blocked?.[choice.member_id]?.includes(choice.cycle_date))
      found.push({
        code: 'VA_ORDINARY_OVERLAP',
        message: choice.cycle_date + ': coincide con sus vacaciones ordinarias',
        cycle: choice.cycle_date,
      });
    else if ((byDay.get(choice.cycle_date) ?? 0) >= maximum.get(choice.cycle_date)!)
      found.push({
        code: 'VA_DAY_FULL',
        message: choice.cycle_date + ': no quedan plazas ese día',
        cycle: choice.cycle_date,
        actual: byDay.get(choice.cycle_date),
        limit: maximum.get(choice.cycle_date),
      });
    else if (own.size >= (entitlement.get(choice.member_id) ?? 0))
      found.push({ code: 'VA_ENTITLEMENT', message: 'Supera sus días de VA', cycle: choice.cycle_date });
    // Later choices of the same batch see this one.
    byDay.set(choice.cycle_date, (byDay.get(choice.cycle_date) ?? 0) + 1);
    own.add(choice.cycle_date);
    byMember.set(choice.member_id, own);
  }
  return found;
}

const POSSIBLE = { status: 'possible' as const, checked: 0 };

const assess = (state: PolicyState, choices: PolicyAward[]): CandidateAssessment => {
  const found = issues(state, choices);
  return { allowed: !found.length, completion: POSSIBLE, issues: found, warnings: [] };
};

/** A final allocation: no day over its quota and nobody on their ordinary vacations. */
function final(state: PolicyState) {
  const { byDay } = tally(state);
  const found: RuleProblem[] = [];
  for (const cycle of state.cycles)
    if ((byDay.get(cycle.date) ?? 0) > (cycle.maximum ?? 0))
      found.push({ code: 'VA_DAY_FULL', message: cycle.date + ': supera las plazas de VA', cycle: cycle.date });
  for (const a of state.awards)
    if (state.blocked?.[a.member_id]?.includes(a.cycle_date))
      found.push({
        code: 'VA_ORDINARY_OVERLAP',
        message: a.cycle_date + ': coincide con vacaciones ordinarias',
        cycle: a.cycle_date,
      });
  return { valid: !found.length, issues: found, warnings: [] };
}

function availability(state: PolicyState): AvailabilitySnapshot {
  const holders = new Map<string, string[]>();
  for (const a of state.awards) holders.set(a.cycle_date, [...(holders.get(a.cycle_date) ?? []), a.member_id]);
  const cycles: Record<string, CycleAvailability> = {};
  for (const cycle of state.cycles) {
    const taken = holders.get(cycle.date) ?? [],
      maximum = cycle.maximum ?? 0,
      free = Math.max(0, maximum - taken.length);
    cycles[cycle.date] = {
      cycle: cycle.date,
      period: cycle.period,
      occupied: taken.length,
      localMaximum: maximum,
      status: 'exact',
      additional: free,
      provenAdditional: free,
      possibleAdditionalUpperBound: free,
      slots: [
        ...taken.map((memberId, position) => ({ position, status: 'occupied' as const, memberId, reasons: [] })),
        ...Array.from({ length: free }, (_, i) => ({
          position: taken.length + i,
          status: 'available' as const,
          reasons: [],
        })),
      ],
    };
  }
  return { policyVersion: VERSION, status: 'exact', cycles, checked: 0 };
}

function impact(before: PolicyState, after: PolicyState): AvailabilityImpact {
  const a = availability(before),
    b = availability(after);
  const changes = Object.values(b.cycles)
    .filter((cycle) => a.cycles[cycle.cycle]?.occupied !== cycle.occupied)
    .map((cycle) => {
      const was = a.cycles[cycle.cycle];
      const side = (c: CycleAvailability | undefined) => ({
        occupied: c?.occupied ?? 0,
        additional: c?.additional ?? 0,
        lower: c?.provenAdditional ?? 0,
        upper: c?.possibleAdditionalUpperBound ?? 0,
      });
      return {
        cycle: cycle.cycle,
        period: cycle.period,
        kind: 'directOccupancy' as const,
        before: side(was),
        after: side(cycle),
        delta: (cycle.additional ?? 0) - (was?.additional ?? 0),
        reasons: [],
      };
    });
  return { policyVersion: VERSION, status: 'exact', before: a, after: b, changes, events: [] };
}

/** Everything but the audit form of snapshots, which the policy registry supplies. */
export const VA_OCCUPANCY: Omit<OccupancyRules, 'compact'> = {
  version: VERSION,
  authority: 'RRHH',
  name: 'vacaciones de antigüedad',
  budgets: {
    commit: 1,
    options: { total: 1, perCandidate: 1 },
    review: 1,
    early: { total: 1, perCandidate: 1, deadlineMs: 1000 },
  },
  presentation: {
    periodNames: ['año', 'año', 'año'],
    permits: {},
    impactEvents: {},
    staticReasons: ['VA_NO_QUOTA', 'VA_ORDINARY_OVERLAP'],
    units: { one: 'día', many: 'días' },
    explanationId: null,
  },
  state: (campaign, members, awards) => {
    const blocked: Record<string, string[]> = {};
    for (const m of members as Member[]) {
      const dates = m.person_id ? campaign.external?.blocked?.[m.person_id] : undefined;
      if (dates?.length) blocked[m.id] = dates;
    }
    return {
      cycles: days(campaign).map((d) => ({ date: d.date, period: 0, maximum: quotasOf(campaign)[d.date] })),
      members: members.map((m) => ({ id: m.id, entitlement: (m as Member).entitlement ?? 0 })),
      awards: awards.map((a) => ({ member_id: a.member_id, cycle_date: a.cycle_date })),
      blocked,
    };
  },
  cycleMaximum: (campaign, date) => quotasOf(campaign)[date] ?? 0,
  evaluateCandidate: (state, choices) => assess(state, choices),
  legalChoices: (state, memberId, options = {}) => {
    const selected = (options.selected ?? []).map((cycle_date) => ({ member_id: memberId, cycle_date }));
    const legal: string[] = [],
      illegal: Record<string, RuleProblem[]> = {};
    for (const cycle of state.cycles) {
      const found = issues(state, [...selected, { member_id: memberId, cycle_date: cycle.date }]);
      if (found.length) illegal[cycle.date] = found;
      else legal.push(cycle.date);
    }
    return { legal, illegal, unknown: [], checked: 0 };
  },
  review: (campaign, state) => ({
    limits: state.cycles.map((c) => ({ date: c.date, min: 0, base: 0, max: c.maximum ?? 0 })),
    issues: final(state).issues.map((i) => i.message),
    warnings: [],
    completionStatus: 'possible',
  }),
  evaluateFinal: final,
  // HR guarantees that the places let everyone take their days: nothing is proved here.
  canComplete: () => POSSIBLE,
  immediateIssues: issues,
  partialAssessment: (state) => assess(state, []),
  availability,
  recordedAvailability: () => null,
  restoredAvailability: availability,
  impact,
  previewChoiceImpact: (state, choices) => {
    const check = assess(state, choices);
    const after = { ...state, awards: [...state.awards, ...choices] };
    return {
      policyVersion: VERSION,
      allowed: check.allowed,
      completionStatus: 'possible',
      issues: check.issues,
      warnings: [],
      impact: check.allowed ? impact(state, after) : null,
    };
  },
  permitReport: () => [],
};

/** VA configuration: nothing of the ordinary calendar applies, only a valid year. */
export function validateVaConfig(config: Config, year: number) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Configuración no válida');
  if (!Number.isInteger(year) || year < 2013 || year > 2200) throw new Error('Ejercicio entre 2013 y 2200');
}
