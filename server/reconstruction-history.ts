import {
  currentTurn,
  upgradeElectionState,
  type ElectionContext,
  type ElectionState,
  type Preference,
} from '../domain/election.ts';
import { auditBefore, auditAfter, type AuditRow } from './audit-context.ts';
import { concealPendingEarly } from '../domain/early-election.ts';
import type { Award } from '../domain/vacations.ts';
import type { ElectionDecision } from '../domain/events.ts';
import type { CapturedSnapshot } from './campaign-snapshot.ts';

type HistoryData = {
  campaign: { year: number; team_id: string };
  config: ElectionContext['config'];
  members: ElectionContext['members'];
};
type Choice = Pick<Award, 'member_id' | 'cycle_date'> & { id?: string };

export type Snapshot = {
  format?: string;
  state: ElectionState | null;
  preferences: Preference[];
  awards: CapturedSnapshot['awards'];
  requests: CapturedSnapshot['requests'];
};
export type Historical = {
  id: string;
  action: string;
  before: Snapshot;
  after: ElectionDecision & { resolution?: { order?: string[] } };
  round: number;
  participants: string[];
  memberId: string | null;
  /** Effective slot; absent only in reconstruction sessions saved by older versions. */
  cursor?: number;
};
const decisions = new Set([
  'choose',
  'choose_joint',
  'defer',
  'advance',
  'early_choose',
  'resolve_tie',
  'reconstruction_step',
  'register_joint',
  'cancel_joint',
]);
const early = (e: Historical) => e.action === 'early_choose' || e.after?.early === true;
const choiceKey = (a: { member_id: string; cycle_date: string }) => a.member_id + '|' + a.cycle_date;
export const eventCursor = (e: Historical) => e.cursor ?? e.before.state?.cursor ?? 0;
const context = (d: HistoryData, awards: Award[], requests: ElectionContext['requests']): ElectionContext => ({
  year: d.campaign.year,
  team: d.campaign.team_id,
  config: d.config,
  members: d.members,
  awards,
  requests,
});

export function historical(d: HistoryData, row: AuditRow): Historical | null {
  if (!decisions.has(row.action) || !row.before_json) return null;
  const raw = auditBefore(row) as Snapshot;
  const before = { ...raw, state: upgradeElectionState(raw.state) };
  if (before.format !== 'election-undo-v1' || !before.state) return null;
  const after = auditAfter(row) ?? {};
  if (row.action === 'early_choose' || after.early === true) {
    const memberId = after.memberId ?? after.choices?.[0]?.member_id;
    if (
      typeof memberId !== 'string' ||
      !before.state.order.includes(memberId) ||
      !Number.isSafeInteger(after.selectionCursor) ||
      after.selectionCursor < 0
    )
      return null;
    return {
      id: row.id,
      action: row.action,
      before,
      after,
      cursor: after.selectionCursor,
      round: Math.floor(after.selectionCursor / before.state.order.length) + 1,
      participants: [memberId],
      memberId,
    };
  }
  try {
    const turn = currentTurn(context(d, before.awards, before.requests), before.state);
    return {
      id: row.id,
      action: row.action,
      before,
      after,
      cursor: turn.state.cursor,
      round: after?.joint?.round ?? turn.round,
      participants: after?.joint?.members ?? turn.pendingTie ?? turn.participants,
      memberId: ['register_joint', 'cancel_joint'].includes(row.action) ? null : turn.memberId,
    };
  } catch {
    return null;
  }
}

/**
 * Once an anticipated choice is public, rebuild its effective slot just as if it
 * had been chosen there. Audit remains chronological and immutable; an explicit
 * retained prefix preserves predecessors recorded AFTER that anticipated choice.
 */
