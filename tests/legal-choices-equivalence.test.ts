import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig } from '../domain/defaults.ts';
import { calculate, cycleTable, type Award, type Member, type Request } from '../domain/vacations.ts';
import { occupancyFor, registerPolicy } from '../domain/policy.ts';
import type { OccupancyRules, PolicyAward, PolicyState, RuleProblem } from '../domain/occupancy.ts';
import { canComplete2027 } from '../domain/policy-2027.ts';
import { referenceCalculate } from './calculate-reference.ts';
import { POLICY_2099 } from './policy-2099.ts';
import realThirds from './policy-2027-tercer-cupo-real.json' with { type: 'json' };

/**
 * Equivalence with the code before `legalChoices` and the split of
 * `calculate`: the old loops of `options()` and `view()` are kept here
 * verbatim as references, and `calculate` is compared with a frozen copy.
 */

/** The former per-date loop of ElectionService.options(). */
function referenceOptions(rules: OccupancyRules, state: PolicyState, memberId: string, selected: string[]) {
  const chosen = rules.evaluateCandidate(
    state,
    selected.map((cycle_date) => ({ member_id: memberId, cycle_date })),
  );
  const partialState = {
    ...state,
    awards: [...state.awards, ...selected.map((cycle_date) => ({ member_id: memberId, cycle_date }))],
  };
  const reasons: Record<string, unknown> = {},
    available: string[] = [],
    pending: string[] = [];
  let remainingChecks = rules.budgets.options.total;
  for (const { date } of state.cycles) {
    const budget = Math.min(rules.budgets.options.perCandidate, remainingChecks);
    const candidate = rules.evaluateCandidate(partialState, [{ member_id: memberId, cycle_date: date }], {
      maxChecks: budget,
      witness: chosen.completion.witness,
      warnings: false,
    });
    remainingChecks = Math.max(0, remainingChecks - candidate.completion.checked);
    if (candidate.allowed) available.push(date);
    else if (candidate.completion.status === 'indeterminate') {
      available.push(date);
      pending.push(date);
    } else reasons[date] = candidate.issues;
  }
  return { chosen, available, pending, reasons };
}

/** The former availability loop of ElectionService.view(), symmetry shortcut included. */
function referenceView(rules: OccupancyRules, allocation: PolicyState, focus: string) {
  const available: string[] = [],
    pending: string[] = [],
    reasons: Record<string, string> = {};
  const baseline = rules.canComplete(allocation, { maxChecks: rules.budgets.commit });
  let remainingChecks = rules.budgets.options.total;
  const first = allocation.awards.length === 1 ? allocation.awards[0] : null;
  const sameRights =
    allocation.members.length > 0 &&
    allocation.members[0].entitlement > 0 &&
    allocation.members.every((m) => m.entitlement === allocation.members[0].entitlement);
  const symmetric =
    baseline.status === 'possible' &&
    sameRights &&
    (allocation.awards.length === 0 ||
      (!!first && first.member_id !== focus && !allocation.awards.some((a) => a.member_id === focus)));
  const proofDates = new Set(
    (baseline.witness ?? []).filter((a) => !first || a.member_id !== first.member_id).map((a) => a.cycle_date),
  );
  for (const cycle of allocation.cycles) {
    if (symmetric && (!first || proofDates.has(cycle.date))) {
      available.push(cycle.date);
      continue;
    }
    const budget = Math.min(rules.budgets.options.perCandidate, remainingChecks);
    const diagnostic = rules.evaluateCandidate(allocation, [{ member_id: focus, cycle_date: cycle.date }], {
      maxChecks: budget,
      witness: baseline.witness,
      warnings: false,
    });
    remainingChecks = Math.max(0, remainingChecks - diagnostic.completion.checked);
    if (diagnostic.allowed) available.push(cycle.date);
    else if (diagnostic.completion.status === 'indeterminate') {
      available.push(cycle.date);
      pending.push(cycle.date);
    } else
      reasons[cycle.date] = diagnostic.issues.map((i) => i.message).join('; ') || 'No disponible en el contexto actual';
  }
  return { available, pending, reasons };
}

/** The presentation options() and view() now build from `legalChoices`. */
function present(state: PolicyState, choices: ReturnType<OccupancyRules['legalChoices']>) {
  const legal = new Set(choices.legal),
    unknown = new Set(choices.unknown);
  const available: string[] = [],
    pending: string[] = [],
    reasons: Record<string, RuleProblem[]> = {};
  for (const { date } of state.cycles) {
    if (legal.has(date)) available.push(date);
    else if (unknown.has(date)) {
      available.push(date);
      pending.push(date);
    } else reasons[date] = choices.illegal[date] ?? [];
  }
  return { available, pending, reasons };
}

