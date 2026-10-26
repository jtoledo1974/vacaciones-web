import { calendar } from '../domain/calendar.ts';
import type { VacationPolicy } from '../domain/policy.ts';
import type {
  OccupancyRules,
  PolicyState,
  PolicyAward,
  RuleProblem,
  Completion,
  CandidateAssessment,
  AvailabilitySnapshot,
  CycleAvailability,
  CompactAvailabilitySnapshot,
  AvailabilityChange,
} from '../domain/occupancy.ts';

/**
 * A deliberately trivial occupancy engine for a fictitious year. It proves
 * that generic code only depends on the `OccupancyRules` contract:
 * - at most MAX people per cycle (or less, by a special quota);
 * - completion by simple counting (largest remaining need first, then the
 *   cycles with most free places: exact for this structure, Gale-Ryser);
 * - a cycle is available while it has room and someone still needs a cycle.
 */
export const POLICY_2099_VERSION = 'ficticia-2099-v1';
export const POLICY_2099_MAX = 3;

const capacity = (state: PolicyState, date: string) =>
  Math.min(state.cycles.find((c) => c.date === date)?.maximum ?? POLICY_2099_MAX, POLICY_2099_MAX);
const stateKey = (state: PolicyState) =>
  JSON.stringify([
    POLICY_2099_VERSION,
    state.cycles,
    state.members,
    [...state.awards].map((a) => a.member_id + '|' + a.cycle_date).sort(),
  ]);

function issues(state: PolicyState, choices: PolicyAward[]): RuleProblem[] {
  const all = [...state.awards, ...choices],
    out: RuleProblem[] = [],
    seen = new Set<string>();
  const dates = new Set(state.cycles.map((c) => c.date));
  for (const a of all) {
    if (!dates.has(a.cycle_date))
      out.push({ code: 'UNKNOWN_CYCLE', message: 'Ciclo fuera del calendario ficticio', cycle: a.cycle_date });
    const key = a.member_id + '|' + a.cycle_date;
    if (seen.has(key))
      out.push({ code: 'DUPLICATE', message: 'Un controlador no puede repetir un ciclo', cycle: a.cycle_date });
    seen.add(key);
  }
  for (const m of state.members) {
    const taken = all.filter((a) => a.member_id === m.id).length;
    if (taken > m.entitlement)
      out.push({ code: 'OVER_ENTITLEMENT', message: 'Supera sus ciclos', actual: taken, limit: m.entitlement });
  }
  for (const c of state.cycles) {
    const occupied = all.filter((a) => a.cycle_date === c.date).length,
      limit = capacity(state, c.date);
    if (occupied > limit)
      out.push({
        code: 'CYCLE_FULL',
        message: 'Supera el máximo ficticio del ciclo',
        period: c.period,
        cycle: c.date,
        actual: occupied,
        limit,
      });
  }
  return out;
}

function complete(state: PolicyState): Completion {
  if (issues(state, []).length)
    return { status: 'impossible', checked: 1, reason: 'La asignación ya incumple las normas ficticias' };
  const free = new Map(
    state.cycles.map((c) => [
      c.date,
      capacity(state, c.date) - state.awards.filter((a) => a.cycle_date === c.date).length,
    ]),
  );
  const taken = new Map(
    state.members.map((m) => [
      m.id,
      new Set(state.awards.filter((a) => a.member_id === m.id).map((a) => a.cycle_date)),
    ]),
  );
  const needs = state.members
    .map((m) => ({ id: m.id, need: m.entitlement - taken.get(m.id)!.size }))
    .sort((a, b) => b.need - a.need);
  const witness: PolicyAward[] = [];
  for (const { id, need } of needs) {
    const mine = taken.get(id)!;
    const room = [...free]
      .filter(([date, n]) => n > 0 && !mine.has(date))
      .sort((a, b) => b[1] - a[1])
      .slice(0, need);
    if (room.length < need)
      return { status: 'impossible', checked: 1, reason: 'No quedan plazas para completar los ciclos' };
    for (const [date] of room) {
      free.set(date, free.get(date)! - 1);
      witness.push({ member_id: id, cycle_date: date });
    }
  }
  return { status: 'possible', checked: 1, witness };
}

function candidate(state: PolicyState, choices: PolicyAward[]): CandidateAssessment {
  const found = issues(state, choices);
  const completion: Completion = found.length
    ? { status: 'impossible', checked: 0, reason: found[0].message }
    : complete({ ...state, awards: [...state.awards, ...choices] });
  return { allowed: completion.status === 'possible', completion, issues: found, warnings: [] };
}

