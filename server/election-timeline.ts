import { currentTurn, orderForRound, type ElectionContext, type ElectionState } from '../domain/election.ts';
import { appliedAudit, auditBefore, auditAfter, type AuditRow } from './audit-context.ts';
import type { ElectionTimelineItem } from '../domain/election-timeline-types.ts';
import { electionTiming, type ElectionTiming } from '../domain/turn-timing.ts';
export type { ElectionTimelineItem } from '../domain/election-timeline-types.ts';

function parsed(row: AuditRow, side: 'before' | 'after'): any {
  try {
    return side === 'before' ? auditBefore(row) : auditAfter(row);
  } catch {
    return null;
  }
}

function roundAt(row: AuditRow, ctx: ElectionContext): number | null {
  const before = parsed(row, 'before'),
    state = before?.state as ElectionState | null;
  if (!state?.order?.length) return null;
  try {
    return currentTurn(
      { ...ctx, awards: before.awards ?? ctx.awards, requests: before.requests ?? ctx.requests },
      state,
    ).round;
  } catch {
    return Math.floor(state.cursor / state.order.length) + 1;
  }
}

/**
 * Replay the same undo/redo stack as ElectionService.history(), then render
 * turn-level actions instead of inferring turns from individual awards.
 * Each action retains its original ordering even when it selected 2–3 cycles.
 */