const rules2027 = occupancyFor(2027)!;
const config2027 = defaultConfig(2027);
const members2027: Member[] = Array.from({ length: 20 }, (_, i) => ({
  id: 'm' + i,
  code: 'CTA' + String(i).padStart(2, '0'),
  seniority: String(2000 + i),
}));
const campaign2027 = { year: 2027, team: 'A', config: config2027 };
const empty2027 = rules2027.state(campaign2027, members2027, []);
const witness2027 = canComplete2027(empty2027, { maxChecks: 1000 }).witness!;

/** Prefixes of a valid final allocation, a lone foreign award and the real HR fixture. */
function states2027(): { label: string; state: PolicyState; focus: string }[] {
  const prefix = (n: number) => ({ ...empty2027, awards: witness2027.slice(0, n) });
  const lone = witness2027.find((a) => a.member_id !== 'm0')!;
  return [
    { label: 'campaña vacía', state: empty2027, focus: 'm0' },
    { label: 'una adjudicación ajena', state: { ...empty2027, awards: [lone] }, focus: 'm0' },
    { label: 'una adjudicación propia', state: { ...empty2027, awards: [lone] }, focus: lone.member_id },
    { label: 'diez adjudicaciones', state: prefix(10), focus: 'm3' },
    { label: 'media campaña', state: prefix(Math.floor(witness2027.length / 2)), focus: 'm7' },
    { label: 'casi completa', state: prefix(witness2027.length - 3), focus: witness2027.at(-1)!.member_id },
    { label: 'cupos reales de RRHH', state: realThirds as PolicyState, focus: 'A' },
  ];
}

test('legalChoices sin selección reproduce la disponibilidad de view(), atajo de simetría incluido', () => {
  for (const { label, state, focus } of states2027()) {
    const before = referenceView(rules2027, state, focus);
    const choices = rules2027.legalChoices(state, focus);
    const after = present(state, choices);
    assert.deepEqual(after.available, before.available, label + ': disponibles');
    assert.deepEqual(after.pending, before.pending, label + ': pendientes');
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(after.reasons).map(([d, issues]) => [
          d,
          issues.map((i) => i.message).join('; ') || 'No disponible en el contexto actual',
        ]),
      ),
      before.reasons,
      label + ': motivos',
    );
    assert.equal(
      choices.legal.length + choices.unknown.length + Object.keys(choices.illegal).length,
      state.cycles.length,
    );
  }
});

test('legalChoices con selección y testigo reproduce las opciones de options()', () => {
  for (const { label, state, focus } of states2027()) {
    const mine = witness2027.filter((a) => a.member_id === focus).map((a) => a.cycle_date);
    for (const selected of [[], mine.slice(0, 1), mine.slice(0, 2)]) {
      if (selected.some((date) => state.awards.some((a) => a.member_id === focus && a.cycle_date === date))) continue;
      const before = referenceOptions(rules2027, state, focus, selected);
      if (!before.chosen.allowed) continue;
      const after = present(
        state,
        rules2027.legalChoices(state, focus, { selected, witness: before.chosen.completion.witness }),
      );
      const tag = label + ' + ' + selected.length + ' elegidos';
      assert.deepEqual(after.available, before.available, tag + ': disponibles');
      assert.deepEqual(after.pending, before.pending, tag + ': pendientes');
      assert.deepEqual(after.reasons, before.reasons, tag + ': motivos');
    }
  }
});

test('la política ficticia 2099 implementa legalChoices con el mismo resultado que el bucle genérico', (t) => {
  t.after(registerPolicy(2099, POLICY_2099));
  const rules = occupancyFor(2099)!,
    config = defaultConfig(2099);
  const members: Member[] = Array.from({ length: 8 }, (_, i) => ({ id: 'p' + i, code: 'P' + i, seniority: '' }));
  const state = rules.state({ year: 2099, team: 'A', config }, members, []);
  const busy = {
    ...state,
    awards: state.cycles
      .slice(0, 6)
      .flatMap((c, i) => [0, 1, 2].map((k) => ({ member_id: 'p' + ((i + k) % 8), cycle_date: c.date }))),
  };
  for (const s of [state, busy]) {
    const before = referenceOptions(rules, s, 'p0', []);
    const after = present(s, rules.legalChoices(s, 'p0', { witness: before.chosen.completion.witness }));
    assert.deepEqual(after.available, before.available);
    assert.deepEqual(after.reasons, before.reasons);
    const view = referenceView(rules, s, 'p0');
    assert.deepEqual(present(s, rules.legalChoices(s, 'p0')).available, view.available);
  }
});