function availability(state: PolicyState, checked = 1): AvailabilitySnapshot {
  const invalid = issues(state, []).length > 0,
    cycles: Record<string, CycleAvailability> = {};
  for (const c of state.cycles) {
    const people = state.awards.filter((a) => a.cycle_date === c.date).map((a) => a.member_id);
    const localMaximum = capacity(state, c.date);
    const someoneNeeds = state.members.some(
      (m) => !people.includes(m.id) && state.awards.filter((a) => a.member_id === m.id).length < m.entitlement,
    );
    const additional = someoneNeeds ? Math.max(0, localMaximum - people.length) : 0;
    cycles[c.date] = {
      cycle: c.date,
      period: c.period,
      occupied: people.length,
      localMaximum,
      status: invalid ? 'invalid' : 'exact',
      additional,
      provenAdditional: additional,
      possibleAdditionalUpperBound: additional,
      slots: Array.from({ length: localMaximum }, (_, i) =>
        i < people.length
          ? { position: i + 1, status: 'occupied' as const, memberId: people[i], reasons: [] }
          : {
              position: i + 1,
              status: someoneNeeds ? ('available' as const) : ('blocked' as const),
              reasons: someoneNeeds
                ? []
                : [{ code: 'NOBODY_LEFT', message: 'Nadie necesita más ciclos', period: c.period, cycle: c.date }],
            },
      ),
    };
  }
  return {
    policyVersion: POLICY_2099_VERSION,
    status: invalid ? 'invalid' : 'exact',
    cycles,
    checked,
    stateKey: stateKey(state),
  };
}

function impact(before: PolicyState, after: PolicyState) {
  const a = availability(before),
    b = availability(after),
    changes: AvailabilityChange[] = [];
  const counts = (c: CycleAvailability) => ({
    occupied: c.occupied,
    additional: c.additional,
    lower: c.provenAdditional,
    upper: c.possibleAdditionalUpperBound,
  });
  for (const [date, x] of Object.entries(a.cycles)) {
    const y = b.cycles[date];
    if (x.occupied === y.occupied && x.additional === y.additional) continue;
    changes.push({
      cycle: date,
      period: x.period,
      kind: x.occupied !== y.occupied ? 'directOccupancy' : 'globalConstraint',
      before: counts(x),
      after: counts(y),
      delta: (y.additional ?? 0) - (x.additional ?? 0),
      reasons: [],
    });
  }
  return { policyVersion: POLICY_2099_VERSION, status: b.status, before: a, after: b, changes, events: [] };
}

export const OCCUPANCY_2099: OccupancyRules = {
  version: POLICY_2099_VERSION,
  authority: 'Autoridad ficticia 2099',
  name: 'normas ficticias 2099',
  budgets: { commit: 10, options: { total: 64, perCandidate: 8 }, review: 10 },
  state: (c, members, awards) => ({
    cycles: calendar(c.year, c.team, c.config).map((x) => ({
      date: x.date,
      period: x.period as 0 | 1 | 2,
      maximum: c.config.specialQuotas?.[x.date],
    })),
    members: members.map((m) => ({ id: m.id, entitlement: c.config.cyclesPerPerson })),
    awards: awards.map((a) => ({ member_id: a.member_id, cycle_date: a.cycle_date })),
  }),
  cycleMaximum: (c, date) => Math.min(c.config.specialQuotas?.[date] ?? POLICY_2099_MAX, POLICY_2099_MAX),
  evaluateCandidate: (state, choices) => candidate(state, choices),
  evaluateFinal: (state) => {
    const found = issues(state, []);
    for (const m of state.members) {
      const taken = state.awards.filter((a) => a.member_id === m.id).length;
      if (taken !== m.entitlement)
        found.push({ code: 'INCOMPLETE', message: 'Ciclos sin completar', actual: taken, limit: m.entitlement });
    }
    return { valid: !found.length, issues: found, warnings: [] };
  },
  canComplete: (state) => complete(state),
  immediateIssues: issues,
  partialAssessment: (state) => candidate(state, []),
  availability: (state) => availability(state),
  recordedAvailability: (state, stored) => (stored?.stateKey === stateKey(state) ? availability(state, 0) : null),
  restoredAvailability: (state) => availability(state, 0),
  impact: (before, after) => impact(before, after),
  previewChoiceImpact: (state, choices) => {
    const check = candidate(state, choices);
    return {
      policyVersion: POLICY_2099_VERSION,
      allowed: check.allowed,
      completionStatus: check.completion.status,
      issues: check.issues,
      warnings: check.warnings,
      impact: check.allowed ? impact(state, { ...state, awards: [...state.awards, ...choices] }) : null,
    };
  },
  permitReport: () => [],
  compact: (s): CompactAvailabilitySnapshot => ({
    format: 'availability-c1',
    policyVersion: s.policyVersion,
    status: s.status,
    checked: s.checked,
    stateKey: s.stateKey,
    reasons: [],
    cycles: Object.values(s.cycles).map((c) => [
      c.cycle,
      c.period,
      c.occupied,
      c.localMaximum,
      c.status,
      c.additional,
      c.provenAdditional,
      c.possibleAdditionalUpperBound,
      c.slots.map((x) => [x.status[0]]),
    ]),
  }),
};

export const POLICY_2099: VacationPolicy = {
  entitlement: (config) => config.cyclesPerPerson,
  occupancy: OCCUPANCY_2099,
};
