import {
  choose,
  chooseJoint,
  currentTurn,
  defer,
  consumePreferences,
  preferredChoice,
  choiceIssues,
  entitlementFor,
  resolveTie,
  registerJointAgreement,
  cancelJointAgreement,
  stampTurn,
  type ElectionContext,
  type ElectionState,
  type Preference,
} from '../domain/election.ts';
import { calculate } from '../domain/vacations.ts';
import type { AvailabilitySnapshot, CompactAvailabilitySnapshot } from '../domain/occupancy.ts';
import { campaignOf, occupancyOf, scopeOf } from '../domain/policy.ts';
import { canWrite, type Principal } from './permissions.ts';
import { cas, insertRows, type Repository, type Statement } from './repository.ts';
import { capture, electionStateStatement, restoreStatements } from './campaign-snapshot.ts';
import { ApiError } from './errors.ts';
import { requestsForAwards, syncElectionRequests } from './election-requests.ts';
import { AuditContext, appliedAudit, auditAfter, auditBefore, eventsFor, type AuditRow } from './audit-context.ts';
import {
  historical,
  effectiveReconstruction,
  eventCursor,
  isEffectiveDecision,
  type Snapshot,
  type Historical,
} from './reconstruction-history.ts';
import { discretion, redactDiscreet, withdrawnNotice } from './early-discretion.ts';
import { concealPendingEarly } from '../domain/early-election.ts';
import { ELECTION_UNDO_FORMAT, type AuditAction } from '../domain/events.ts';
export { appliedAudit } from './audit-context.ts';

type Applied = {
  before: Snapshot;
  usedId: string | null;
  kind: string;
  dates?: string[];
  entries?: any[];
  order?: string[];
  agreementIds?: string[];
  actor: string;
  at: string;
  beforeAvailability?: AvailabilitySnapshot | CompactAvailabilitySnapshot;
};
type Session = {
  status: 'active' | 'review' | 'completed';
  startedBy: string;
  startedAt: string;
  targetId: string;
  targetCursor: number;
  keepCount: number;
  origin: Snapshot;
  originalEvents: Historical[];
  originalAuditIds: string[];
  originAuditIds?: string[];
  applied: Applied[];
  undone: Applied[];
  completedAt?: string;
  impact?: any[];
  originAvailability?: AvailabilitySnapshot | CompactAvailabilitySnapshot;
};
type Host = {
  load: (cid: string) => Promise<any>;
  commit: (statements: Statement[]) => Promise<any>;
  audit: (action: AuditAction, c: any, before: any, after: any) => Statement;
};
const ctx = (d: any, awards = d.awards, requests = d.requests): ElectionContext => ({
  year: d.campaign.year,
  team: d.campaign.team_id,
  config: d.config,
  members: d.members,
  awards,
  requests,
});
const snap = (state: ElectionState | null, preferences: Preference[], d: any): Snapshot =>
  capture(d, { state, preferences });
const statement = electionStateStatement;
const restore = (cid: string, s: Snapshot): Statement[] => restoreStatements(cid, s);

/** A restore must not retain an audited award while discarding its decision.
 * Imports without a turn event remain valid; exact award IDs avoid guessing
 * provenance from a repeated member/date on an abandoned branch.
 */
function assertTraceable(snapshot: Snapshot, rows: AuditRow[], retained: AuditRow[]) {
  const awardIds = (events: AuditRow[]) =>
    new Set(
      events.flatMap((row) => (auditAfter(row)?.choices ?? []).flatMap((a: { id?: string }) => (a.id ? [a.id] : []))),
    );
  const recorded = awardIds(rows),
    kept = awardIds(retained);
  const anticipated = new Set(snapshot.state?.earlyChoices?.map((e) => e.awardId) ?? []);
  if (snapshot.awards.some((a) => (recorded.has(a.id) || anticipated.has(a.id)) && !kept.has(a.id)))
    throw new ApiError(
      'La reconstrucción dejaría una elección sin historial. Reconstruye desde un turno anterior o cancela para conservar la situación actual.',
      409,
    );
}
/**
 * The turn left open by a reconstruction starts waiting when it ends, not before it began.
 * Steps move the cursor without the clock, so stamp the turn that is open now.
 */