export function buildElectionTimeline(
  rows: AuditRow[],
  ctx: ElectionContext,
  state: ElectionState | null,
  history = appliedAudit(rows),
): ElectionTimelineItem[] {
  // Reuse the canonical audit replay so guided reconstruction, undo, redo,
  // cancelled reconstructions and new branches share exactly one definition
  // of which historical choices remain effective.
  const done = history.done as AuditRow[];
  const draws = rows.filter((row) => row.action === 'resolve_tie');
  const lastStart = done.findLastIndex((row) => row.action === 'start');
  // Simulations inherit a paused order without a local `start` audit entry.
  const active = lastStart >= 0 ? done.slice(lastStart + 1) : done;
  const awardKeys = new Set(ctx.awards.map((a) => a.member_id + '|' + a.cycle_date));
  const accounted = new Set<string>();
  const indices = new Map(rows.map((row, i) => [row.id, i]));
  const events: { sequence: number; item: ElectionTimelineItem }[] = [];
  // Warnings are stored as the full set after each decision; show only those
  // that a decision introduced, not every later repetition of the same one.
  let previousWarnings = new Set<string>();
  if (state) {
    for (const row of active) {
      if (
        ![
          'choose',
          'choose_joint',
          'advance',
          'early_choose',
          'defer',
          'reconstruction_step',
          'register_joint',
          'cancel_joint',
        ].includes(row.action)
      )
        continue;
      const before = parsed(row, 'before'),
        after = parsed(row, 'after');
      const previous = before?.state as ElectionState | undefined;
      if (!previous) continue;
      if (row.action === 'register_joint' || row.action === 'cancel_joint') {
        const agreement = after?.joint;
        if (agreement && Number.isInteger(agreement.round) && Array.isArray(agreement.members))
          events.push({
            sequence: indices.get(row.id) ?? 0,
            item: {
              id: row.id,
              kind: 'joint',
              round: agreement.round,
              createdAt: row.created_at,
              memberIds: agreement.members,
              choices: [],
              deferredTurns: 0,
              ties: [],
              jointAction: row.action,
            },
          });
        continue;
      }
      const reconstructed = row.action === 'reconstruction_step';
      const kind = reconstructed ? after?.kind : row.action;
      const earlyEntry =
        row.action === 'early_choose' || after?.early === true
          ? state.earlyChoices?.find((e) => after?.choices?.some((c: { id?: string }) => c.id === e.awardId))
          : undefined;
      const selectionCursor = after?.selectionCursor ?? earlyEntry?.cursor ?? previous.cursor;
      const round = after?.round ?? earlyEntry?.round ?? roundAt(row, ctx);
      const choices: ElectionTimelineItem['choices'] = (Array.isArray(after?.choices) ? after.choices : []).filter(
        (choice: any) =>
          typeof choice?.member_id === 'string' &&
          typeof choice?.cycle_date === 'string' &&
          awardKeys.has(choice.member_id + '|' + choice.cycle_date) &&
          (!choice.id || ctx.awards.some((a) => a.id === choice.id)),
      );
      for (const choice of choices) accounted.add(choice.member_id + '|' + choice.cycle_date);
      let turn: ReturnType<typeof currentTurn> | null = null;
      if (reconstructed)
        try {
          turn = currentTurn(
            { ...ctx, awards: before.awards ?? ctx.awards, requests: before.requests ?? ctx.requests },
            previous,
          );
        } catch {
          turn = null;
        }
      const memberIds: string[] =
        kind === 'defer'
          ? [reconstructed ? turn?.memberId : after?.memberId].filter((id): id is string => typeof id === 'string')
          : [...new Set(choices.map((choice) => choice.member_id))];
      if (kind === 'resolve_tie') {
        const order = after?.order;
        if (!Array.isArray(order) || order.length < 2) continue;
        events.push({
          sequence: indices.get(row.id) ?? 0,
          item: {
            id: row.id,
            kind: 'tie',
            round,
            createdAt: row.created_at,
            memberIds: order,
            choices: [],
            deferredTurns: 0,
            ties: [],
            method: 'external',
            order,
          },
        });
        continue;
      }
      if (kind === 'defer' && !memberIds.length) continue;
      if (kind !== 'defer' && !choices.length) continue;
      const ties: ElectionTimelineItem['ties'] = [];
      if (round !== null)
        for (const memberId of memberIds) {
          const group = previous.tieGroups?.find((group) => group.includes(memberId));
          if (!group) continue;
          const order = orderForRound(previous, round - 1).filter((id) => group.includes(id));
          ties.push({ memberId, position: order.indexOf(memberId) + 1, total: group.length, order });
        }
      let introduced: { code: string; message: string; period?: number }[] = [];
      if (Array.isArray(after?.warnings)) {
        introduced = after.warnings.filter((w: any) => !previousWarnings.has(w.code));
        previousWarnings = new Set(after.warnings.map((w: any) => w.code));
      }
      events.push({
        sequence: indices.get(row.id) ?? 0,
        item: {
          id: row.id,
          kind: kind === 'defer' ? 'defer' : 'choice',
          selectionCursor,
          round,
          createdAt: row.created_at,
          memberIds,
          choices,
          deferredTurns: memberIds.length === 1 ? (previous.credits?.[memberIds[0]] ?? 0) : 0,
          ties,
          ...(row.action === 'early_choose' || after?.early === true ? { anticipated: true } : {}),
          ...(after?.impact
            ? {
                impact: {
                  policyVersion: after.impact.policyVersion,
                  status: after.impact.status,
                  campaignVersionBefore: after.impact.campaignVersionBefore,
                  campaignVersionAfter: after.impact.campaignVersionAfter,
                  changes: after.impact.changes,
                  events: after.impact.events,
                },
              }
            : {}),
          ...(introduced.length ? { warnings: introduced } : {}),
        },
      });
    }
    for (const row of draws) {
      const resolution = parsed(row, 'after')?.resolution;
      if (
        !resolution ||
        !Array.isArray(resolution.order) ||
        !state.tieResolutions?.some(
          (r) =>
            r.at === resolution.at &&
            r.method === resolution.method &&
            r.order.join('|') === resolution.order.join('|'),
        )
      )
        continue;
      events.push({
        sequence: indices.get(row.id) ?? 0,
        item: {
          id: row.id,
          kind: 'tie',
          round: roundAt(row, ctx),
          createdAt: row.created_at,
          memberIds: resolution.order,
          choices: [],
          deferredTurns: 0,
          ties: [],
          method: resolution.method,
          order: resolution.order,
          anticipated: resolution.anticipated === true,
        },
      });
    }
  }
  // Imported awards sit below every unindexed one (range [-N, -1]), so a manual
  // award added after an import never shares a sequence with an imported one.
  const maxIndex = Math.max(0, ...ctx.awards.map((a) => a.selection_index ?? 0));
  for (const [i, award] of ctx.awards.entries()) {
    const key = award.member_id + '|' + award.cycle_date;
    if (accounted.has(key)) continue;
    events.push({
      sequence: award.selection_index != null ? award.selection_index - maxIndex - ctx.awards.length - 1 : -i - 1,
      item: {
        id: 'legacy-' + award.id,
        kind: 'legacy',
        round: award.selection_round ?? null,
        createdAt: '',
        memberIds: [award.member_id],
        choices: [{ member_id: award.member_id, cycle_date: award.cycle_date }],
        deferredTurns: 0,
        ties: [],
      },
    });
  }
  // An early choice belongs to its own slot, not to the moment it was made: show it
  // right after the last decision taken on an earlier slot, once that one exists.
  // Placed in slot order, so consecutive early choices follow each other: each lands
  // halfway between the latest earlier slot and the next decision.
  const early = events
    .filter((e) => e.item.anticipated && e.item.kind === 'choice' && e.item.selectionCursor !== undefined)
    .sort((a, b) => a.item.selectionCursor! - b.item.selectionCursor!);
  for (const entry of early) {
    const cursor = entry.item.selectionCursor!;
    const earlier = events.filter(
      (other) =>
        other !== entry &&
        other.item.kind !== 'tie' &&
        other.item.selectionCursor !== undefined &&
        other.item.selectionCursor < cursor,
    );
    const last = Math.max(entry.sequence, ...earlier.map((other) => other.sequence));
    if (last > entry.sequence) entry.sequence = last + (Math.floor(last) + 1 - last) / 2;
  }
  return events.sort((a, b) => b.sequence - a.sequence).map((entry) => entry.item);
}

