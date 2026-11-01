import { calculate, type Member, type Request, type Award } from './vacations.ts';
import type { Config } from './calendar.ts';
import { occupancyOf, policyOf } from './policy.ts';
import { nextSlot, orderForRound, type SequenceInput } from './sequence.ts';
export { orderForRound } from './sequence.ts';

// Criterios Vacaciones 1.1 (10/06/2025), pp. 1-3.
export const ELECTION_POLICY_VERSION = 'criterios-vacaciones-1.1-2025';
export type ElectionState = {
  status: 'active' | 'paused' | 'complete';
  order: string[];
  cursor: number;
  credits: Record<string, number>;
  // Administrators can correct an undone automatic choice without retriggering it.
  automaticPaused?: boolean;
  source: string;
  allowDeferral: boolean;
  policyVersion?: string;
  // Each tied group is contiguous in the initial, drawn order, then rotated each round.
  tieGroups?: string[][];
  pendingTieGroups?: string[][];
  tieResolutions?: {
    order: string[];
    method: 'random' | 'external';
    at: string;
    actor: string;
    anticipated?: boolean;
  }[];
  // A joint turn is taken at the position of its last participant in each round.
  jointGroups?: string[][];
  // Round-scoped administrative agreements; cancelled records remain in the audit.
  jointAgreements?: {
    round: number;
    members: string[];
    actor: string;
    at: string;
    cancelledBy?: string;
    cancelledAt?: string;
  }[];
  // When the turn at this (normalized) cursor opened for choosing: a 'wait' list counts from here.
  turnSince?: { cursor: number; at: string };
  // Cycles awarded ahead of their slot (absolute cursor), which then counts as played.
  // Nothing writes them yet; an entry lives and dies with its award.
  earlyChoices?: { memberId: string; round: number; cursor: number; awardId: string; at: string }[];
  /** Stored format (see upgradeElectionState); missing means 1. */
  format?: number;
};
export const ELECTION_STATE_FORMAT = 1;
/**
 * Bring a stored state (election_states, or a snapshot in audit) to the current
 * format. Every read goes through here, so a future format only adds a step.
 */