export function effectiveReconstruction(d: HistoryData, origin: Snapshot, done: AuditRow[], target: Historical) {
  const start = eventCursor(target);
  const entries = done.map((row) => historical(d, row)).filter((e): e is Historical => !!e);
  const hidden = origin.state
    ? concealPendingEarly(context(d, origin.awards, origin.requests), origin.state, null, origin.awards).hidden
    : new Set<string>();
  const liveKeys = new Set(origin.awards.map(choiceKey));
  const liveIds = new Set(origin.awards.map((a) => a.id));
  const active = (e: Historical) =>
    !early(e) || (e.after.choices ?? []).some((a: Choice) => (a.id ? liveIds.has(a.id) : liveKeys.has(choiceKey(a))));
  const pending = (e: Historical) =>
    early(e) && (e.after.choices ?? []).some((a: Choice) => !!a.id && hidden.has(a.id));
  if (!entries.some((e) => early(e) && active(e) && !pending(e) && eventCursor(e) >= start)) return null;
  const suffix = entries.filter((e) => eventCursor(e) >= start);
  const removed = new Set(suffix.filter(active).flatMap((e) => (e.after.choices ?? []).map(choiceKey)));
  // A skipped slot has no physical before-snapshot. The next recorded cursor
  // contains its confirmed predecessors; remove the logical suffix from it.
  const anchor = early(target)
    ? (done.map((row) => auditBefore(row) as Snapshot | null).find((s) => s?.state && s.state.cursor > start) ?? origin)
    : target.before;
  // A retained predecessor may still carry an obsolete anticipated suffix in
  // its immutable snapshot, even after that suffix was rebuilt once already.
  const anticipatedSuffix = new Set(
    (anchor.state?.earlyChoices ?? []).filter((e) => e.cursor >= start).map((e) => e.awardId),
  );
  const awards = anchor.awards.filter((a) => !removed.has(choiceKey(a)) && !anticipatedSuffix.has(a.id));
  const keptAwardIds = new Set(awards.map((a) => a.id));
  const anchorState = upgradeElectionState(anchor.state)!;
  const credits = {
    ...currentTurn(context(d, anchor.awards, anchor.requests), { ...anchorState, status: 'active' }).state.credits,
  };
  const restoredCredits = new Set<string>();
  for (const event of suffix) {
    if (
      !early(event) ||
      !event.memberId ||
      restoredCredits.has(event.memberId) ||
      (event.before.state?.cursor ?? Infinity) > start
    )
      continue;
    credits[event.memberId] = event.before.state?.credits[event.memberId] ?? 0;
    restoredCredits.add(event.memberId);
  }
  for (const member of target.participants) credits[member] = target.before.state?.credits[member] ?? 0;
  const previous: Snapshot = {
    ...anchor,
    preferences: target.before.preferences,
    awards,
    state: {
      ...anchorState,
      status: 'active',
      cursor: start,
      credits,
      earlyChoices: (anchorState.earlyChoices ?? []).filter((e) => keptAwardIds.has(e.awardId) && e.cursor < start),
    },
  };
  const byId = new Map(entries.map((e) => [e.id, e]));
  const retainedIds = done
    .filter((row) => {
      const entry = byId.get(row.id);
      if (entry) return eventCursor(entry) < start;
      const before = auditBefore(row) as Snapshot | null;
      return !before?.state || before.state.cursor < start;
    })
    .map((row) => row.id);
  const events: Historical[] = [];
  // Partial anticipated choices and the later remainder are one ordinary turn.
  // This restores deferred credits and offers the whole original batch at once.
  for (const e of suffix.filter((e) => active(e) && !pending(e)).sort((a, b) => eventCursor(a) - eventCursor(b))) {
    const isChoice = (e.after.choices ?? []).length > 0;
    const group =
      isChoice &&
      events.find(
        (q) => eventCursor(q) === eventCursor(e) && q.memberId === e.memberId && (q.after.choices ?? []).length > 0,
      );
    if (group) {
      group.after = { ...group.after, choices: [...group.after.choices, ...e.after.choices] };
    } else {
      events.push(early(e) ? { ...e, action: 'choose', after: { ...e.after, early: false } } : { ...e });
    }
  }
  return {
    previous,
    events,
    retainedIds,
    restoreIds: done.map((row) => row.id),
    removedAwardIds: origin.awards.filter((award) => !keptAwardIds.has(award.id)).map((award) => award.id),
  };
}