function awards(list: PolicyAward[]): Award[] {
  return list.map((a, i) => ({ ...a, id: 'a' + i }));
}
function requests(list: PolicyAward[]): Request[] {
  return list.map((a, i) => ({ ...a, id: 'r' + i, slot: (i % 6) + 1 }));
}

/** Legacy, 2027 and 2099 allocations, valid and broken, partial and complete. */
function calculateScenarios() {
  const legacyConfig = defaultConfig(2026),
    legacyMembers: Member[] = Array.from({ length: 12 }, (_, i) => ({
      id: 'l' + i,
      code: 'L' + i,
      seniority: i % 3 ? String(1990 + i) : '',
    })),
    legacyDates = cycleTable(2026, 'C', legacyConfig, [], []).map((c) => c.date);
  const legacyPicks = legacyMembers.flatMap((m, i) =>
    Array.from({ length: legacyConfig.cyclesPerPerson }, (_, k) => ({
      member_id: m.id,
      cycle_date: legacyDates[(i * 7 + k * 5) % legacyDates.length],
    })),
  );
  const crowded = legacyMembers.slice(0, 6).map((m) => ({ member_id: m.id, cycle_date: legacyDates[20] }));
  const stray = [
    { member_id: 'nadie', cycle_date: legacyDates[0] },
    { member_id: 'l0', cycle_date: '2026-13-01' },
  ];
  const legacy = (label: string, list: PolicyAward[]) => ({
    label: 'heredado: ' + label,
    year: 2026,
    team: 'C',
    config: legacyConfig,
    members: legacyMembers,
    requests: requests(list),
    awards: awards(list),
  });
  const of2027 = (label: string, list: PolicyAward[], skipProof = false) => ({
    label: '2027: ' + label,
    year: 2027,
    team: 'A',
    config: config2027,
    members: members2027,
    requests: requests(list),
    awards: awards(list),
    skipProof,
  });
  const overflow = members2027.slice(0, 5).map((m) => ({ member_id: m.id, cycle_date: witness2027[0].cycle_date }));
  const overEntitled = Array.from({ length: 7 }, (_, k) => ({
    member_id: 'm0',
    cycle_date: empty2027.cycles[k * 3].date,
  }));
  const realMembers: Member[] = (realThirds as PolicyState).members.map((m) => ({
    id: m.id,
    code: m.id,
    seniority: '',
  }));
  return [
    legacy('vacía', []),
    legacy('parcial', legacyPicks.slice(0, 20)),
    legacy('completa', legacyPicks),
    legacy('ciclo saturado', [...legacyPicks.slice(0, 10), ...crowded]),
    legacy('fuera de campaña y repetidas', [...legacyPicks.slice(0, 5), legacyPicks[0], ...stray]),
    of2027('vacía', []),
    of2027('parcial', witness2027.slice(0, 15)),
    of2027('parcial restaurada', witness2027.slice(0, 15), true),
    of2027('completa', witness2027),
    of2027('cupo superado', overflow),
    of2027('ciclos de más', overEntitled),
    of2027('fuera de campaña y repetida', [...witness2027.slice(0, 3), witness2027[0], ...stray]),
    {
      label: '2027: cupos reales de RRHH',
      year: 2027,
      team: 'A',
      config: config2027,
      members: realMembers,
      requests: requests((realThirds as PolicyState).awards),
      awards: awards((realThirds as PolicyState).awards),
    },
    {
      label: '2099: parcial',
      year: 2099,
      team: 'A',
      config: defaultConfig(2099),
      members: legacyMembers,
      requests: [],
      awards: awards(
        legacyMembers
          .slice(0, 4)
          .map((m) => ({ member_id: m.id, cycle_date: cycleTable(2099, 'A', defaultConfig(2099), [], [])[0].date })),
      ),
    },
  ];
}

test('calculate() conserva exactamente el resultado anterior en todos los escenarios', (t) => {
  t.after(registerPolicy(2099, POLICY_2099));
  for (const s of calculateScenarios()) {
    const options = { skipProof: (s as { skipProof?: boolean }).skipProof };
    const after = calculate(s.year, s.team, s.config, s.members, s.requests, s.awards, options);
    const before = referenceCalculate(s.year, s.team, s.config, s.members, s.requests, s.awards, options);
    assert.deepEqual(after, before, s.label);
  }
});

test('las fechas de resultado son las del calendario de calculate()', () => {
  for (const s of calculateScenarios().filter((x) => x.year !== 2099))
    assert.deepEqual(
      cycleTable(s.year, s.team, s.config, [], []).map((c) => c.date),
      referenceCalculate(s.year, s.team, s.config, s.members, s.requests, s.awards).cycles.map((c) => c.date),
      s.label,
    );
});
