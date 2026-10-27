import { calendar, ENGINE_VERSION, type Config } from './calendar.ts';
import { relationQuotas } from './quotas.ts';
import { policyFor, type VacationPolicy } from './policy.ts';
export type Member = {
  id: string;
  code: string;
  seniority: string;
};
export type Request = {
  id: string;
  member_id: string;
  slot: number;
  cycle_date: string;
};
export type Award = {
  id: string;
  member_id: string;
  cycle_date: string;
};
type CycleRow = ReturnType<typeof calendar>[number] & { occupied: number; requested: number };

/** Calendar with each cycle's score, occupation and requests, in calendar order. */
export function cycleTable(
  y: number,
  team: string,
  c: Config,
  requests: readonly Pick<Request, 'cycle_date'>[],
  awards: readonly Pick<Award, 'cycle_date'>[],
): CycleRow[] {
  const occupiedByDate = new Map<string, number>(),
    requestedByDate = new Map<string, number>();
  for (const award of awards) occupiedByDate.set(award.cycle_date, (occupiedByDate.get(award.cycle_date) ?? 0) + 1);
  for (const request of requests)
    requestedByDate.set(request.cycle_date, (requestedByDate.get(request.cycle_date) ?? 0) + 1);
  return calendar(y, team, c).map((s) => ({
    ...s,
    occupied: occupiedByDate.get(s.date) ?? 0,
    requested: requestedByDate.get(s.date) ?? 0,
  }));
}

/** Next year's election order: lowest weighted request score first, then seniority. */
export function nextYearOrdering(cycles: readonly CycleRow[], c: Config, members: Member[], requests: Request[]) {
  const byDate = new Map(cycles.map((s) => [s.date, s]));
  const requestsByMember = new Map<string, Request[]>();
  for (const request of requests) {
    const list = requestsByMember.get(request.member_id) ?? [];
    list.push(request);
    requestsByMember.set(request.member_id, list);
  }
  return members
    .map((m) => ({
      ...m,
      score: (requestsByMember.get(m.id) ?? []).reduce(
        (s, r) => s + (byDate.get(r.cycle_date)?.score ?? 0) * c.weights[(r.slot + 4) % 6],
        0,
      ),
    }))
    .sort(
      (a, b) =>
        a.score - b.score ||
        (a.seniority && b.seniority ? a.seniority.localeCompare(b.seniority) : a.seniority ? -1 : b.seniority ? 1 : 0),
    );
}

/** Findings that do not depend on any year's rules. */
export type StructuralFindings = {
  /** One entry per award outside the campaign's cycles or roster. */
  outside: number;
  /** One entry per repeated member/cycle pair after its first. */
  duplicates: number;
  /** Members holding more awards than `entitlement` allows, in roster order. */
  overEntitled: Member[];
};

/** The structural validation every review starts from. */
export function structuralFindings(
  cycles: readonly { date: string }[],
  members: Member[],
  awards: readonly Pick<Award, 'member_id' | 'cycle_date'>[],
  entitlement: (m: Member) => number,
): StructuralFindings {
  const dates = new Set(cycles.map((s) => s.date)),
    memberIds = new Set(members.map((m) => m.id));
  const taken = new Map<string, number>(),
    keys = new Set<string>();
  let outside = 0,
    duplicates = 0;
  for (const a of awards) {
    if (!dates.has(a.cycle_date) || !memberIds.has(a.member_id)) outside++;
    const key = a.member_id + '|' + a.cycle_date;
    if (keys.has(key)) duplicates++;
    keys.add(key);
    taken.set(a.member_id, (taken.get(a.member_id) ?? 0) + 1);
  }
  return { outside, duplicates, overEntitled: members.filter((m) => (taken.get(m.id) ?? 0) > entitlement(m)) };
}

