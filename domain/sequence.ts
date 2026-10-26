import type { ElectionState } from './election.ts';

/**
 * The turn sequence, independent of the year's policy: each member's entitlement
 * comes in as a function, so this module never imports domain/policy.ts.
 */
export type SequenceInput = {
  state: ElectionState;
  awards: readonly { member_id: string }[];
  entitlement: (memberId: string) => number;
  /** Scan bound, in rounds from the cursor. */
  maxRounds: number;
};
/** An effective slot: the (absolute) cursor it sits on, its 1-based round, who chooses
 * and how many cycles each. A pending tie blocks the slot: no participants yet. */
export type TurnSlot = {
  cursor: number;
  round: number;
  participants: string[];
  requiredByMember: Record<string, number>;
  pendingTie?: string[];
};
export type SequenceEnd = { complete: true };

export function orderForRound(state: ElectionState, round: number): string[] {
  const result = [...state.order];
  for (const group of state.tieGroups ?? []) {
    const first = state.order.indexOf(group[0]),
      offset = round % group.length;
    result.splice(first, group.length, ...group.slice(offset), ...group.slice(0, offset));
  }
  return result;
}

function awardCounts(awards: readonly { member_id: string }[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const a of awards) counts.set(a.member_id, (counts.get(a.member_id) ?? 0) + 1);
  return counts;
}
// The scan behind both nextSlot and turnsBefore, over explicit counts and credits.
function slotFrom(
  seq: SequenceInput,
  cursor: number,
  counts: Map<string, number>,
  credits: Record<string, number>,
): TurnSlot | SequenceEnd {
  const { state } = seq,
    n = state.order.length;
  const remaining = (id: string) => seq.entitlement(id) - (counts.get(id) ?? 0);
  if (state.order.every((id) => remaining(id) <= 0)) return { complete: true };
  // Cycles already chosen ahead of time for a given slot count as played there.
  const early = (id: string, at: number) =>
    (state.earlyChoices ?? []).filter((e) => e.memberId === id && e.cursor === at).length;
  const owed = (id: string, at: number) => Math.max(0, Math.min(1 + (credits[id] ?? 0) - early(id, at), remaining(id)));
  // Every completed or joint-deferred slot still consumes one turn in the round.
  for (let scanned = 0; scanned < n * seq.maxRounds; scanned++, cursor++) {
    const currentRound = Math.floor(cursor / n);
    const inRound = orderForRound(state, currentRound),
      id = inRound[cursor % n];
    if (remaining(id) <= 0) continue;
    const pendingTie = (state.pendingTieGroups ?? []).find((group) => group.includes(id));
    if (pendingTie) return { cursor, round: currentRound + 1, participants: [], requiredByMember: {}, pendingTie };
    const joint = [
      ...(state.jointGroups ?? []),
      ...(state.jointAgreements ?? [])
        .filter((a) => !a.cancelledAt && a.round === currentRound + 1)
        .map((a) => a.members),
    ].find((g) => g.includes(id));
    const members = joint ? inRound.filter((person) => joint.includes(person) && remaining(person) > 0) : [id];
    if (members[members.length - 1] !== id) continue;
    // A joint turn sits on its last member's slot, so that is where early choices count;
    // whoever chose everything they owed there ahead of time drops out of it.
    const participants = members.filter((person) => owed(person, cursor) > 0);
    if (!participants.length) continue;
    const requiredByMember = Object.fromEntries(participants.map((person) => [person, owed(person, cursor)]));
    return { cursor, round: currentRound + 1, participants, requiredByMember };
  }
  throw new Error('No se ha podido avanzar la elección');
}

/** The next effective slot from the state's cursor, or the end when everyone has finished. */
export function nextSlot(seq: SequenceInput): TurnSlot | SequenceEnd {
  return slotFrom(seq, seq.state.cursor, awardCounts(seq.awards), seq.state.credits);
}

/**
 * The effective slots from the cursor up to `me`'s first one (excluded), assuming
 * every slot ahead chooses what it is owed and nobody defers. null when `me` does
 * not choose again. A pending tie cuts the sequence: its slot comes last, because
 * whatever follows depends on the draw.
 */
export function turnsBefore(seq: SequenceInput, me: string): TurnSlot[] | null {
  const counts = awardCounts(seq.awards),
    credits = { ...seq.state.credits };
  if (seq.entitlement(me) - (counts.get(me) ?? 0) <= 0) return null;
  const slots: TurnSlot[] = [];
  for (let cursor = seq.state.cursor; ; ) {
    const slot = slotFrom(seq, cursor, counts, credits);
    if ('complete' in slot) return null;
    if (slot.participants.includes(me)) return slots;
    slots.push(slot);
    if (slot.pendingTie) return slots;
    for (const [person, required] of Object.entries(slot.requiredByMember)) {
      counts.set(person, (counts.get(person) ?? 0) + required);
      credits[person] = 0;
    }
    cursor = slot.cursor + 1;
  }
}

/** Effective turns before `me`'s (see turnsBefore): a joint turn counts once, and so
 * does a pending tie, where the count stops. null when `me` never comes up.
 * Shared with the server's Push alerts. */
export function turnsUntil(seq: SequenceInput, me: string): number | null {
  return turnsBefore(seq, me)?.length ?? null;
}

/** Who chooses in the turns counted by turnsUntil, in order; a pending tie lists its members. */
export function peopleAhead(seq: SequenceInput, me: string): string[] | null {
  return turnsBefore(seq, me)?.flatMap((slot) => slot.pendingTie ?? slot.participants) ?? null;
}
