/**
 * A conservative, campaign-independent LOCAL capacity bound for early election.
 *
 * The caller must provide a capacity that is proved to remain available in every
 * policy-compliant continuation (not the maximum displayed on the calendar).
 * Each distinct earlier controller can take at most one place in the same cycle,
 * even after accumulating several turns. Members of joint turns count separately.
 *
 * Passing this test is NOT sufficient to award a cycle: the election service
 * must also prove the campaign-specific/global rules, precedence, entitlements,
 * applicable round and concurrency safety before confirming an early choice.
 * If the caller cannot prove a minimum capacity, it must pass null and refuse.
 */
export type EarlyCycleLocalBound = {
  candidateMemberId: string;
  minimumCapacity: number | null;
  occupiedMemberIds: readonly string[];
  potentialEarlierMemberIds: readonly string[];
};

/**
 * Is there a seat left even if EVERY distinct earlier eligible controller
 * requests this very cycle? Invalid or uncertain inputs fail closed.
 *
 * No state is mutated and no election is awarded by this function.
 */
export function hasUncontestedLocalSeat(input: EarlyCycleLocalBound): boolean {
  const { candidateMemberId, minimumCapacity, occupiedMemberIds, potentialEarlierMemberIds } = input;
  if (
    !candidateMemberId ||
    !Number.isSafeInteger(minimumCapacity) ||
    minimumCapacity === null ||
    minimumCapacity < 1 ||
    !Array.isArray(occupiedMemberIds) ||
    !Array.isArray(potentialEarlierMemberIds) ||
    [...occupiedMemberIds, ...potentialEarlierMemberIds].some(id => typeof id !== 'string' || !id.trim())
  ) return false;

  const occupied = new Set(occupiedMemberIds);
  // A corrupt snapshot or a repeat selection is never an early-election proof.
  if (occupied.size !== occupiedMemberIds.length || occupied.has(candidateMemberId)) return false;
  if (potentialEarlierMemberIds.includes(candidateMemberId)) return false;

  // Earlier controllers already in this cycle cannot occupy another place in it.
  // Duplicate references to a controller's deferred turns count only once.
  const potentialClaims = new Set(potentialEarlierMemberIds.filter(id => !occupied.has(id)));
  return occupied.size + potentialClaims.size < minimumCapacity;
}