export function upgradeElectionState(raw: unknown): ElectionState | null {
  if (raw === null || raw === undefined) return null;
  const state = raw as ElectionState;
  const format = state.format ?? 1;
  if (!Number.isInteger(format) || format < 1 || format > ELECTION_STATE_FORMAT)
    throw new Error('Formato de estado de elección no admitido');
  return { ...state, format: ELECTION_STATE_FORMAT };
}
/** Drop early choices whose award no longer exists (undone, or not rebuilt). */
export function withLiveEarlyChoices(state: ElectionState, awards: readonly { id: string }[]): ElectionState {
  if (!state.earlyChoices) return state;
  const ids = new Set(awards.map((a) => a.id));
  return { ...state, earlyChoices: state.earlyChoices.filter((e) => ids.has(e.awardId)) };
}
// immediate: applied as soon as the turn arrives. wait: applied waitMinutes after it
// arrives unless its owner chooses first. manual: a note only, never applied.
export type PreferenceMode = 'immediate' | 'wait' | 'manual';
export const PREFERENCE_MODES: PreferenceMode[] = ['immediate', 'wait', 'manual'];
export const MAX_WAIT_MINUTES = 24 * 60;
export type Preference = {
  member_id: string;
  dates: string[];
  automatic: boolean;
  persistent?: boolean;
  active?: boolean;
  mode?: PreferenceMode;
  waitMinutes?: number;
  labels?: Record<string, string>;
};
export const PREFERENCE_COLUMNS = [
  'member_id',
  'campaign_id',
  'dates_json',
  'automatic',
  'persistent',
  'active',
  'mode',
  'wait_minutes',
  'labels_json',
];
export function preferenceRow(p: Preference, campaignId: string): unknown[] {
  return [
    p.member_id,
    campaignId,
    JSON.stringify(p.dates),
    p.automatic ? 1 : 0,
    p.persistent ? 1 : 0,
    p.active !== false ? 1 : 0,
    p.mode ?? 'immediate',
    p.waitMinutes ?? 0,
    JSON.stringify(p.labels ?? {}),
  ];
}
export function preferenceFromRow(row: any): Preference {
  return {
    member_id: row.member_id,
    dates: JSON.parse(row.dates_json),
    automatic: !!row.automatic,
    persistent: !!row.persistent,
    active: !!row.active,
    mode: PREFERENCE_MODES.includes(row.mode) ? row.mode : 'immediate',
    waitMinutes: Number(row.wait_minutes) || 0,
    labels: parseLabels(row.labels_json),
  };
}
export const MAX_LABEL_LENGTH = 40;
function parseLabels(json: unknown): Record<string, string> {
  try {
    const value = JSON.parse(String(json ?? '{}'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}
/** Keep only short, non-empty names of cycles that are in the list; null when malformed. */
export function cleanLabels(labels: unknown, dates: string[]): Record<string, string> | null {
  if (labels === undefined) return {};
  if (!labels || typeof labels !== 'object' || Array.isArray(labels)) return null;
  const out: Record<string, string> = {};
  for (const [date, raw] of Object.entries(labels)) {
    if (typeof raw !== 'string') return null;
    const label = raw.trim();
    if (label.length > MAX_LABEL_LENGTH) return null;
    if (label && dates.includes(date)) out[date] = label;
  }
  return out;
}
/** A list that can still act on its owner's next turn. */
export const activeList = (p: Preference | undefined): p is Preference =>
  !!p && p.active !== false && p.dates.length > 0;
/**
 * The instant (ms) from which the list may choose at the turn opened at `cursor`.
 * null: never on its own (no list, manual mode, or a wait whose start is unknown yet).
 */
export function automaticAt(p: Preference | undefined, state: ElectionState, cursor: number): number | null {
  if (!activeList(p) || p.mode === 'manual') return null;
  if (p.mode !== 'wait') return 0;
  if (state.turnSince?.cursor !== cursor) return null;
  return Date.parse(state.turnSince.at) + (p.waitMinutes ?? 0) * 60_000;
}
/** Restart the turn clock when a new turn opens, or when choosing resumes (`restart`). */
export function stampTurn(
  state: ElectionState | null,
  cursor: number,
  at: string,
  restart = false,
): ElectionState | null {
  if (!state || state.status !== 'active') return state;
  if (!restart && state.turnSince?.cursor === cursor) return state;
  return { ...state, turnSince: { cursor, at } };
}
// A one-turn list is consumed by a confirmed choice, not by a deferral.
export function visiblePreferenceDates(
  dates: string[],
  cycles: { date: string; occupied: number; max: number; available?: boolean }[],
): string[] {
  const byDate = new Map(cycles.map((c) => [c.date, c]));
  return dates.filter((date) => {
    const cycle = byDate.get(date);
    return !!cycle && (cycle.available ?? cycle.occupied < cycle.max);
  });
}
export function togglePreferenceDate(dates: string[], date: string, available: boolean): string[] {
  if (dates.includes(date)) return dates.filter((d) => d !== date);
  return available ? [...dates, date] : dates;
}
export function consumePreferences(preferences: Preference[], memberIds: string[]): Preference[] {
  const consumed = new Set(memberIds);
  return preferences.map((p) => (consumed.has(p.member_id) && !p.persistent ? { ...p, active: false } : p));
}
export type ElectionContext = {
  year: number;
  team: string;
  config: Config;
  members: Member[];
  requests: Request[];
  awards: Award[];
};
export type Choice = { member_id: string; cycle_date: string };
export type JointChoice = { member_id: string; dates: string[] };
const count = (ctx: ElectionContext, id: string) => ctx.awards.filter((a) => a.member_id === id).length;
export function entitlementFor(ctx: ElectionContext, id: string): number {
  const member = ctx.members.find((m) => m.id === id);
  if (!member) throw new Error('Controlador ajeno a la campaña');
  return policyOf(ctx).entitlement(ctx.config, member);
}
export function validateOrder(order: unknown, members: Member[]): asserts order is string[] {
  if (
    !Array.isArray(order) ||
    order.length !== members.length ||
    !order.length ||
    new Set(order).size !== order.length ||
    order.some((id) => !members.some((m) => m.id === id))
  )
    throw new Error('El orden debe incluir una vez a cada controlador del equipo');
}
export function validateElectionState(state: ElectionState, members: Member[]) {
  validateOrder(state.order, members);
  if (
    !['active', 'paused', 'complete'].includes(state.status) ||
    !Number.isInteger(state.cursor) ||
    state.cursor < 0 ||
    state.cursor > 1000000 ||
    typeof state.source !== 'string' ||
    typeof state.allowDeferral !== 'boolean' ||
    !state.credits ||
    (state.automaticPaused !== undefined && typeof state.automaticPaused !== 'boolean') ||
    Object.entries(state.credits).some(([id, credit]) => !state.order.includes(id) || ![0, 1, 2].includes(credit))
  )
    throw new Error('Estado de elección no válido');
  for (const [name, groups] of [
    ['tieGroups', state.tieGroups ?? []],
    ['jointGroups', state.jointGroups ?? []],
  ] as const) {
    if (!Array.isArray(groups)) throw new Error('Grupos de elección no válidos');
    const used = new Set<string>();
    for (const group of groups) {
      if (
        !Array.isArray(group) ||
        group.length < 2 ||
        group.length > (name === 'jointGroups' ? 3 : state.order.length) ||
        new Set(group).size !== group.length ||
        group.some((id) => !state.order.includes(id) || used.has(id))
      )
        throw new Error('Grupos de elección no válidos');
      group.forEach((id) => used.add(id));
      if (name === 'tieGroups') {
        const indices = group.map((id) => state.order.indexOf(id));
        const first = Math.min(...indices);
        if (
          indices.some((index) => index < first || index >= first + group.length) ||
          group.some((id, i) => state.order[first + i] !== id)
        )
          throw new Error('Los empatados deben ser consecutivos y respetar el orden sorteado');
      }
    }
  }
  if (state.jointAgreements !== undefined) {
    if (!Array.isArray(state.jointAgreements)) throw new Error('Acuerdos de turno conjunto inválidos');
    const perRound = new Map<number, Set<string>>();
    for (const agreement of state.jointAgreements) {
      if (
        !Number.isInteger(agreement.round) ||
        agreement.round < 1 ||
        agreement.round > 100 ||
        !Array.isArray(agreement.members) ||
        agreement.members.length < 2 ||
        agreement.members.length > 3 ||
        new Set(agreement.members).size !== agreement.members.length ||
        agreement.members.some((id) => !state.order.includes(id)) ||
        typeof agreement.actor !== 'string' ||
        typeof agreement.at !== 'string' ||
        (agreement.cancelledAt !== undefined && typeof agreement.cancelledAt !== 'string') ||
        (agreement.cancelledBy !== undefined && typeof agreement.cancelledBy !== 'string')
      )
        throw new Error('Acuerdos de turno conjunto inválidos');
      if (agreement.cancelledAt) continue;
      const used = perRound.get(agreement.round) ?? new Set<string>();
      if (agreement.members.some((id) => used.has(id) || (state.jointGroups ?? []).some((g) => g.includes(id))))
        throw new Error('Controlador presente en más de un grupo conjunto');
      agreement.members.forEach((id) => used.add(id));
      perRound.set(agreement.round, used);
    }
  }
  if (
    state.turnSince !== undefined &&
    (!state.turnSince ||
      !Number.isInteger(state.turnSince.cursor) ||
      typeof state.turnSince.at !== 'string' ||
      Number.isNaN(Date.parse(state.turnSince.at)))
  )
    throw new Error('Inicio de turno no válido');
  if (
    state.pendingTieGroups !== undefined &&
    (!Array.isArray(state.pendingTieGroups) ||
      state.pendingTieGroups.some(
        (group) =>
          !Array.isArray(group) ||
          !(state.tieGroups ?? []).some((tie) => tie.length === group.length && tie.every((id, i) => id === group[i])),
      ))
  )
    throw new Error('Empates pendientes no válidos');
  if (
    state.tieResolutions !== undefined &&
    (!Array.isArray(state.tieResolutions) ||
      state.tieResolutions.some(
        (r) =>
          !r ||
          !['random', 'external'].includes(r.method) ||
          typeof r.at !== 'string' ||
          typeof r.actor !== 'string' ||
          !Array.isArray(r.order) ||
          r.order.length < 2 ||
          new Set(r.order).size !== r.order.length ||
          r.order.some((id) => !state.order.includes(id)) ||
          (r.anticipated !== undefined && typeof r.anticipated !== 'boolean'),
      ))
  )
    throw new Error('Actas de sorteo no válidas');
  if (state.format !== undefined && state.format !== ELECTION_STATE_FORMAT)
    throw new Error('Formato de estado de elección no admitido');
  if (state.earlyChoices !== undefined) {
    const n = state.order.length;
    if (
      !Array.isArray(state.earlyChoices) ||
      new Set(state.earlyChoices.map((e) => e?.awardId)).size !== state.earlyChoices.length ||
      state.earlyChoices.some(
        (e) =>
          !e ||
          !state.order.includes(e.memberId) ||
          !Number.isInteger(e.cursor) ||
          e.cursor < 0 ||
          e.cursor > 1000000 ||
          e.round !== Math.floor(e.cursor / n) + 1 ||
          typeof e.awardId !== 'string' ||
          !e.awardId ||
          typeof e.at !== 'string' ||
          Number.isNaN(Date.parse(e.at)),
      )
    )
      throw new Error('Elecciones anticipadas no válidas');
  }
}
/** The campaign's turn sequence, with each member's entitlement taken from the year's policy. */
export function sequenceFor(ctx: ElectionContext, state: ElectionState): SequenceInput {
  return {
    state,
    awards: ctx.awards,
    entitlement: (id) => entitlementFor(ctx, id),
    unitsInRound: policyOf(ctx).unitsInRound,
    maxRounds: ctx.config.cyclesPerPerson + 4,
  };
}
export function currentTurn(ctx: ElectionContext, input: ElectionState) {
  const state = structuredClone(input);
  validateElectionState(state, ctx.members);
  const n = state.order.length;
  const round = Math.floor(state.cursor / n) + 1;
  if (state.status !== 'active')
    return {
      state,
      memberId: null,
      needed: 0,
      round,
      participants: [] as string[],
      requiredByMember: {} as Record<string, number>,
    };
  const slot = nextSlot(sequenceFor(ctx, state));
  for (const id of slot.spentCredits ?? []) state.credits[id] = 0;
  if ('complete' in slot) {
    const rules = occupancyOf(ctx);
    if (rules) {
      const evaluation = rules.evaluateFinal(rules.state(ctx, ctx.members, ctx.awards));
      if (!evaluation.valid)
        throw new Error('No se puede finalizar la elección: ' + evaluation.issues.map((i) => i.message).join('; '));
    }
    state.status = 'complete';
    return {
      state,
      memberId: null,
      needed: 0,
      round,
      participants: [] as string[],
      requiredByMember: {} as Record<string, number>,
    };
  }
  state.cursor = slot.cursor;
  if (slot.pendingTie)
    return {
      state,
      memberId: null,
      needed: 0,
      round: slot.round,
      participants: [] as string[],
      requiredByMember: {} as Record<string, number>,
      pendingTie: slot.pendingTie,
    };
  const { participants, requiredByMember } = slot;
  return {
    state,
    memberId: participants[participants.length - 1],
    needed: Object.values(requiredByMember).reduce((a, b) => a + b, 0),
    round: slot.round,
    participants,
    requiredByMember,
  };
}
/** Resolve a specific pending tie ahead of its turn, without consuming any election slot. */
export function resolveTie(
  ctx: ElectionContext,
  input: ElectionState,
  order: string[],
  method: 'random' | 'external',
  actor: string,
  at: string,
  groupMemberIds?: string[],
) {
  const turn = currentTurn(ctx, input);
  const group =
    groupMemberIds === undefined
      ? turn.pendingTie
      : Array.isArray(groupMemberIds)
        ? (input.pendingTieGroups ?? []).find(
            (pending) => pending.length === groupMemberIds.length && pending.every((id) => groupMemberIds.includes(id)),
          )
        : undefined;
  if (!group) throw new Error('No hay un empate pendiente para ese grupo');
  if (
    !Array.isArray(order) ||
    order.length !== group.length ||
    new Set(order).size !== order.length ||
    order.some((id) => !group.includes(id))
  )
    throw new Error('El orden debe incluir una vez a cada persona empatada');
  const state = groupMemberIds === undefined ? turn.state : structuredClone(input),
    first = state.order.indexOf(group[0]);
  state.order.splice(first, group.length, ...order);
  state.tieGroups = state.tieGroups!.map((g) =>
    g === group || (g.length === group.length && g.every((id, i) => id === group[i])) ? [...order] : g,
  );
  state.pendingTieGroups = state.pendingTieGroups!.filter((g) => !g.includes(group[0]));
  const anticipated = groupMemberIds !== undefined && (!turn.pendingTie || !turn.pendingTie.includes(group[0]));
  state.tieResolutions = [...(state.tieResolutions ?? []), { order: [...order], method, actor, at, anticipated }];
  validateElectionState(state, ctx.members);
  return state;
}

/** Register a temporary joint turn without consuming a choice or altering earlier rounds. */
export function registerJointAgreement(
  ctx: ElectionContext,
  input: ElectionState,
  members: string[],
  round: number,
  actor: string,
  at: string,
): ElectionState {
  const turn = currentTurn(ctx, input),
    state = turn.state,
    n = state.order.length,
    currentRound = Math.floor(state.cursor / n) + 1;
  if (state.status !== 'active') throw new Error('La elección no está activa');
  if (
    !Array.isArray(members) ||
    members.length < 2 ||
    members.length > 3 ||
    new Set(members).size !== members.length ||
    members.some((id) => !state.order.includes(id))
  )
    throw new Error('Selecciona dos o tres controladores diferentes');
  if (!Number.isInteger(round) || round < currentRound || round > ctx.config.cyclesPerPerson)
    throw new Error('Solo pueden acordarse turnos de la ronda actual o una futura');
  if (members.some((id) => count(ctx, id) >= entitlementFor(ctx, id)))
    throw new Error('Hay controladores que ya han terminado sus ciclos');
  if (members.some((id) => (state.pendingTieGroups ?? []).some((t) => t.includes(id))))
    throw new Error('Resuelve el empate antes de agrupar a sus integrantes');
  const ordered = orderForRound(state, round - 1),
    first = Math.min(...members.map((id) => ordered.indexOf(id)));
  if (round === currentRound && first < state.cursor % n)
    throw new Error('El primer turno del grupo ya ha pasado en esta ronda');
  const all = [
    ...(state.jointGroups ?? []),
    ...(state.jointAgreements ?? []).filter((a) => a.round === round && !a.cancelledAt).map((a) => a.members),
  ];
  if (all.some((g) => g.some((id) => members.includes(id))))
    throw new Error('Algún controlador ya pertenece a otro turno conjunto de esta ronda');
  state.jointAgreements = [
    ...(state.jointAgreements ?? []),
    { round, members: ordered.filter((id) => members.includes(id)), actor, at },
  ];
  validateElectionState(state, ctx.members);
  return state;
}
/** Cancel only before the first participant's effective slot has been passed. */
export function cancelJointAgreement(
  ctx: ElectionContext,
  input: ElectionState,
  members: string[],
  round: number,
  actor: string,
  at: string,
): ElectionState {
  const state = structuredClone(input);
  validateElectionState(state, ctx.members);
  const n = state.order.length;
  if (state.status !== 'active') throw new Error('La elección no está activa');
  const agreement = state.jointAgreements?.find(
    (a) =>
      a.round === round &&
      !a.cancelledAt &&
      a.members.length === members.length &&
      a.members.every((id) => members.includes(id)),
  );
  if (!agreement) throw new Error('No existe ese acuerdo activo');
  const ordered = orderForRound(state, round - 1),
    first = Math.min(...members.map((id) => ordered.indexOf(id)));
  if (
    round < Math.floor(state.cursor / n) + 1 ||
    (round === Math.floor(state.cursor / n) + 1 && first < state.cursor % n)
  )
    throw new Error('El turno conjunto ya ha empezado; utiliza reconstrucción');
  agreement.cancelledAt = at;
  agreement.cancelledBy = actor;
  validateElectionState(state, ctx.members);
  return state;
}

// Unbiased Fisher–Yates, with rejection sampling of cryptographically random integers.
export function drawTie(group: string[]): string[] {
  const order = [...group],
    word = new Uint32Array(1);
  for (let i = order.length - 1; i > 0; i--) {
    const size = i + 1,
      limit = 0x100000000 - (0x100000000 % size);
    let value: number;
    do {
      crypto.getRandomValues(word);
      value = word[0];
    } while (value >= limit);
    const j = value % size;
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}
export function choiceIssues(ctx: ElectionContext, memberId: string, dates: string[]) {
  if (!ctx.members.some((m) => m.id === memberId)) return ['Controlador ajeno a la campaña'];
  if (new Set(dates).size !== dates.length) return ['No se puede elegir el mismo ciclo dos veces'];
  if (dates.some((d) => ctx.awards.some((a) => a.member_id === memberId && a.cycle_date === d)))
    return ['Este controlador ya tiene uno de esos ciclos'];
  const rules = occupancyOf(ctx);
  if (rules) {
    const state = rules.state(ctx, ctx.members, ctx.awards);
    // Admission consumes issues only; informative warnings belong to preflight.
    const check = rules.evaluateCandidate(
      state,
      dates.map((cycle_date) => ({ member_id: memberId, cycle_date })),
      { maxChecks: rules.budgets.commit, warnings: false, exact: true },
    );
    return check.issues.map((i) => i.message);
  }
  const awards = [
    ...ctx.awards,
    ...dates.map((d, i) => ({ id: 'candidate-' + i, member_id: memberId, cycle_date: d })),
  ];
  return calculate(ctx.year, ctx.team, ctx.config, ctx.members, ctx.requests, awards).issues;
}
export function choose(ctx: ElectionContext, input: ElectionState, memberId: string, dates: string[]) {
  const turn = currentTurn(ctx, input);
  if (turn.memberId !== memberId || turn.participants.length !== 1)
    throw new Error('No es el turno individual de este controlador');
  if (dates.length !== turn.needed) throw new Error('En este turno corresponde elegir ' + turn.needed + ' ciclo(s)');
  const issues = choiceIssues(ctx, memberId, dates);
  if (issues.length) throw new Error(issues.join('; '));
  const state = turn.state;
  state.credits[memberId] = 0;
  state.cursor++;
  const choices = dates.map((d) => ({ member_id: memberId, cycle_date: d }));
  const next = currentTurn(
    { ...ctx, awards: [...ctx.awards, ...choices.map((c, i) => ({ ...c, id: 'chosen-' + i }))] },
    state,
  );
  return { state: next.state, choices };
}
export function chooseJoint(ctx: ElectionContext, input: ElectionState, entries: JointChoice[]) {
  const turn = currentTurn(ctx, input);
  if (turn.participants.length < 2) throw new Error('No corresponde un turno conjunto');
  if (
    entries.length !== turn.participants.length ||
    new Set(entries.map((e) => e.member_id)).size !== entries.length ||
    entries.some(
      (e) =>
        !turn.participants.includes(e.member_id) ||
        !Array.isArray(e.dates) ||
        e.dates.length !== turn.requiredByMember[e.member_id],
    )
  )
    throw new Error('El turno conjunto debe incluir las elecciones de todos sus participantes');
  const choices: Choice[] = turn.participants.flatMap((person) => {
    const entry = entries.find((e) => e.member_id === person)!;
    return entry.dates.map((date) => ({ member_id: person, cycle_date: date }));
  });
  const rules = occupancyOf(ctx);
  if (rules) {
    // Validate the whole proposed batch, not its members sequentially.
    const check = rules.evaluateCandidate(
      rules.state(ctx, ctx.members, ctx.awards),
      choices.map((c) => ({ member_id: c.member_id, cycle_date: c.cycle_date })),
      { maxChecks: rules.budgets.commit, warnings: false, exact: true },
    );
    if (!check.allowed) throw new Error(check.issues.map((i) => i.message).join('; '));
  } else {
    const incremental: Choice[] = [];
    for (const person of turn.participants) {
      const entry = entries.find((e) => e.member_id === person)!;
      const nextContext = {
        ...ctx,
        awards: [...ctx.awards, ...incremental.map((c, i) => ({ ...c, id: 'joint-' + i }))],
      };
      const issues = choiceIssues(nextContext, person, entry.dates);
      if (issues.length) throw new Error(issues.join('; '));
      incremental.push(...entry.dates.map((date) => ({ member_id: person, cycle_date: date })));
    }
  }
  const state = turn.state;
  turn.participants.forEach((person) => {
    state.credits[person] = 0;
  });
  state.cursor++;
  const next = currentTurn(
    { ...ctx, awards: [...ctx.awards, ...choices.map((c, i) => ({ ...c, id: 'joint-' + i }))] },
    state,
  );
  return { state: next.state, choices };
}
export function defer(ctx: ElectionContext, input: ElectionState, memberId: string) {
  const turn = currentTurn(ctx, input);
  if (turn.memberId !== memberId || turn.participants.length !== 1)
    throw new Error('No es el turno individual de este controlador');
  if (!input.allowDeferral) throw new Error('El aplazamiento no está habilitado para esta campaña');
  const credits = input.credits[memberId] ?? 0;
  const remaining = entitlementFor(ctx, memberId) - count(ctx, memberId);
  if (credits >= 2 || remaining <= credits + 1)
    throw new Error('No se puede acumular otro aplazamiento ni aplazar los últimos ciclos');
  turn.state.credits[memberId] = credits + 1;
  turn.state.cursor++;
  return currentTurn(ctx, turn.state).state;
}
/** Whether the list of whoever holds the turn may choose for them now (`now` in ms). */
export function preferredChoice(
  ctx: ElectionContext,
  state: ElectionState,
  preferences: Preference[],
  now = Date.now(),
) {
  if (state.automaticPaused) return null;
  const turn = currentTurn(ctx, state);
  if (turn.participants.length !== 1 || !turn.memberId) return null;
  // A saved preference list is an advance instruction to choose; legacy automatic=false is ignored.
  const pref = preferences.find((p) => p.member_id === turn.memberId && p.active !== false);
  const at = automaticAt(pref, turn.state, turn.state.cursor);
  if (at === null || at > now) return null;
  return listChoice(ctx, turn, pref!);
}
/** The first combination of the list valid for this turn, whatever the list's mode. */
export function listChoice(
  ctx: ElectionContext,
  turn: { memberId: string | null; needed: number },
  pref: Preference,
): string[] | null {
  if (!turn.memberId) return null;
  const needed = turn.needed;
  // Explicit bounded backtracking avoids accepting a pair/triple that breaks joint quota accounting.
  let budget = 3000;
  const search = (at: number, selected: string[]): string[] | null => {
    if (selected.length === needed) return selected;
    for (let i = at; i < pref.dates.length && budget-- > 0; i++) {
      const candidate = [...selected, pref.dates[i]];
      if (choiceIssues(ctx, turn.memberId!, candidate).length) continue;
      const found = search(i + 1, candidate);
      if (found) return found;
    }
    return null;
  };
  return search(0, []);
}
export function advanceAutomatic(
  ctx: ElectionContext,
  input: ElectionState,
  preferences: Preference[],
  maxTurns = 12,
  now = Date.now(),
) {
  let state = currentTurn(ctx, input).state;
  const choices: Choice[] = [];
  let remainingPreferences = preferences;
  for (let step = 0; step < maxTurns; step++) {
    const context = { ...ctx, awards: [...ctx.awards, ...choices.map((c, i) => ({ ...c, id: 'automatic-' + i }))] },
      turn = currentTurn(context, state);
    state = turn.state;
    const dates = preferredChoice(context, state, remainingPreferences, now);
    if (!dates || !turn.memberId) break;
    const next = choose(context, state, turn.memberId, dates);
    choices.push(...next.choices);
    state = next.state;
    remainingPreferences = consumePreferences(remainingPreferences, [turn.memberId]);
  }
  const finalContext = { ...ctx, awards: [...ctx.awards, ...choices.map((c, i) => ({ ...c, id: 'automatic-' + i }))] };
  return {
    state,
    choices,
    preferences: remainingPreferences,
    pendingAutomatic: !!preferredChoice(finalContext, state, remainingPreferences, now),
  };
}
export type QueueEntry = { memberId: string; mode: PreferenceMode | 'none'; waitMinutes: number; current: boolean };
/** Who still has to choose in the current round, from the turn on, and how each list will act.
 * Managers see this; it never says which cycles a list contains. */
export function roundQueue(ctx: ElectionContext, state: ElectionState, preferences: Preference[]): QueueEntry[] {
  const n = state.order.length,
    start = state.cursor % n,
    round = Math.floor(state.cursor / n);
  return orderForRound(state, round)
    .slice(start)
    .filter((id) => count(ctx, id) < entitlementFor(ctx, id))
    .map((id, i) => {
      const p = preferences.find((x) => x.member_id === id);
      return {
        memberId: id,
        mode: activeList(p) ? (p.mode ?? 'immediate') : 'none',
        waitMinutes: activeList(p) && p.mode === 'wait' ? (p.waitMinutes ?? 0) : 0,
        current: i === 0,
      };
    });
}
export type ChainStop = {
  memberId: string | null;
  reason: 'wait' | 'manual' | 'no-option' | 'joint' | 'tie' | 'complete' | 'limit';
  waitMinutes?: number;
};
/**
 * What resuming the election would do right now: the turns that lists resolve at
 * once (with their cycles), and where it stops. A 'wait' list stops it, because
 * resuming restarts its clock.
 */
export function automaticChain(
  ctx: ElectionContext,
  input: ElectionState,
  preferences: Preference[],
  maxTurns = 8,
): { applied: { memberId: string; dates: string[] }[]; stop: ChainStop } {
  let state: ElectionState = { ...structuredClone(input), status: 'active', automaticPaused: false };
  let awards = ctx.awards,
    remaining = preferences;
  const applied: { memberId: string; dates: string[] }[] = [];
  for (let step = 0; step < maxTurns; step++) {
    const context = { ...ctx, awards },
      turn = currentTurn(context, state);
    if (turn.state.status === 'complete') return { applied, stop: { memberId: null, reason: 'complete' } };
    if (turn.pendingTie) return { applied, stop: { memberId: null, reason: 'tie' } };
    if (!turn.memberId) return { applied, stop: { memberId: null, reason: 'complete' } };
    if (turn.participants.length !== 1) return { applied, stop: { memberId: turn.memberId, reason: 'joint' } };
    const pref = remaining.find((p) => p.member_id === turn.memberId && p.active !== false);
    if (!activeList(pref) || pref.mode === 'manual')
      return { applied, stop: { memberId: turn.memberId, reason: 'manual' } };
    if (pref.mode === 'wait')
      return { applied, stop: { memberId: turn.memberId, reason: 'wait', waitMinutes: pref.waitMinutes ?? 0 } };
    const dates = listChoice(context, turn, pref);
    if (!dates) return { applied, stop: { memberId: turn.memberId, reason: 'no-option' } };
    const next = choose(context, turn.state, turn.memberId, dates);
    applied.push({ memberId: turn.memberId, dates });
    awards = [...awards, ...next.choices.map((c, i) => ({ ...c, id: 'chain-' + step + '-' + i }))];
    state = next.state;
    remaining = consumePreferences(remaining, [turn.memberId]);
  }
  return { applied, stop: { memberId: null, reason: 'limit' } };
}
