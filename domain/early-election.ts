import { choiceIssues, currentTurn, sequenceFor, type ElectionContext, type ElectionState } from './election.ts';
import { nextSlot, turnsBefore } from './sequence.ts';
import { occupancyOf, policyOf } from './policy.ts';

/**
 * Early election, first iteration: a controller may take a cycle ahead of their slot
 * only when exactly ONE individual turn stands between them and their own individual
 * slot. With one predecessor the proof is exact: enumerate every legal choice of the
 * predecessor and require that the predecessor's choice and the early cycle are
 * jointly valid under the year's policy. That single batch check means both that the
 * early cycle never takes an option from the predecessor and that it stays available
 * after whatever the predecessor chooses. Running out of budget never proves anything.
 */
export type EarlyWindow = {
  memberId: string;
  predecessor: string;
  /** Cycles the predecessor chooses in their turn. */
  predecessorNeeds: number;
  /** Absolute cursor and 1-based round of the member's own slot. */
  cursor: number;
  round: number;
  /** Cycles still owed at that slot, early ones already discounted. */
  owed: number;
};
export type EarlyProof = {
  window: EarlyWindow;
  /** Cycles proved safe to take now, in calendar order. */
  guaranteed: string[];
  /** The budget ran out: cycles not listed may still be safe, but are not offered. */
  indeterminate: boolean;
};
/** Batch evaluations per proof: one per (predecessor choice, candidate cycle). */
export const EARLY_PROOF_BUDGET = 1500;

export function earlyWindow(ctx: ElectionContext, input: ElectionState, memberId: string): EarlyWindow | null {
  if (input.status !== 'active') return null;
  let turn;
  try {
    turn = currentTurn(ctx, input);
  } catch {
    return null;
  }
  const state = turn.state;
  if (turn.pendingTie || turn.participants.length !== 1 || !turn.memberId || turn.memberId === memberId) return null;
  const seq = sequenceFor(ctx, state);
  const ahead = turnsBefore(seq, memberId);
  if (!ahead || ahead.length !== 1 || ahead[0].cursor !== state.cursor) return null;
  const predecessor = turn.memberId,
    predecessorNeeds = turn.needed;
  // The member's slot, once the predecessor has chosen what they owe.
  const after = nextSlot({
    ...seq,
    state: { ...state, cursor: state.cursor + 1, credits: { ...state.credits, [predecessor]: 0 } },
    awards: [...ctx.awards, ...Array.from({ length: predecessorNeeds }, () => ({ member_id: predecessor }))],
  });
  if ('complete' in after || after.pendingTie || after.participants.length !== 1 || after.participants[0] !== memberId)
    return null;
  const owed = after.requiredByMember[memberId] ?? 0;
  if (owed < 1) return null;
  return { memberId, predecessor, predecessorNeeds, cursor: after.cursor, round: after.round, owed };
}

function combinations(items: string[], k: number, limit: number): string[][] | null {
  const out: string[][] = [];
  const walk = (at: number, picked: string[]): boolean => {
    if (picked.length === k) {
      out.push(picked);
      return out.length <= limit;
    }
    for (let i = at; i < items.length; i++) if (!walk(i + 1, [...picked, items[i]])) return false;
    return true;
  };
  return walk(0, []) ? out : null;
}

/** Whether the batch (several members' cycles at once) is admissible now. */
function batchAllowed(ctx: ElectionContext, batch: { member_id: string; cycle_date: string }[]): boolean {
  const rules = occupancyOf(ctx);
  if (rules) {
    const check = rules.evaluateCandidate(rules.state(ctx, ctx.members, ctx.awards), batch, {
      maxChecks: rules.budgets.commit,
      warnings: false,
      exact: true,
    });
    return check.allowed;
  }
  // Without an occupancy engine, validate member by member on the growing allocation.
  let awards = ctx.awards;
  for (const member of new Set(batch.map((b) => b.member_id))) {
    const dates = batch.filter((b) => b.member_id === member).map((b) => b.cycle_date);
    if (choiceIssues({ ...ctx, awards }, member, dates).length) return false;
    awards = [
      ...awards,
      ...dates.map((cycle_date, i) => ({ id: 'early-' + member + i, member_id: member, cycle_date })),
    ];
  }
  return true;
}

/**
 * The usual case with an occupancy engine: the predecessor chooses one cycle. Taking X
 * is safe when every cycle the predecessor may choose now (legal or still unknown) is
 * still legal once X is taken: each pair is then one admissible allocation, which also
 * keeps X available after any of those choices. One legal-choices search per candidate.
 */
function singleCycleProof(
  ctx: ElectionContext,
  window: EarlyWindow,
  dates: string[],
  options: { only?: string[]; budget?: number },
): EarlyProof {
  const rules = occupancyOf(ctx)!;
  let budget = options.budget ?? EARLY_PROOF_BUDGET;
  const base = rules.state(ctx, ctx.members, ctx.awards);
  const mine = rules.legalChoices(base, window.memberId),
    theirs = rules.legalChoices(base, window.predecessor);
  const contested = [...theirs.legal, ...theirs.unknown];
  const wanted = new Set(options.only ?? dates);
  const candidates = mine.legal.filter((date) => wanted.has(date) && dates.includes(date));
  const guaranteed: string[] = [];
  let indeterminate = mine.unknown.some((date) => wanted.has(date));
  for (const date of candidates) {
    if (budget-- <= 0) {
      indeterminate = true;
      break;
    }
    const taken = [...ctx.awards, { id: 'early-candidate', member_id: window.memberId, cycle_date: date }];
    const after = rules.legalChoices(rules.state(ctx, ctx.members, taken), window.predecessor);
    const still = new Set(after.legal);
    if (contested.every((cycle) => still.has(cycle))) guaranteed.push(date);
    else if (after.unknown.length) indeterminate = true;
  }
  return { window, guaranteed: dates.filter((date) => guaranteed.includes(date)), indeterminate };
}