/**
 * The public history is an explicit allowlist, never a serialized audit event.
 * In particular, undo/reconstruction snapshots, availability impacts, internal
 * warnings, actors and preference data must not leave the server.
 */
export type PublicElectionTimelineItem = Pick<
  ElectionTimelineItem,
  | 'id'
  | 'kind'
  | 'round'
  | 'memberIds'
  | 'choices'
  | 'deferredTurns'
  | 'method'
  | 'order'
  | 'anticipated'
  | 'selectionCursor'
> & { automatic?: true };

export function publicElectionTimeline(
  items: ElectionTimelineItem[],
  rows: Pick<AuditRow, 'id' | 'action'>[],
): PublicElectionTimelineItem[] {
  const automaticallyChosen = new Set(rows.filter((row) => row.action === 'advance').map((row) => row.id));
  return items.map((item) => ({
    id: item.id,
    kind: item.kind,
    round: item.round,
    memberIds: [...item.memberIds],
    choices: item.choices.map(({ member_id, cycle_date }) => ({ member_id, cycle_date })),
    deferredTurns: item.deferredTurns,
    ...(item.selectionCursor !== undefined ? { selectionCursor: item.selectionCursor } : {}),
    ...(item.kind === 'tie' && item.method ? { method: item.method } : {}),
    ...(item.kind === 'tie' && item.order ? { order: [...item.order] } : {}),
    ...(item.kind === 'choice' && automaticallyChosen.has(item.id) ? { automatic: true as const } : {}),
    ...(item.kind === 'choice' && item.anticipated ? { anticipated: true } : {}),
  }));
}

const CLOCK_RESTARTS = new Set([
  'start',
  'resume',
  'resume_automatic',
  'election_undo',
  'election_redo',
  'reconstruction_finish',
  'reconstruction_cancel',
]);
/** A draw restarts the clock unless it was settled ahead of time, while someone else was choosing. */
function restartsClock(row: Pick<AuditRow, 'action' | 'after_json'>) {
  if (CLOCK_RESTARTS.has(row.action)) return true;
  if (row.action !== 'resolve_tie') return false;
  try {
    return auditAfter(row)?.resolution?.anticipated !== true;
  } catch {
    return true;
  }
}
/** Turn durations of a campaign, from its audit and its built timeline (see electionTiming). */
export function timingOf(
  rows: Pick<AuditRow, 'id' | 'action' | 'after_json' | 'created_at'>[],
  items: ElectionTimelineItem[],
  state: ElectionState | null,
  now = Date.now(),
  frozen = false,
  /** Firm awards this viewer may see: an early choice whose slot has not come stays out. */
  visibleAwards?: readonly { member_id: string; cycle_date: string }[],
): ElectionTiming {
  const visible = visibleAwards && new Set(visibleAwards.map((a) => a.member_id + '|' + a.cycle_date));
  return electionTiming({
    items: items.filter(
      (item) =>
        !item.anticipated || !visible || item.choices.every((c) => visible.has(c.member_id + '|' + c.cycle_date)),
    ),
    clockRestarts: rows.filter(restartsClock).map((row) => row.created_at),
    untimed: new Set(rows.filter((row) => row.action === 'reconstruction_step').map((row) => row.id)),
    turnSince: state?.turnSince ?? null,
    active: state?.status === 'active' && !frozen,
    now,
  });
}
