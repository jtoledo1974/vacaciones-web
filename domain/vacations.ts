import { calendar, ENGINE_VERSION, type Config } from './calendar.ts';
import { relationQuotas } from './quotas.ts';
import { policyFor } from './policy.ts';
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
export function calculate(
  y: number,
  team: string,
  c: Config,
  members: Member[],
  requests: Request[],
  awards: Award[],
  options: { skipProof?: boolean } = {},
) {
  const cycles = calendar(y, team, c);
  const policy = policyFor(y),
    rules = policy.occupancy,
    campaign = { year: y, team, config: c };
  const byDate = new Map(cycles.map((s) => [s.date, s]));
  // Reuse occupancy indexes for policy eligibility, scoring and legacy views.
  // These replace repeated full award/request scans without changing order.
  const occupiedByDate = new Map<string, number>(),
    requestedByDate = new Map<string, number>();
  const awardsByMember = new Map<string, Award[]>(),
    requestsByMember = new Map<string, Request[]>();
  const memberIds = new Set(members.map((m) => m.id));
  for (const award of awards) {
    occupiedByDate.set(award.cycle_date, (occupiedByDate.get(award.cycle_date) ?? 0) + 1);
    const list = awardsByMember.get(award.member_id) ?? [];
    list.push(award);
    awardsByMember.set(award.member_id, list);
  }
  for (const request of requests) {
    requestedByDate.set(request.cycle_date, (requestedByDate.get(request.cycle_date) ?? 0) + 1);
    const list = requestsByMember.get(request.member_id) ?? [];
    list.push(request);
    requestsByMember.set(request.member_id, list);
  }
  const counts = [0, 0, 0];
  cycles.forEach((s) => counts[s.period]++);
  const totalEntitlements = members.reduce((total, m) => total + policy.entitlement(c, m), 0);
  // Legacy years never clamped the summer target to each member's entitlement.
  const summerPlanning = rules
    ? members.reduce((total, m) => total + Math.min(c.summerPerPerson, policy.entitlement(c, m)), 0)
    : members.length * c.summerPerPerson;
  const necessary = [totalEntitlements - summerPlanning, summerPlanning];
  const conventionSummer = Math.max(0, necessary[1] - counts[1] * c.base[1]);
  const conventionWinter = Math.max(0, necessary[0] - counts[0] * c.base[0] - counts[2] * c.base[2]);
  const convention = [
    c.commonConvention ? conventionWinter : Math.min(conventionWinter, c.conventionJanuary),
    conventionSummer,
    c.commonConvention ? conventionWinter : Math.max(0, conventionWinter - c.conventionJanuary),
  ];
  const ordering = members
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
  const usedSummer = awards.filter((a) => byDate.get(a.cycle_date)?.period === 1).length;
  const summerExtra = cycles
    .filter((s) => s.period === 1)
    .reduce((n, s) => n + Math.max(0, (occupiedByDate.get(s.date) ?? 0) - c.base[1]), 0);
  const winterExtra = [0, 0, 0];
  cycles
    .filter((s) => s.period !== 1)
    .forEach((s) => (winterExtra[s.period] += Math.max(0, (occupiedByDate.get(s.date) ?? 0) - c.base[s.period])));
  const issues: string[] = [];
  const warnings: string[] = [];
  for (const m of members) {
    const a = awardsByMember.get(m.id) ?? [];
    if (a.length > c.cyclesPerPerson) issues.push(`${m.code}: supera los ciclos anuales`);
    if (a.filter((a) => byDate.get(a.cycle_date)?.period === 1).length > c.summerPerPerson)
      warnings.push(`${m.code}: más ciclos de verano que el objetivo de planificación`);
  }
  const baseTotal = counts.reduce((n, count, i) => n + count * c.base[i], 0);
  const neededTotal = totalEntitlements;
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
    cycles.map((s) => occupiedByDate.get(s.date) ?? 0),
    { ...relation, people: members.length, necessary: neededTotal, baseTotal },
  );
  const result = cycles.map((s, i) => {
    const occupied = occupiedByDate.get(s.date) ?? 0;
    const requested = requestedByDate.get(s.date) ?? 0;
    const original = originalQuotas[i];
    const specialQuota = c.specialQuotas?.[s.date];
    const q =
      specialQuota === undefined ? original : { ...original, max: specialQuota, available: occupied < specialQuota };
    if (occupied > q.max) issues.push(`${s.date}: supera el cupo máximo de la relación`);
    return { ...s, occupied, requested, ...q };
  });
  for (const a of awards)
    if (!byDate.has(a.cycle_date) || !memberIds.has(a.member_id)) issues.push('Adjudicación fuera de campaña');
  if (rules) {
    const state = rules.state(campaign, members, awards);
    const complete = members.every(
      (m) => awards.filter((a) => a.member_id === m.id).length === policy.entitlement(c, m),
    );
    const final = complete ? rules.evaluateFinal(state) : null;
    const policyIssues: string[] = [];
    // Partial states are not invalid merely because cycles lack their FINAL minimum.
    for (const a of awards) {
      if (!members.some((m) => m.id === a.member_id) || !byDate.has(a.cycle_date))
        policyIssues.push('Adjudicación fuera de esta campaña');
    }
    const keys = new Set<string>();
    for (const a of awards) {
      const key = a.member_id + '|' + a.cycle_date;
      if (keys.has(key)) policyIssues.push('Un controlador no puede repetir un ciclo');
      keys.add(key);
    }
    for (const m of members)
      if (awards.filter((a) => a.member_id === m.id).length > policy.entitlement(c, m))
        policyIssues.push(m.code + ': supera sus ciclos anuales');
    const detailed = cycles.map((s) => {
      const occupied = awards.filter((a) => a.cycle_date === s.date).length;
      const max = rules.cycleMaximum(campaign, s.date);
      if (occupied > max) policyIssues.push(s.date + ': supera el cupo máximo autorizado por RRHH');
      return {
        ...s,
        occupied,
        requested: requests.filter((a) => a.cycle_date === s.date).length,
        min: 1,
        base: 2,
        max,
        available: occupied < max,
      };
    });
    // Warnings that every completion would trigger (summer-total deviation) persist after each adjudication.
    // They are not inferred from provisional occupation (which may still
    // be completed), and they never turn into blocking errors.
    const partial =
      !options.skipProof && !complete && !policyIssues.length && awards.length
        ? rules.partialAssessment(state, { maxChecks: rules.budgets.review })
        : null;
    if (final) policyIssues.push(...final.issues.map((i) => i.message));
    else if (partial?.completion.status === 'impossible')
      policyIssues.push('Las adjudicaciones actuales no permiten completar las vacaciones restantes');
    const policyWarnings = final?.warnings ?? partial?.warnings ?? [];
    const completionStatus = final
      ? final.valid
        ? 'possible'
        : 'impossible'
      : (partial?.completion.status ?? 'not-checked');
    return {
      engineVersion: ENGINE_VERSION,
      occupancyPolicyVersion: rules.version,
      cycles: detailed,
      ordering,
      issues: [...new Set(policyIssues)],
      warnings: policyWarnings.map((w) => w.message),
      policyWarnings,
      completionStatus,
      totals: {
        members: members.length,
        requested: requests.length,
        awarded: awards.length,
        necessary: neededTotal,
        base: baseTotal,
        conventionSummer,
        conventionWinter,
        usedSummer,
        counts,
      },
    };
  }
  return {
    engineVersion: ENGINE_VERSION,
    cycles: result,
    ordering,
    issues,
    warnings,
    totals: {
      members: members.length,
      requested: requests.length,
      awarded: awards.length,
      necessary: neededTotal,
      base: baseTotal,
      conventionSummer,
      conventionWinter,
      usedSummer,
      counts,
    },
  };
}