/**
 * Units independent of each other (VA days, ADR 0002 §3 quater): whatever the predecessor
 * owes, taking X now is safe when they cannot take X anyway or X keeps two free places.
 * Exact and without search, so no budget applies.
 */
function independentProof(
  ctx: ElectionContext,
  window: EarlyWindow,
  dates: string[],
  options: { only?: string[] },
): EarlyProof {
  const rules = occupancyOf(ctx)!;
  const state = rules.state(ctx, ctx.members, ctx.awards);
  const mine = new Set(rules.legalChoices(state, window.memberId).legal),
    theirs = new Set(rules.legalChoices(state, window.predecessor).legal);
  const occupied = new Map<string, number>();
  for (const a of ctx.awards) occupied.set(a.cycle_date, (occupied.get(a.cycle_date) ?? 0) + 1);
  const wanted = new Set(options.only ?? dates);
  const guaranteed = dates.filter(
    (date) =>
      wanted.has(date) &&
      mine.has(date) &&
      (!theirs.has(date) || rules.cycleMaximum(ctx, date) - (occupied.get(date) ?? 0) >= 2),
  );
  return { window, guaranteed, indeterminate: false };
}

/**
 * The cycles `memberId` may take now (see the module comment), or null outside a
 * window. `only` restricts the proof to some candidate cycles (a commit rechecks one).
 */
export function earlyProof(
  ctx: ElectionContext,
  state: ElectionState,
  memberId: string,
  dates: string[],
  options: { only?: string[]; budget?: number } = {},
): EarlyProof | null {
  const window = earlyWindow(ctx, state, memberId);
  if (!window) return null;
  const rules = occupancyOf(ctx);
  if (rules && policyOf(ctx).independentUnits) return independentProof(ctx, window, dates, options);
  if (rules && window.predecessorNeeds === 1) return singleCycleProof(ctx, window, dates, options);
  let budget = options.budget ?? EARLY_PROOF_BUDGET;
  const owned = (id: string) => new Set(ctx.awards.filter((a) => a.member_id === id).map((a) => a.cycle_date));
  const mine = owned(memberId),
    theirs = owned(window.predecessor);
  const candidates = (options.only ?? dates).filter(
    (date) => dates.includes(date) && !mine.has(date) && !choiceIssues(ctx, memberId, [date]).length,
  );
  if (!candidates.length) return { window, guaranteed: [], indeterminate: false };
  // Every legal choice of the predecessor, before the early cycle exists.
  const options_ = dates.filter((date) => !theirs.has(date));
  const sets = combinations(options_, window.predecessorNeeds, budget);
  if (!sets) return { window, guaranteed: [], indeterminate: true };
  const legal: string[][] = [];
  for (const set of sets) {
    if (budget-- <= 0) return { window, guaranteed: [], indeterminate: true };
    if (!choiceIssues(ctx, window.predecessor, set).length) legal.push(set);
  }
  // No legal choice at all means the turn cannot be played: nothing to prove against.
  if (!legal.length) return { window, guaranteed: [], indeterminate: true };
  const guaranteed: string[] = [];
  let indeterminate = false;
  for (const date of candidates) {
    let safe = true;
    for (const set of legal) {
      if (budget-- <= 0) {
        indeterminate = true;
        safe = false;
        break;
      }
      const batch = [
        ...set.map((cycle_date) => ({ member_id: window.predecessor, cycle_date })),
        { member_id: memberId, cycle_date: date },
      ];
      if (!batchAllowed(ctx, batch)) {
        safe = false;
        break;
      }
    }
    if (indeterminate) break;
    if (safe) guaranteed.push(date);
  }
  return { window, guaranteed, indeterminate };
}

/** The early choice entry stored in the election state with its award. */
export function earlyEntry(window: EarlyWindow, awardId: string, at: string) {
  return { memberId: window.memberId, round: window.round, cursor: window.cursor, awardId, at };
}

/**
 * What a viewer who is neither an administrator nor the owner may know of the early
 * choices still waiting for their slot: nothing. Hiding them keeps anybody ahead from
 * learning what those behind them chose, and so from waiting to see it. Their awards and
 * entries leave the view until the turn reaches their slot, when they show as ordinary
 * choices. The proof guarantees that a pending early cycle never removes an option from
 * the turn in play, so the masked view offers the same choices as the real one.
 */
export function concealPendingEarly<A extends { id: string }>(
  ctx: ElectionContext,
  state: ElectionState,
  viewer: string | null,
  awards: readonly A[],
): { awards: A[]; state: ElectionState; hidden: Set<string> } {
  const entries = state.earlyChoices ?? [];
  if (!entries.length) return { awards: [...awards], state, hidden: new Set() };
  let cursor = state.cursor;
  try {
    cursor = currentTurn(ctx, state).state.cursor;
  } catch {
    /* An unresolvable turn hides nothing more than the stored cursor says. */
  }
  const hidden = new Set(entries.filter((e) => e.memberId !== viewer && e.cursor > cursor).map((e) => e.awardId));
  if (!hidden.size) return { awards: [...awards], state, hidden };
  return {
    awards: awards.filter((a) => !hidden.has(a.id)),
    state: { ...state, earlyChoices: entries.filter((e) => !hidden.has(e.awardId)) },
    hidden,
  };
}