function restartClock(context: ElectionContext, state: ElectionState | null, at: string) {
  if (state?.status !== 'active') return state;
  let cursor = state.cursor;
  try {
    cursor = currentTurn(context, state).state.cursor;
  } catch {
    /* An unreadable turn keeps its stored cursor; the scheduled stamp corrects it later. */
  }
  return stampTurn(state, cursor, at, true);
}
function sameList(a: Preference, b: Preference) {
  return (
    JSON.stringify([a.dates, a.persistent === true, a.mode ?? 'immediate', a.waitMinutes ?? 0, a.labels ?? {}]) ===
    JSON.stringify([b.dates, b.persistent === true, b.mode ?? 'immediate', b.waitMinutes ?? 0, b.labels ?? {}])
  );
}
// The session keeps only what replaying a decision reads: the cursor state, the
// participants' own lists and the decision itself. Awards, requests, other lists
// and the availability report stay in the audit row (they made sessions ~1.7 MB).
function sessionEvent(e: Historical): Historical {
  const { impact: _impact, ...after } = e.after ?? {};
  return {
    ...e,
    after,
    before: {
      format: e.before.format,
      state: e.before.state,
      awards: [],
      requests: [],
      preferences: e.before.preferences.filter((p) => e.participants.includes(p.member_id)),
    },
  };
}
export class ReconstructionService {
  constructor(
    private repo: Repository,
    private actor: Principal,
    private host: Host,
  ) {}
  async read(cid: string): Promise<Session | null> {
    const rows = await this.repo.all('SELECT json FROM reconstruction_sessions WHERE campaign_id=?', [cid]);
    return rows[0] ? JSON.parse(rows[0].json) : null;
  }
  private write(cid: string, s: Session): Statement {
    return {
      sql: 'INSERT INTO reconstruction_sessions(campaign_id,json) VALUES(?,?) ON CONFLICT(campaign_id) DO UPDATE SET json=excluded.json',
      args: [cid, JSON.stringify(s)],
    };
  }
  private async auditRows(cid: string) {
    return eventsFor(this.repo, cid);
  }
  async candidates(d: any, audit?: AuditContext) {
    const rows = await (audit?.rows() ?? this.auditRows(d.campaign.id)),
      current = audit ? await audit.replay() : appliedAudit(rows);
    const currentIds = new Set(current.done.map((row) => row.id));
    const effectiveRows = new Map(current.done.map((row) => [row.id, row]));
    return rows
      .map((row) => historical(d, effectiveRows.get(row.id) ?? row))
      .filter((entry): entry is Historical => !!entry && !['register_joint', 'cancel_joint'].includes(entry.action))
      .map((entry) => ({
        id: entry.id,
        action: entry.action,
        round: entry.round,
        memberIds: entry.participants,
        choices: entry.after.choices ?? [],
        cursor: eventCursor(entry),
        archived: !currentIds.has(entry.id) || !isEffectiveDecision(entry, d.awards),
      }))
      .reverse();
  }
  private pick(d: any, s: Session, state: ElectionState, awards: any[], requests: any[], skipProof = false) {
    // Replay round-scoped agreements at their original point in the cursor history.
    // The dry-run also drives the preview, so it matches what the next step commits.
    const used = new Set(s.applied.flatMap((step) => step.agreementIds ?? []));
    let working = structuredClone(state);
    const agreementIds: string[] = [];
    for (const event of s.originalEvents) {
      if (
        !['register_joint', 'cancel_joint'].includes(event.action) ||
        used.has(event.id) ||
        !event.before.state ||
        eventCursor(event) > working.cursor
      )
        continue;
      const agreement = event.after?.joint;
      if (!agreement) continue;
      const context = ctx(d, awards, requests);
      working =
        event.action === 'register_joint'
          ? registerJointAgreement(
              context,
              working,
              agreement.members,
              agreement.round,
              event.after.actor ?? s.startedBy,
              event.after.at ?? new Date().toISOString(),
            )
          : cancelJointAgreement(
              context,
              working,
              agreement.members,
              agreement.round,
              event.after.actor ?? s.startedBy,
              event.after.at ?? new Date().toISOString(),
            );
      agreementIds.push(event.id);
    }
    const turn = currentTurn(ctx(d, awards, requests), working);
    const original = s.originalEvents.find(
      (e) =>
        !['register_joint', 'cancel_joint'].includes(e.action) &&
        !s.applied.some((a) => a.usedId === e.id) &&
        e.round === turn.round &&
        (turn.pendingTie
          ? e.action === 'resolve_tie' &&
            e.participants.length === turn.pendingTie.length &&
            turn.pendingTie.every((id: string) => e.participants.includes(id))
          : e.memberId === turn.memberId &&
            e.participants.length === turn.participants.length &&
            turn.participants.every((id: string) => e.participants.includes(id))),
    );
    const historicalPreferences =
      original?.before.preferences.filter((p) => turn.participants.includes(p.member_id)) ?? [];
    const first =
      !skipProof && turn.participants.length === 1 && turn.memberId && historicalPreferences.length
        ? preferredChoice(
            ctx(d, awards, requests),
            { ...turn.state, automaticPaused: false },
            historicalPreferences.map((p) => ({ ...p, active: true, mode: p.mode === 'wait' ? 'immediate' : p.mode })),
          )
        : null;
    const originalChoices = (original?.after?.choices ?? []) as { member_id: string; cycle_date: string }[];
    const originalEntries = turn.participants.map((id: string) => ({
      member_id: id,
      dates: originalChoices.filter((a) => a.member_id === id).map((a) => a.cycle_date),
    }));
    let canOriginal = false;
    if (
      !skipProof &&
      original &&
      (original.action === 'defer' || (original.action === 'reconstruction_step' && original.after.kind === 'defer'))
    ) {
      try {
        if (!turn.memberId) throw Error();
        defer(ctx(d, awards, requests), working, turn.memberId);
        canOriginal = true;
      } catch {
        canOriginal = false;
      }
    } else if (
      !skipProof &&
      original &&
      (original.action === 'resolve_tie' ||
        (original.action === 'reconstruction_step' && original.after.kind === 'resolve_tie'))
    )
      canOriginal = !!turn.pendingTie && Array.isArray(original.after?.resolution?.order ?? original.after?.order);
    else if (!skipProof && original && turn.participants.length > 1) {
      // The preview must use exactly the same atomic joint validation as replay.
      // Per-person checks against the old state can incorrectly approve a batch
      // that consumes a single shared policy quota more than once.
      try {
        chooseJoint(ctx(d, awards, requests), working, originalEntries);
        canOriginal = true;
      } catch {
        canOriginal = false;
      }
    } else if (!skipProof && original && turn.memberId) {
      try {
        choose(ctx(d, awards, requests), working, turn.memberId, originalEntries[0]?.dates ?? []);
        canOriginal = true;
      } catch {
        canOriginal = false;
      }
    }
    const rules = occupancyOf(scopeOf(d.campaign));
    const available =
      turn.participants.length === 1 && turn.memberId
        ? calculate(d.campaign.year, d.campaign.team_id, d.config, d.members, requests, awards, {
            skipProof: skipProof,
          })
            .cycles.filter((c) =>
              skipProof && rules
                ? rules.immediateIssues(rules.state(campaignOf(d.campaign, d.config), d.members, awards), [
                    { member_id: turn.memberId!, cycle_date: c.date },
                  ]).length === 0
                : !choiceIssues(ctx(d, awards, requests), turn.memberId!, [c.date]).length,
            )
            .map((c) => c.date)
        : [];
    return {
      turn,
      original,
      first,
      originalEntries,
      canOriginal,
      available,
      historicalPreferences,
      workingState: working,
      agreementIds,
    };
  }
  private impact(d: any, s: Session, awards: any[], requests: any[]) {
    const base = ctx(d, s.origin.awards, s.origin.requests),
      now = ctx(d, awards, requests);
    const result: any[] = [];
    for (const member of d.members) {
      const oldCount = s.origin.awards.filter((a) => a.member_id === member.id).length;
      const newCount = awards.filter((a) => a.member_id === member.id).length;
      if (newCount >= entitlementFor(now, member.id) && oldCount >= entitlementFor(base, member.id)) continue;
      const pref = s.origin.preferences.find((p) => p.member_id === member.id);
      const previous = pref?.dates.filter((date) => !choiceIssues(base, member.id, [date]).length) ?? [];
      const current = pref?.dates.filter((date) => !choiceIssues(now, member.id, [date]).length) ?? [];
      if (previous.join('|') !== current.join('|') || oldCount !== newCount)
        result.push({
          memberId: member.id,
          previous,
          current,
          previousFirst: previous[0] ?? null,
          currentFirst: current[0] ?? null,
          oldCount,
          newCount,
        });
    }
    return result;
  }
  async view(
    d: any,
    raw: { state: ElectionState | null; preferences: Preference[] },
    skipProof = false,
    audit?: AuditContext,
    viewer: string | null = null,
  ) {
    const stored = await this.read(d.campaign.id);
    if (this.actor.preview || !canWrite(this.actor, d.campaign.team_id))
      return { active: !!stored && stored.status !== 'completed' };
    const candidates = await this.candidates(d, audit);
    if (!stored) return { active: false, candidates };
    const s = await this.discreetOrigin(d, stored, raw.state, viewer, audit);
    const active = s.status !== 'completed',
      state = raw.state;
    const pick = active && state ? this.pick(d, s, state, d.awards, d.requests, skipProof) : null;
    return {
      active,
      status: s.status,
      candidates: s.status === 'completed' ? candidates : [],
      progress: s.applied.length,
      total: s.originalEvents.filter((e) => !['register_joint', 'cancel_joint'].includes(e.action)).length,
      startedAt: s.startedAt,
      startedBy: s.startedBy,
      targetId: s.targetId,
      targetCursor: s.targetCursor,
      canFinish: s.status === 'review',
      canBack: s.applied.length > 0,
      canForward: s.undone.length > 0,
      original: s.origin.awards.map((a) => ({ memberId: a.member_id, date: a.cycle_date })),
      current: pick
        ? {
            round: pick.turn.round,
            memberId: pick.turn.memberId,
            participants: pick.turn.participants,
            needed: pick.turn.needed,
            pendingTie: pick.turn.pendingTie ?? null,
            requiredByMember: pick.turn.requiredByMember,
            historicalPreference: pick.first,
            preferences: pick.historicalPreferences,
            originalChoice: pick.originalEntries,
            originalAction:
              pick.original?.action === 'reconstruction_step'
                ? (pick.original.after?.kind ?? 'choose')
                : (pick.original?.action ?? null),
            originalTie: pick.original?.after?.resolution ?? null,
            originalPossible: pick.canOriginal,
            available: pick.available,
          }
        : null,
      changes: s.applied.map((a) => ({ kind: a.kind, dates: a.dates, entries: a.entries, actor: a.actor, at: a.at })),
      impact: s.status === 'completed' ? (s.impact ?? []) : skipProof ? [] : this.impact(d, s, d.awards, d.requests),
    };
  }
  /**
   * The session as `viewer` may see it: early choices that were discreet when it started
   * (domain/early-election.ts) and whose slot the rebuilt election has not reached yet
   * stay out of its origin, its original events and so of the impact.
   */
  private async discreetOrigin(
    d: Parameters<typeof ctx>[0],
    s: Session,
    current: ElectionState | null,
    viewer: string | null,
    audit?: AuditContext,
  ): Promise<Session> {
    const origin = s.origin.state;
    if (!origin?.earlyChoices?.length) return s;
    let cursor = Infinity;
    if (current)
      try {
        cursor = currentTurn(ctx(d), current).state.cursor;
      } catch {
        cursor = current.cursor;
      }
    const pending = concealPendingEarly(
      ctx(d, s.origin.awards, s.origin.requests),
      origin,
      viewer,
      s.origin.awards,
    ).hidden;
    const unreached = new Set(
      origin.earlyChoices.filter((e) => pending.has(e.awardId) && e.cursor > cursor).map((e) => e.awardId),
    );
    if (!unreached.size) return s;
    // With their audit rows and the original requests they recorded.
    const { ids } = discretion(
      await (audit?.rows() ?? this.auditRows(d.campaign.id)),
      unreached,
      viewer,
      new Set(s.origin.awards.map((a) => a.id)),
      s.origin.requests,
    );
    const hiddenOwners = s.origin.awards.filter((a) => unreached.has(a.id)).map((a) => a.member_id);
    return {
      ...s,
      origin: redactDiscreet(s.origin, ids),
      originalEvents: s.originalEvents.filter(
        (e) => !ids.has(e.id) && !(e.after?.choices ?? []).some((c: { id?: string }) => !!c?.id && ids.has(c.id)),
      ),
      // A stored impact counted them: discount them from the original totals.
      impact: s.impact?.map((entry) => {
        const discount = hiddenOwners.filter((id) => id === entry.memberId).length;
        return discount ? { ...entry, oldCount: entry.oldCount - discount } : entry;
      }),
    };
  }
  async mutate(d: any, raw: { state: ElectionState | null; preferences: Preference[] }, body: any) {
    const c = d.campaign,
      cid = c.id,
      action = body.action;
    if (this.actor.preview) throw new ApiError('La vista previa no permite reconstrucciones administrativas', 403);
    if (!canWrite(this.actor, c.team_id))
      throw new ApiError('Solo un administrador del equipo puede reconstruir elecciones', 403);
    if (c.status !== 'open') throw new ApiError('La campaña está cerrada');
    if (body.version !== c.version)
      throw new ApiError('Otro administrador modificó la campaña. Actualiza la pantalla.', 409);
    const existing = await this.read(cid);
    const before = snap(raw.state, raw.preferences, d),
      ops = cas(cid, c.version);
    if (action === 'reconstruction_start') {
      if (existing && existing.status !== 'completed') throw new ApiError('Ya existe una reconstrucción abierta', 409);
      const audit = await this.auditRows(cid),
        applied = appliedAudit(audit);
      let index = applied.done.findIndex((row) => row.id === body.historyId);
      const pos = audit.findIndex((row) => row.id === body.historyId);
      if (pos < 0) throw new ApiError('La decisión no existe en la auditoría', 409);
      const target = historical(d, applied.done.find((row) => row.id === body.historyId) ?? audit[pos]);
      if (!target?.before.state) throw new ApiError('Selecciona un turno de elección recuperable');
      // Undo can take a reached early award along with its predecessor while its
      // immutable event remains in the chronological replay. A replaced award is
      // an archived reference, even when that old event still belongs to done.
      if (!isEffectiveDecision(target, d.awards)) index = -1;
      const pendingEarly = raw.state
        ? concealPendingEarly(ctx(d), raw.state, null, d.awards).hidden
        : new Set<string>();
      if ((target.after.choices ?? []).some((choice: { id?: string }) => !!choice.id && pendingEarly.has(choice.id)))
        throw new ApiError('La decisión todavía no está disponible para reconstruir', 409);
      // After undo + a new choice, old decisions form an archived branch. The guided
      // recovery must still find them, even though normal redo has been invalidated.
      const breakpoint = audit.findIndex(
        (row, i) =>
          i > pos &&
          [
            'election_undo',
            'election_redo',
            'reconstruction_start',
            'reconstruction_cancel',
            'reconstruction_back',
          ].includes(row.action),
      );
      const records =
        index >= 0 ? applied.done.slice(index) : audit.slice(pos, breakpoint < 0 ? undefined : breakpoint);
      const effective = effectiveReconstruction(
        d,
        before,
        applied.done,
        target,
        index >= 0 ? applied.done : records,
        audit,
      );
      const originalEvents = (
        effective?.events ?? records.map((row) => historical(d, row)).filter((e): e is Historical => !!e)
      )
        .filter(
          (event) =>
            !(event.after.choices ?? []).some((choice: { id?: string }) => !!choice.id && pendingEarly.has(choice.id)),
        )
        .map(sessionEvent);
      let keepCount = index;
      if (keepCount < 0)
        keepCount = applied.done.findIndex((row) => {
          if (!row.before_json) return false;
          const before = auditBefore(row);
          return before.format === 'election-undo-v1' && (before.state?.cursor ?? -1) >= target.before.state!.cursor;
        });
      if (keepCount < 0) keepCount = applied.done.length;
      if (effective) keepCount = effective.retainedIds.length;
      const retained = effective ? new Set(effective.retainedIds) : null;
      const originalAuditIds = retained
        ? applied.done.filter((row) => !retained.has(row.id)).map((row) => row.id)
        : applied.done.slice(keepCount).map((row) => row.id);
      if (!originalEvents.length || originalEvents.length > 1500)
        throw new ApiError('Número de decisiones no admitido para la reconstrucción');
      const previous = effective?.previous ?? target.before,
        origin = before;
      // Keep lists edited after the rewind point, but restore the active bit when the same
      // one-turn list was consumed by one of the decisions being reconstructed.
      const working: Preference[] = origin.preferences.map((p) => {
        const old = previous.preferences.find((q) => q.member_id === p.member_id);
        return old && sameList(p, old) ? { ...p, active: old.active } : p;
      });
      for (const p of previous.preferences) if (!working.some((q) => q.member_id === p.member_id)) working.push(p);
      const restoreTo: Snapshot = {
        ...previous,
        requests: requestsForAwards(cid, previous.awards, previous.requests),
        preferences: working,
        state: { ...previous.state!, automaticPaused: true },
      };
      const retainedHistory = effective
        ? effective.retainedIds.map(
            (id) => applied.done.find((row) => row.id === id) ?? audit.find((row) => row.id === id)!,
          )
        : applied.done.slice(0, keepCount);
      assertTraceable(restoreTo, audit, retainedHistory);
      const lastCursor = Math.max(
        ...originalEvents.map(
          (event) =>
            eventCursor(event) +
            (['choose', 'choose_joint', 'advance', 'early_choose', 'defer', 'reconstruction_step'].includes(
              event.action,
            )
              ? 1
              : 0),
        ),
      );
      const rules = occupancyOf(scopeOf(c));
      const originAvailability = rules
        ? rules.compact(rules.availability(rules.state(campaignOf(c, d.config), d.members, d.awards)))
        : undefined;
      const s: Session = {
        originAvailability,
        status: 'active',
        startedBy: this.actor.id!,
        startedAt: new Date().toISOString(),
        targetId: target.id,
        targetCursor: Math.max(origin.state?.cursor ?? 0, lastCursor),
        keepCount,
        origin,
        originalEvents,
        originalAuditIds,
        ...(effective ? { originAuditIds: effective.restoreIds } : {}),
        applied: [],
        undone: [],
      };
      const completed = restoreTo.state!.status === 'complete' || restoreTo.state!.cursor >= s.targetCursor;
      if (completed) s.status = 'review';
      // Discreet early choices the rewind takes away stay unseen (server/early-discretion.ts),
      // and their owners are told; cancelling brings them back, and the notice goes stale.
      const kept = new Set(restoreTo.awards.map((a) => a.id));
      const pending = raw.state ? concealPendingEarly(ctx(d), raw.state, null, d.awards).hidden : new Set<string>();
      const withdrawnEarly = (raw.state?.earlyChoices ?? []).filter(
        (e) => pending.has(e.awardId) && !kept.has(e.awardId),
      );
      for (const early of withdrawnEarly) ops.push(withdrawnNotice(cid, early, new Date().toISOString()));
      ops.push(
        ...restore(cid, restoreTo),
        this.write(cid, s),
        this.host.audit('reconstruction_start', c, null, {
          targetId: target.id,
          keepCount,
          originalIds: originalAuditIds,
          ...(effective ? { retainedIds: effective.retainedIds, removedAwardIds: effective.removedAwardIds } : {}),
          ...(withdrawnEarly.length ? { withdrawnEarly: withdrawnEarly.map((e) => e.awardId) } : {}),
          version: c.version + 1,
        }),
      );
      await this.host.commit(ops);
      return;
    }
    if (!existing || existing.status === 'completed') throw new ApiError('No hay una reconstrucción abierta', 409);
    const s = structuredClone(existing) as Session;
    if (action === 'reconstruction_cancel') {
      const now = new Date().toISOString();
      ops.push(
        ...restore(cid, {
          ...s.origin,
          state: restartClock(ctx(d, s.origin.awards, s.origin.requests), s.origin.state, now),
        }),
        { sql: 'DELETE FROM reconstruction_sessions WHERE campaign_id=?', args: [cid] },
        this.host.audit('reconstruction_cancel', c, null, {
          targetId: s.targetId,
          keepCount: s.keepCount,
          originalIds: s.originalAuditIds,
          ...(s.originAuditIds ? { restoreIds: s.originAuditIds } : {}),
          recordedAvailability: s.originAvailability,
          version: c.version + 1,
        }),
      );
      await this.host.commit(ops);
      return;
    }
    if (action === 'reconstruction_back') {
      const previous = s.applied.pop();
      if (!previous) throw new ApiError('No hay decisiones reconstruidas que deshacer');
      s.undone.push(previous);
      s.status = 'active';
      ops.push(
        ...restore(cid, {
          ...previous.before,
          state: previous.before.state ? { ...previous.before.state, automaticPaused: true } : null,
        }),
        this.write(cid, s),
        this.host.audit('reconstruction_back', c, null, {
          version: c.version + 1,
          recordedAvailability: previous.beforeAvailability,
        }),
      );
      await this.host.commit(ops);
      return;
    }
    if (action === 'reconstruction_finish') {
      if (s.status !== 'review') throw new ApiError('Quedan turnos anteriores por reconstruir');
      const rows = await this.auditRows(cid);
      assertTraceable(before, rows, appliedAudit(rows).done);
      s.status = 'completed';
      const completedAt = new Date().toISOString();
      s.completedAt = completedAt;
      s.impact = this.impact(d, s, d.awards, d.requests);
      ops.push(
        statement(cid, restartClock(ctx(d), raw.state, completedAt)),
        ...syncElectionRequests(
          cid,
          d.awards,
          d.requests,
          d.members.map((m: any) => m.id),
        ),
        this.write(cid, s),
        this.host.audit('reconstruction_finish', c, null, {
          version: c.version + 1,
          changes: s.applied.length,
          affected: s.impact.length,
        }),
      );
      await this.host.commit(ops);
      return;
    }
    if (action !== 'reconstruction_step' && action !== 'reconstruction_forward')
      throw new ApiError('Operación de reconstrucción no válida');
    if (s.status === 'review') throw new ApiError('La secuencia está reconstruida. Finaliza o deshaz el último paso.');
    if (!raw.state) throw new ApiError('No existe estado de elección');
    const pick = this.pick(d, s, raw.state, d.awards, d.requests);
    const { turn, original, first, originalEntries, agreementIds } = pick;
    const redo = action === 'reconstruction_forward' ? s.undone.at(-1) : null;
    if (action === 'reconstruction_forward' && !redo) throw new ApiError('No hay decisiones para rehacer');
    const kind = redo?.kind ?? body.kind;
    const mode = redo ? 'manual' : body.mode;
    let dates: string[] = redo?.dates ?? body.dates,
      entries: any[] = redo?.entries ?? body.entries,
      order: string[] = redo?.order ?? body.order;
    if (mode === 'preference') {
      if (!first) throw new ApiError('No hay preferencias históricas aplicables a este turno');
      dates = first;
    } else if (mode === 'original') {
      if (!pick.canOriginal || !original) throw new ApiError('La elección original ya no es válida');
      if (original.action === 'defer') dates = [];
      else if (
        original.action === 'resolve_tie' ||
        (original.action === 'reconstruction_step' && original.after?.kind === 'resolve_tie')
      )
        order = original.after?.resolution?.order ?? original.after?.order;
      else if (turn.participants.length > 1) entries = originalEntries;
      else dates = originalEntries[0]?.dates;
    }
    let state: ElectionState = pick.workingState,
      choices: { member_id: string; cycle_date: string }[] = [];
    try {
      const context = ctx(d);
      if (kind === 'defer') {
        if (!turn.memberId || turn.participants.length !== 1) throw new Error('No corresponde aplazar ahora');
        state = defer(context, state, turn.memberId);
      } else if (kind === 'resolve_tie') {
        if (!turn.pendingTie) throw new Error('No hay un empate pendiente');
        state = resolveTie(context, state, order, 'external', this.actor.id!, new Date().toISOString());
      } else if (kind === 'choose_joint') {
        const next = chooseJoint(context, state, entries);
        state = next.state;
        choices = next.choices;
      } else if (kind === 'choose') {
        if (!turn.memberId || turn.participants.length !== 1) throw new Error('No corresponde elegir individualmente');
        const next = choose(context, state, turn.memberId, dates);
        state = next.state;
        choices = next.choices;
      } else throw new Error('Indica una elección, un turno conjunto, un sorteo o un aplazamiento');
    } catch (e: any) {
      throw new ApiError(e.message ?? 'Decisión de reconstrucción no válida');
    }
    state = { ...state, automaticPaused: true };
    const preferences = consumePreferences(
      raw.preferences,
      choices.map((a) => a.member_id),
    );
    const awardRows = choices.map((a) => [crypto.randomUUID(), cid, a.member_id, a.cycle_date, 1]);
    const usedId = original?.id ?? null;
    s.applied.push({
      before,
      usedId,
      kind,
      agreementIds,
      dates: kind === 'choose' ? dates : undefined,
      entries: kind === 'choose_joint' ? entries : undefined,
      order: kind === 'resolve_tie' ? order : undefined,
      actor: this.actor.id!,
      at: new Date().toISOString(),
    });
    if (redo) s.undone.pop();
    else s.undone = [];
    if (state.status === 'complete' || state.cursor >= s.targetCursor) s.status = 'review';
    // A chosen historic preference is never applied automatically: the administrator
    // selected it explicitly. The exact choice and associated request are one transaction.
    ops.push(
      statement(cid, state),
      ...insertRows('awards', ['id', 'campaign_id', 'member_id', 'cycle_date', 'version'], awardRows),
      ...syncElectionRequests(
        cid,
        [...d.awards, ...choices],
        d.requests,
        choices.map((a) => a.member_id),
      ),
    );
    for (const p of preferences) {
      const previous = raw.preferences.find((q) => q.member_id === p.member_id);
      if (previous && previous.active !== p.active)
        ops.push({
          sql: 'UPDATE preferences SET active=? WHERE member_id=? AND campaign_id=?',
          args: [p.active !== false ? 1 : 0, p.member_id, cid],
        });
    }
    const rules = occupancyOf(scopeOf(c));
    const impact =
      rules && choices.length
        ? rules.impact(
            rules.state(campaignOf(c, d.config), d.members, d.awards),
            rules.state(campaignOf(c, d.config), d.members, [...d.awards, ...choices]),
          )
        : null;
    if (impact && rules && s.applied.length)
      s.applied[s.applied.length - 1].beforeAvailability = rules.compact(impact.before);
    const auditImpact =
      impact && rules
        ? {
            policyVersion: impact.policyVersion,
            status: impact.status,
            campaignVersionBefore: c.version,
            campaignVersionAfter: c.version + 1,
            changes: impact.changes,
            events: impact.events,
            availabilityBefore: rules.compact(impact.before),
            availabilityAfter: rules.compact(impact.after),
          }
        : null;
    ops.push(
      this.write(cid, s),
      this.host.audit(
        'reconstruction_step',
        c,
        { format: ELECTION_UNDO_FORMAT, ...before },
        {
          version: c.version + 1,
          choices,
          kind,
          usedId,
          impact: auditImpact,
          ...(kind === 'resolve_tie' ? { order } : {}),
        },
      ),
    );
    await this.host.commit(ops);
  }
}