/** Relation quotas and convention extras of the years without a proof-based engine. */
export function legacyReview(
  cycles: readonly CycleRow[],
  c: Config,
  members: Member[],
  awards: Award[],
  structural: StructuralFindings,
  planning: {
    counts: number[];
    necessary: number;
    baseTotal: number;
    conventionSummer: number;
    conventionWinter: number;
  },
) {
  const byDate = new Map(cycles.map((s) => [s.date, s]));
  const { counts, conventionSummer, conventionWinter } = planning;
  const convention = [
    c.commonConvention ? conventionWinter : Math.min(conventionWinter, c.conventionJanuary),
    conventionSummer,
    c.commonConvention ? conventionWinter : Math.max(0, conventionWinter - c.conventionJanuary),
  ];
  const summerExtra = cycles.filter((s) => s.period === 1).reduce((n, s) => n + Math.max(0, s.occupied - c.base[1]), 0);
  const winterExtra = [0, 0, 0];
  cycles
    .filter((s) => s.period !== 1)
    .forEach((s) => (winterExtra[s.period] += Math.max(0, s.occupied - c.base[s.period])));
  const issues: string[] = [];
  const warnings: string[] = [];
  const over = new Set(structural.overEntitled);
  const summerByMember = new Map<string, number>();
  for (const a of awards)
    if (byDate.get(a.cycle_date)?.period === 1)
      summerByMember.set(a.member_id, (summerByMember.get(a.member_id) ?? 0) + 1);
  for (const m of members) {
    if (over.has(m)) issues.push(`${m.code}: supera los ciclos anuales`);
    if ((summerByMember.get(m.id) ?? 0) > c.summerPerPerson)
      warnings.push(`${m.code}: más ciclos de verano que el objetivo de planificación`);
  }
  const graceWinter = c.grace[0] + c.grace[2];
  if (summerExtra > conventionSummer + c.grace[1]) issues.push('Se han agotado los extracupos de verano');
  if ((c.commonConvention || c.commonGrace) && winterExtra[0] + winterExtra[2] > conventionWinter + graceWinter)
    issues.push('Se han agotado los extracupos de no verano');
  if (!c.commonConvention && !c.commonGrace) {
    for (const p of [0, 2])
      if (winterExtra[p] > convention[p] + c.grace[p]) issues.push('Se han agotado los extracupos del período');
  }
  const relation = c.relation ?? { minimum: 1, base: 2, maximum: 3, graceJanuary: 0, graceOctober: 0 };
  const originalQuotas = relationQuotas(
    cycles.map((s) => s.period),
    cycles.map((s) => s.occupied),
    { ...relation, people: members.length, necessary: planning.necessary, baseTotal: planning.baseTotal },
  );
  const result = cycles.map((s, i) => {
    const original = originalQuotas[i];
    const specialQuota = c.specialQuotas?.[s.date];
    const q =
      specialQuota === undefined ? original : { ...original, max: specialQuota, available: s.occupied < specialQuota };
    if (s.occupied > q.max) issues.push(`${s.date}: supera el cupo máximo de la relación`);
    return { ...s, ...q };
  });
  for (let n = 0; n < structural.outside; n++) issues.push('Adjudicación fuera de campaña');
  return { cycles: result, issues, warnings };
}

function planningTotals(cycles: readonly CycleRow[], c: Config, members: Member[], policy: VacationPolicy) {
  const counts = [0, 0, 0];
  cycles.forEach((s) => counts[s.period]++);
  const necessary = members.reduce((total, m) => total + policy.entitlement(c, m), 0);
  // Legacy years never clamped the summer target to each member's entitlement.
  const summerPlanning = policy.occupancy
    ? members.reduce((total, m) => total + Math.min(c.summerPerPerson, policy.entitlement(c, m)), 0)
    : members.length * c.summerPerPerson;
  const baseTotal = counts.reduce((n, count, i) => n + count * c.base[i], 0);
  return {
    counts,
    necessary,
    baseTotal,
    conventionSummer: Math.max(0, summerPlanning - counts[1] * c.base[1]),
    conventionWinter: Math.max(0, necessary - summerPlanning - counts[0] * c.base[0] - counts[2] * c.base[2]),
  };
}

/** Facade over the cycle table, next year's ordering and the year's review. */
export function calculate(
  y: number,
  team: string,
  c: Config,
  members: Member[],
  requests: Request[],
  awards: Award[],
  options: { skipProof?: boolean } = {},
) {
  const policy = policyFor(y),
    rules = policy.occupancy,
    campaign = { year: y, team, config: c };
  const cycles = cycleTable(y, team, c, requests, awards);
  const ordering = nextYearOrdering(cycles, c, members, requests);
  const planning = planningTotals(cycles, c, members, policy);
  const byDate = new Map(cycles.map((s) => [s.date, s]));
  const totals = {
    members: members.length,
    requested: requests.length,
    awarded: awards.length,
    necessary: planning.necessary,
    base: planning.baseTotal,
    conventionSummer: planning.conventionSummer,
    conventionWinter: planning.conventionWinter,
    usedSummer: awards.filter((a) => byDate.get(a.cycle_date)?.period === 1).length,
    counts: planning.counts,
  };
  if (rules) {
    const structural = structuralFindings(cycles, members, awards, (m) => policy.entitlement(c, m));
    const structuralIssues = [
      ...Array.from({ length: structural.outside }, () => 'Adjudicación fuera de esta campaña'),
      ...Array.from({ length: structural.duplicates }, () => 'Un controlador no puede repetir un ciclo'),
      ...structural.overEntitled.map((m) => m.code + ': supera sus ciclos anuales'),
    ];
    const review = rules.review(campaign, rules.state(campaign, members, awards), {
      skipProof: options.skipProof,
      structurallyValid: !structuralIssues.length,
    });
    return {
      engineVersion: ENGINE_VERSION,
      occupancyPolicyVersion: rules.version,
      cycles: cycles.map((s, i) => {
        const { min, base, max } = review.limits[i];
        return { ...s, min, base, max, available: s.occupied < max };
      }),
      ordering,
      issues: [...new Set([...structuralIssues, ...review.issues])],
      warnings: review.warnings.map((w) => w.message),
      policyWarnings: review.warnings,
      completionStatus: review.completionStatus,
      totals,
    };
  }
  const structural = structuralFindings(cycles, members, awards, () => c.cyclesPerPerson);
  const legacy = legacyReview(cycles, c, members, awards, structural, planning);
  return {
    engineVersion: ENGINE_VERSION,
    cycles: legacy.cycles,
    ordering,
    issues: legacy.issues,
    warnings: legacy.warnings,
    totals,
  };
}
