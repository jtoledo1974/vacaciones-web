import {
  currentTurn,
  choiceIssues,
  preferredChoice,
  upgradeElectionState,
  sequenceFor,
  entitlementFor,
  preferenceFromRow,
  stampTurn,
  automaticAt,
  automaticChain,
  listChoice,
  activeList,
  roundQueue,
  type ElectionState,
  type Preference,
  type ElectionContext,
} from '../domain/election.ts';
import { calculate } from '../domain/vacations.ts';
import type { AvailabilitySnapshot, CompactAvailabilitySnapshot } from '../domain/occupancy.ts';
import { type OccupancyRules, type PolicyAward, occupancyOf, policyOf, scopeOf } from '../domain/policy.ts';
import { canWrite, requireSuper, type Principal } from './permissions.ts';
import { cas, insertRows, type Repository, type Statement } from './repository.ts';
import { capture, electionStateStatement } from './campaign-snapshot.ts';
export { electionStateStatement } from './campaign-snapshot.ts';
import { ApiError } from './errors.ts';
import { requestsForAwards, syncElectionRequests } from './election-requests.ts';
import {
  buildElectionTimeline,
  publicElectionTimeline,
  timingOf,
  type PublicElectionTimelineItem,
} from './election-timeline.ts';
import type { ElectionTiming } from '../domain/turn-timing.ts';
import { ReconstructionService, appliedAudit } from './reconstruction.ts';
import { historicalAvailability } from './availability-history.ts';
import { AuditContext, auditAfter, eventsFor, type AuditRow } from './audit-context.ts';
import { discretion, unconsumed } from './early-discretion.ts';
import { type AuditAction } from '../domain/events.ts';
import { turnsBefore } from '../domain/sequence.ts';
import {
  electionCommandFor,
  electionPreconditionError,
  resultDates,
  pendingEarlyListChoice,
  type ElectionCommandContext,
} from './election-commands.ts';
import { projectElectionViewForManager, projectElectionViewForController, type EarlyView } from './projections.ts';
import { concealPendingEarly, earlyProof } from '../domain/early-election.ts';

type Host = {
  load: (cid: string) => Promise<any>;
  commit: (ops: Statement[]) => Promise<any>;
  audit: (action: AuditAction, c: any, before: any, after: any) => Statement;
  assertVaReader: (loaded: any) => Promise<void>;
};
const context = (d: any): ElectionContext => ({
  year: d.campaign.year,
  team: d.campaign.team_id,
  config: d.config,
  members: d.members,
  requests: d.requests,
  awards: d.awards,
  external: d.external,
});
// What «Deshacer» would revert, so the manager confirms knowingly.
function undoSummary(row: any) {
  const after = auditAfter(row) ?? {};
  return {
    action: row.action as string,
    memberId: (after.memberId ?? null) as string | null,
    at: (row.created_at ?? null) as string | null,
    choices: (after.choices ?? []).map((c: any) => ({ memberId: c.member_id as string, date: c.cycle_date as string })),
  };
}
export class ElectionService {
  constructor(
    private repo: Repository,
    private actor: Principal,
    private host: Host,
  ) {}
  reconstruction() {
    return new ReconstructionService(this.repo, this.actor, this.host);
  }
  async read(cid: string) {
    const result = await this.repo.batch([
      { sql: 'SELECT json FROM election_states WHERE campaign_id=?', args: [cid] },
      { sql: 'SELECT * FROM preferences WHERE campaign_id=?', args: [cid] },
    ]);
    return {
      state: result[0].results[0] ? upgradeElectionState(JSON.parse(result[0].results[0].json)) : null,
      // As stored, for compare-and-set: the upgraded state may differ from it.
      stateJson: (result[0].results[0]?.json as string | undefined) ?? null,
      preferences: result[1].results.map(preferenceFromRow),
    };
  }
  /**
   * The campaign as any viewer may see it, administrators included: early choices of
   * others that still wait for their slot are left out (concealPendingEarly), with the
   * original requests they recorded (server/early-discretion.ts).
   */
  async concealedFor<
    D extends {
      campaign: { id: string; team_id: string };
      awards: { id: string }[];
      requests: { id: string; member_id: string; cycle_date: string }[];
    },
  >(
    d: D,
    stored?: ElectionState | null,
    audit?: AuditContext,
  ): Promise<{ d: D; state?: ElectionState | null; hidden: Set<string>; consumed?: Map<string, string> }> {
    const state = stored !== undefined ? stored : (await this.read(d.campaign.id)).state;
    if (!state) return { d, state, hidden: new Set() };
    const rows = await (audit?.rows() ?? eventsFor(this.repo, d.campaign.id));
    // Withdrawn ones may have left their request behind (a rebuild restores requests).
    if (!state.earlyChoices?.length && !rows.some((row) => row.action === 'early_choose' || row.action === 'advance'))
      return { d, state, hidden: new Set() };
    const mine = await this.memberForAccount(d);
    const masked = concealPendingEarly(context(d), state, mine, d.awards);
    const { ids, consumed } = discretion(rows, masked.hidden, mine, new Set(d.awards.map((a) => a.id)), d.requests);
    const requests = d.requests.filter((r) => !ids.has(r.id));
    if (!masked.hidden.size && requests.length === d.requests.length) return { d, state, hidden: masked.hidden };
    return {
      d: { ...d, awards: masked.awards, requests },
      state: masked.state,
      hidden: masked.hidden,
      consumed,
    };
  }
  /** Load and read for the read-only endpoints, concealed as concealedFor() does. */
  async concealedRead(cid: string) {
    const loaded = await this.host.load(cid);
    await this.host.assertVaReader(loaded);
    const raw = await this.read(cid);
    const { d, state } = await this.concealedFor(loaded, raw.state);
    return { d, raw: state !== undefined ? { ...raw, state } : raw, concealing: d !== loaded };
  }
  /** Public progress of a live campaign: whose turn it is, for how long, and how long each turn took. */
  async summary(cid: string, now = Date.now()) {
    const { d, raw } = await this.concealedRead(cid);
    const ctx = context(d);
    let turn: ReturnType<typeof currentTurn> | null = null;
    try {
      turn = raw.state ? currentTurn(ctx, raw.state) : null;
    } catch {
      turn = null;
    }
    const rows = await eventsFor(this.repo, cid);
    // While an administrator reconstructs the history nobody can choose: no one is being waited for.
    const session = await this.reconstruction().read(cid),
      frozen = !!session && session.status !== 'completed';
    const timing = raw.state
      ? timingOf(rows, buildElectionTimeline(rows, ctx, raw.state), raw.state, now, frozen, firmAwards(ctx, raw.state))
      : null;
    let total = 0;
    for (const m of d.members)
      try {
        total += entitlementFor(ctx, m.id);
      } catch {
        /* A member without a policy entitlement adds nothing to the expected total. */
      }
    return {
      campaignId: cid,
      teamId: d.campaign.team_id as string,
      year: d.campaign.year as number,
      status: (raw.state?.status ?? null) as ElectionState['status'] | null,
      frozen,
      round: raw.state?.status === 'active' ? (turn?.round ?? null) : null,
      turn:
        raw.state?.status === 'active' && !frozen && turn?.memberId && !turn.pendingTie
          ? { participants: [...turn.participants], needed: turn.needed }
          : null,
      pendingTie: !!turn?.pendingTie,
      members: ctx.members.map((m) => ({ id: m.id, code: m.code })),
      awarded: d.awards.length,
      total,
      timing,
    };
  }
  async memberForAccount(d: any) {
    if (this.actor.preview)
      return this.actor.preview.campaignId === d.campaign.id &&
        d.members.some((m: any) => m.id === this.actor.preview!.memberId)
        ? this.actor.preview.memberId
        : null;
    if (!this.actor.id) return null;
    const keys = [this.actor.id, ...(this.actor.emailKey ? [this.actor.emailKey] : [])];
    const matches = await this.repo.all(
      `SELECT DISTINCT m.id FROM campaign_members m JOIN controller_accounts a ON a.person_id=m.person_id WHERE m.campaign_id=? AND a.principal_key IN (${keys.map(() => '?').join(',')})`,
      [d.campaign.id, ...keys],
    );
    // Refuse ambiguous mappings (for example an old UID linked to another person's email).
    return matches.length === 1 ? matches[0].id : null;
  }
  // A linked controller owns their preferences even when a team administrator manages the team.
  // Superadministrators retain access; team administrators may assist only unlinked users.
  async preferenceMemberIds(d: any, mine: string | null): Promise<string[]> {
    if (
      this.actor.role === 'superadmin' ||
      (d.campaign.scope_key !== 'live' && canWrite(this.actor, d.campaign.team_id))
    )
      return d.members.map((m: any) => m.id);
    if (!canWrite(this.actor, d.campaign.team_id)) return mine ? [mine] : [];
    const linked = await this.repo.all(
      'SELECT m.id FROM campaign_members m JOIN controller_accounts a ON a.person_id=m.person_id WHERE m.campaign_id=?',
      [d.campaign.id],
    );
    const restricted = new Set(linked.map((row: any) => row.id));
    return d.members.filter((m: any) => m.id === mine || !restricted.has(m.id)).map((m: any) => m.id);
  }
  async history(cid: string, audit?: AuditContext) {
    if (audit) return audit.replay();
    // Replay the append-only audit to recover independent undo and redo stacks.
    // A new decision after an undo creates a new branch and clears only the redo stack.
    return appliedAudit(await eventsFor(this.repo, cid));
  }
  // Edits to lists this actor may not touch stay out of their undo: «Deshacer»
  // reaches the newest decision below them instead of being blocked by them.
  // Discreet early choices of others stay out of it too (server/early-discretion.ts).
  // `hidden` is what concealedFor() hid; without it, `d` must be the stored campaign.
  async managerHistory(cid: string, d: any, mine: string | null, audit?: AuditContext, hidden?: Set<string>) {
    const history = await this.history(cid, audit),
      editable = new Set(await this.preferenceMemberIds(d, mine));
    if (!hidden) {
      const state = (await this.read(cid)).state;
      hidden = state ? concealPendingEarly(context(d), state, mine, d.awards).hidden : new Set();
    }
    // `d` may be the concealed campaign: what it hid is still there.
    const live = new Set<string>([...d.awards.map((a: { id: string }) => a.id), ...hidden]);
    const discreet = discretion(audit ? await audit.rows() : await eventsFor(this.repo, cid), hidden, mine, live);
    const isDiscreet = (entry: AuditRow | null) => !!entry && discreet.row(entry);
    const isPrivate = (entry: any) =>
      (entry.action === 'preferences' && !editable.has(auditAfter(entry)?.memberId)) || isDiscreet(entry);
    return {
      ...history,
      undo: history.done.findLast((entry) => !isPrivate(entry)) ?? null,
      // Redo only what this viewer could see being undone.
      redo: history.redo && isDiscreet(history.redoOriginal) ? null : history.redo,
      isPrivate,
      isDiscreet,
      /** Any historical row, effective or not (archived branches, rebuilt decisions). */
      discreetIds: discreet.ids,
      hidden,
    };
  }
  async options(cid: string, selected: string[], jointEntries?: { member_id: string; dates: string[] }[]) {
    const { d, raw } = await this.concealedRead(cid),
      mine = await this.memberForAccount(d);
    const reconstruction = await this.reconstruction().read(cid);
    if (reconstruction && reconstruction.status !== 'completed')
      throw new ApiError('Las elecciones están congeladas durante la reconstrucción', 409);
    if (
      d.campaign.scope_key !== 'live' &&
      !canWrite(this.actor, d.campaign.team_id) &&
      this.actor.preview?.campaignId !== cid
    )
      throw new ApiError('Simulación reservada a administradores', 403);
    if (!raw.state || d.campaign.status !== 'open') throw new ApiError('No hay un turno activo');
    const ctx = context(d),
      turn = currentTurn(ctx, raw.state),
      rules = occupancyOf(ctx);
    if (!turn.memberId || (!canWrite(this.actor, d.campaign.team_id) && turn.memberId !== mine))
      throw new ApiError('No es tu turno', 403);
    if (jointEntries !== undefined) {
      if (!rules || !canWrite(this.actor, d.campaign.team_id) || turn.participants.length < 2)
        throw new ApiError('Este turno conjunto no admite previsualización', 403);
      if (
        !Array.isArray(jointEntries) ||
        jointEntries.length !== turn.participants.length ||
        new Set(jointEntries.map((e) => e.member_id)).size !== jointEntries.length ||
        jointEntries.some(
          (e) =>
            !turn.participants.includes(e.member_id) ||
            !Array.isArray(e.dates) ||
            e.dates.length !== turn.requiredByMember[e.member_id] ||
            e.dates.some((x) => typeof x !== 'string'),
        )
      )
        throw new ApiError('Turno conjunto incompleto');
      const choices = jointEntries.flatMap((e) =>
        e.dates.map((cycle_date) => ({ member_id: e.member_id, cycle_date })),
      );
      const check = rules.evaluateCandidate(rules.state(ctx, ctx.members, ctx.awards), choices);
      return {
        version: d.campaign.version,
        policyVersion: rules.version,
        allowed: check.allowed,
        available: [],
        issues: check.issues,
        warnings: check.warnings,
      };
    }

    if (
      !Array.isArray(selected) ||
      selected.length > turn.needed ||
      new Set(selected).size !== selected.length ||
      selected.some((x) => typeof x !== 'string')
    )
      throw new ApiError('Selección inicial no válida');
    if (rules) {
      const policyState = rules.state(ctx, ctx.members, ctx.awards);
      const inspect = (dates: string[]) =>
        rules.evaluateCandidate(
          policyState,
          dates.map((cycle_date) => ({ member_id: turn.memberId!, cycle_date })),
        );
      const chosen = inspect(selected);
      if (selected.length === turn.needed) {
        return {
          version: d.campaign.version,
          policyVersion: rules.version,
          allowed: chosen.allowed,
          available: [],
          reasons: {},
          warnings: chosen.warnings,
        };
      }
      if (!chosen.allowed) throw new ApiError(chosen.issues.map((i) => i.message).join('; '));
      // All candidates extend exactly this same already-valid selection.
      // The current completion witness can often be reused or repaired by an
      // atomic exchange rather than solving the full campaign for every date.
      const choices = rules.legalChoices(policyState, turn.memberId!, {
        selected,
        witness: chosen.completion.witness,
      });
      const reasons: Record<string, unknown> = {},
        warnings: Record<string, unknown> = {},
        available: string[] = [],
        pending: string[] = [];
      const legal = new Set(choices.legal),
        unknown = new Set(choices.unknown);
      for (const date of resultDates(ctx)) {
        if (legal.has(date)) available.push(date);
        else if (unknown.has(date)) {
          // A slow proof is not a veto. Allow a provisional selection and validate
          // the entire atomic choice on confirmation with the full budget.
          available.push(date);
          pending.push(date);
        } else reasons[date] = choices.illegal[date] ?? [];
      }
      return {
        version: d.campaign.version,
        policyVersion: rules.version,
        allowed: true,
        available,
        pending,
        reasons,
        warnings,
      };
    }
    if (selected.length >= turn.needed || choiceIssues(ctx, turn.memberId, selected).length)
      throw new ApiError('Selección inicial no válida');
    return {
      version: d.campaign.version,
      available: resultDates(ctx).filter((date) => !choiceIssues(ctx, turn.memberId!, [...selected, date]).length),
    };
  }
  /** Cycle-wide existential availability, independent of whose turn it is. */
  async availability(cid: string) {
    const { d, concealing } = await this.concealedRead(cid);
    if (
      d.campaign.scope_key !== 'live' &&
      !canWrite(this.actor, d.campaign.team_id) &&
      this.actor.preview?.campaignId !== cid
    )
      throw new ApiError('Simulación reservada a administradores', 403);
    const ctx = context(d),
      rules = occupancyOf(ctx);
    if (!rules) throw new ApiError('Disponibilidad global solo disponible con un motor de ocupación', 400);
    const state = rules.state(ctx, ctx.members, ctx.awards);
    const history = await historicalAvailability(this.repo, cid, d.campaign.version);
    // A recorded availability counts the hidden awards: recompute it from the masked view.
    const availability = history.restored
      ? ((concealing ? null : rules.recordedAvailability(state, history.recordedAvailability)) ??
        rules.restoredAvailability(state))
      : rules.availability(state);
    return { version: d.campaign.version, ...availability };
  }
  /**
   * Non-mutating preflight for the complete atomic choice at the current turn.
   * Preview and confirmation derive their results from the same domain evaluator;
   * the client must supply the campaign version for optimistic concurrency.
   */
  async previewImpact(cid: string, choices: PolicyAward[], version: number) {
    const { d, raw } = await this.concealedRead(cid),
      mine = await this.memberForAccount(d);
    const rules = occupancyOf(scopeOf(d.campaign));
    if (!rules) throw new ApiError('El informe de impacto requiere un motor de ocupación', 400);
    if (
      d.campaign.scope_key !== 'live' &&
      !canWrite(this.actor, d.campaign.team_id) &&
      this.actor.preview?.campaignId !== cid
    )
      throw new ApiError('Simulación reservada a administradores', 403);
    if (d.campaign.version !== version) throw new ApiError('La campaña cambió. Recarga antes de confirmar.', 409);
    if (d.campaign.status !== 'open' || !raw.state) throw new ApiError('La elección no está activa', 409);
    const reconstruction = await this.reconstruction().read(cid);
    if (reconstruction && reconstruction.status !== 'completed')
      throw new ApiError('La elección está congelada durante la reconstrucción', 409);
    const contextState = context(d),
      turn = currentTurn(contextState, raw.state);
    const manage = canWrite(this.actor, d.campaign.team_id);
    // No fixed maximum: the checks below require exactly what the turn needs
    // (a joint turn of three, each recovering two deferrals, is nine awards).
    if (
      !Array.isArray(choices) ||
      choices.length === 0 ||
      choices.some((a) => typeof a?.member_id !== 'string' || typeof a?.cycle_date !== 'string') ||
      new Set(choices.map((a) => a.member_id + '|' + a.cycle_date)).size !== choices.length
    )
      throw new ApiError('Combinación de adjudicaciones no válida', 400);
    if (turn.participants.length > 1) {
      if (
        !manage ||
        turn.participants.some(
          (id) => choices.filter((a) => a.member_id === id).length !== turn.requiredByMember[id],
        ) ||
        choices.some((a) => !turn.participants.includes(a.member_id))
      )
        throw new ApiError(
          'El turno conjunto debe previsualizarse como una sola operación y con todos sus participantes',
          403,
        );
    } else if (
      !turn.memberId ||
      (!manage && turn.memberId !== mine) ||
      choices.length !== turn.needed ||
      choices.some((a) => a.member_id !== turn.memberId)
    )
      throw new ApiError('La previsualización no corresponde al turno completo', 403);
    const allocation = rules.state(contextState, contextState.members, contextState.awards);
    return { version, ...rules.previewChoiceImpact(allocation, choices) };
  }
  async view(
    d: any,
    options: {
      restored?: boolean;
      result?: ReturnType<typeof calculate>;
      recordedAvailability?: AvailabilitySnapshot | CompactAvailabilitySnapshot | null;
      skipAvailabilityForPendingAutomatic?: boolean;
      auditContext?: AuditContext;
      /** The state as concealedFor() left it, instead of the stored one, and what it hid. */
      state?: ElectionState | null;
      hidden?: Set<string>;
      /** Lists a waiting early choice consumed, shown as they were (unconsumed). */
      consumed?: Map<string, string>;
      /** The stored campaign when `d` is concealed: automatic steps are decided on it. */
      unconcealed?: Parameters<typeof context>[0];
    } = {},
  ) {
    const cid = d.campaign.id,
      manage = canWrite(this.actor, d.campaign.team_id),
      mine = await this.memberForAccount(d),
      stored = await this.read(cid),
      raw = options.state !== undefined ? { ...stored, state: options.state } : stored,
      ctx = context(d),
      preferenceMemberIds = await this.preferenceMemberIds(d, mine);
    let turn: any = null;
    if (raw.state) {
      try {
        turn = currentTurn(ctx, raw.state);
      } catch {
        turn = null;
      }
    }
    const focus = manage ? turn?.memberId : mine;
    const result =
      options.result ??
      calculate(
        ctx.year,
        ctx.team,
        ctx.config,
        ctx.members,
        d.campaign.status === 'open' ? requestsForAwards(cid, ctx.awards, ctx.requests) : ctx.requests,
        ctx.awards,
        { skipProof: options.restored, external: ctx.external },
      );
    const reconstruction = await this.reconstruction().view(
      d,
      raw,
      options.restored === true,
      options.auditContext,
      mine,
    );
    // Determine whether the next automatic turn can be resolved by its stored
    // preferences BEFORE starting the table-wide global availability searches.
    // The intermediate POST response is not rendered: the client immediately
    // sends the next advance request. Normal GET and final POST stay complete.
    // Decided on the stored data, as `advance` is: concealed early choices would
    // otherwise look still pending and make the client advance forever.
    const realCtx = options.unconcealed ? context(options.unconcealed) : ctx;
    let realTurn: ReturnType<typeof currentTurn> | null = turn;
    if (options.unconcealed && stored.state) {
      try {
        realTurn = currentTurn(realCtx, stored.state);
      } catch {
        realTurn = null;
      }
    }
    const realState = options.unconcealed ? stored.state : raw.state;
    const pendingAutomatic =
      !options.restored &&
      !reconstruction.active &&
      !!(
        realState &&
        realTurn &&
        (preferredChoice(realCtx, realTurn.state, raw.preferences, Date.now()) ||
          pendingEarlyListChoice(realCtx, realState, raw.preferences))
      );
    // Independent units (VA) cost a subtraction: their availability is never deferred.
    const skipFullAvailability =
      !!options.skipAvailabilityForPendingAutomatic && pendingAutomatic && !policyOf(realCtx).independentUnits;
    // A single source of truth per snapshot. Previous code evaluated rejected
    // policy choices twice and reconstructed the full HR calendar for every date.
    const availabilityReasons: Record<string, string> = {};
    const availabilityWarnings: Record<string, unknown> = {};
    const availabilityPending: string[] = [];
    let available: string[] = [];
    const rules = occupancyOf(ctx);
    if (focus && rules && !skipFullAvailability) {
      const allocation = rules.state(ctx, ctx.members, ctx.awards);
      if (options.restored) {
        for (const cycle of result.cycles) {
          const issues = rules.immediateIssues(allocation, [{ member_id: focus, cycle_date: cycle.date }]);
          if (issues.length) availabilityReasons[cycle.date] = issues.map((i) => i.message).join('; ');
          else {
            available.push(cycle.date);
            availabilityPending.push(cycle.date);
          }
        }
      } else {
        const choices = rules.legalChoices(allocation, focus);
        const legal = new Set(choices.legal),
          unknown = new Set(choices.unknown);
        for (const cycle of result.cycles) {
          if (legal.has(cycle.date)) available.push(cycle.date);
          else if (unknown.has(cycle.date)) {
            available.push(cycle.date);
            availabilityPending.push(cycle.date);
            availabilityWarnings[cycle.date] = [
              {
                code: 'COMPLETION_UNDETERMINED',
                message: 'Disponibilidad provisional: se comprobará con el solver completo al confirmar.',
              },
            ];
          } else
            availabilityReasons[cycle.date] =
              (choices.illegal[cycle.date] ?? []).map((i) => i.message).join('; ') ||
              'No disponible en el contexto actual';
        }
      }
    } else if (focus && !skipFullAvailability)
      available = result.cycles.filter((c) => !choiceIssues(ctx, focus, [c.date]).length).map((c) => c.date);
    // This is the progress of awarded cycles, not historical points from requests.
    // Requests are still used by calculate() to establish next year's election order.
    const cycleScores = new Map(result.cycles.map((c) => [c.date, c.score]));
    const points = d.members.map((m: any) => {
      const awarded = d.awards.filter((a: any) => a.member_id === m.id);
      return {
        member_id: m.id,
        cycles: awarded.length,
        points: awarded.reduce((sum: number, a: any) => sum + (cycleScores.get(a.cycle_date) ?? 0), 0),
      };
    });
    const history = manage ? await this.managerHistory(cid, d, mine, options.auditContext, options.hidden) : null;
    // Replay persisted actions, then expose only an allowlisted compact projection
    // to public viewers. Managers retain the complete existing timeline.
    let timeline: ReturnType<typeof buildElectionTimeline> | PublicElectionTimelineItem[] = [];
    let timing: ElectionTiming | null = null;
    if (manage || raw.state || ctx.awards.length) {
      const rows = await (options.auditContext?.rows() ?? eventsFor(this.repo, cid));
      const events = buildElectionTimeline(rows as any, ctx, raw.state, history ?? undefined);
      timeline = manage ? events : publicElectionTimeline(events, rows as any);
      timing = timingOf(rows, events, raw.state, Date.now(), reconstruction.active, firmAwards(ctx, raw.state));
    }

    const cycleAvailability =
      rules && !skipFullAvailability
        ? options.restored
          ? (rules.recordedAvailability(rules.state(ctx, ctx.members, ctx.awards), options.recordedAvailability) ??
            rules.restoredAvailability(rules.state(ctx, ctx.members, ctx.awards)))
          : rules.availability(rules.state(ctx, ctx.members, ctx.awards))
        : null;
    const accounts = canWrite(this.actor, d.campaign.team_id)
      ? await this.repo.all(
          'SELECT a.*,m.id AS member_id FROM controller_accounts a JOIN campaign_members m ON m.person_id=a.person_id WHERE m.campaign_id=?',
          [cid],
        )
      : [];
    // The controller's own link, so they can replace its email (link_account).
    const myAccountVersion =
      mine && d.campaign.scope_key === 'live'
        ? (((
            await this.repo.all(
              'SELECT a.version FROM controller_accounts a JOIN campaign_members m ON m.person_id=a.person_id WHERE m.id=?',
              [mine],
            )
          )[0]?.version as number | undefined) ?? 0)
        : null;
    // Only counts, for the controller's own forecast; never whose lists are active.
    const ahead =
      mine && raw.state?.status === 'active' && !raw.state.automaticPaused && !turn?.pendingTie
        ? turnsBefore(sequenceFor(ctx, raw.state), mine)
        : null;
    const turnsAhead = ahead?.length ?? null;
    // Only an individual turn resolves on its own, and a list that waits, or is only a
    // note, does not shorten anybody's wait.
    const automaticAhead = ahead
      ? ahead.filter(
          (slot) =>
            slot.participants.length === 1 &&
            raw.preferences.some(
              (p) => p.member_id === slot.participants[0] && activeList(p) && (p.mode ?? 'immediate') === 'immediate',
            ),
        ).length
      : null;
    // The viewer's own early election: proved cycles, and early choices they may withdraw.
    let early: EarlyView | null = null;
    if (mine && raw.state && !reconstruction.active && !skipFullAvailability) {
      const proof = options.restored
        ? null
        : earlyProof(
            ctx,
            raw.state,
            mine,
            result.cycles.map((c) => c.date),
          );
      const cursor = turn?.state?.cursor ?? raw.state.cursor;
      // Entries remain in election state after their turn for traceability.
      // Only pending choices are still "early"; confirmed ones appear as ordinary awards.
      const choices = (raw.state.earlyChoices ?? []).flatMap((e) => {
        if (e.memberId !== mine || e.cursor <= cursor) return [];
        const award = ctx.awards.find((a) => a.id === e.awardId);
        return award ? [{ awardId: e.awardId, date: award.cycle_date, cancellable: true }] : [];
      });
      if (proof || choices.length)
        early = {
          guaranteed: proof?.guaranteed ?? [],
          indeterminate: proof?.indeterminate ?? false,
          round: proof?.window.round ?? null,
          owed: proof?.window.owed ?? 0,
          choices,
        };
    }
    const listPlan = !skipFullAvailability ? this.listPlan(ctx, raw, turn, manage, mine) : null;
    // Display only: what the election runs on stays raw.preferences.
    const shownPreferences = options.consumed ? unconsumed(raw.preferences, options.consumed) : raw.preferences;
    const queue =
      manage && raw.state && raw.state.status !== 'complete' ? roundQueue(ctx, raw.state, shownPreferences) : null;
    let chain: ReturnType<typeof automaticChain> | null = null;
    if (manage && queue && !skipFullAvailability && !reconstruction.active && !turn?.pendingTie) {
      try {
        chain = automaticChain(ctx, raw.state!, shownPreferences, 6);
      } catch {
        chain = null;
      }
    }
    // Nobody may rebuild from, or even see, a discreet early choice.
    const visibleReconstruction: typeof reconstruction =
      history && 'candidates' in reconstruction && Array.isArray(reconstruction.candidates)
        ? {
            ...reconstruction,
            candidates: reconstruction.candidates.filter(
              (candidate: { id: string }) => !history.discreetIds.has(candidate.id),
            ),
          }
        : reconstruction;
    const projection = {
      state: raw.state,
      turn: turn
        ? {
            memberId: turn.memberId,
            needed: turn.needed,
            round: turn.round,
            pendingTie: turn.pendingTie,
            participants: turn.participants,
            requiredByMember: turn.requiredByMember,
            canDefer: !!(
              turn.memberId &&
              turn.participants.length === 1 &&
              raw.state?.allowDeferral &&
              // The last round of a policy with fixed rounds takes the whole balance.
              turn.round < (policyOf(ctx).rounds ?? Infinity) &&
              (raw.state.credits[turn.memberId] ?? 0) < 2 &&
              ctx.awards.filter((a) => a.member_id === turn.memberId).length +
                2 +
                (raw.state.credits[turn.memberId] ?? 0) <=
                entitlementFor(ctx, turn.memberId)
            ),
          }
        : null,
      preferences: shownPreferences,
      preferenceMemberIds,
      myMemberId: mine,
      available,
      availabilityPending,
      availabilityReasons,
      availabilityWarnings,
      cycleAvailability,
      occupancyPolicyVersion: rules?.version ?? null,
      activationRulesName: policyOf(scopeOf(d.campaign)).activationRulesName ?? 'las normas vigentes de este ejercicio',
      rosterOrder: policyOf(scopeOf(d.campaign)).rosterOrder === true,
      policyPresentation: rules?.presentation ?? null,
      points,
      accounts,
      undo: history?.undo?.id ?? null,
      undoSummary: history?.undo ? undoSummary(history.undo) : null,
      redo: history?.redo?.id ?? null,
      pendingAutomatic,
      turnsAhead,
      automaticAhead,
      early,
      listPlan,
      queue,
      chain,
      timeline,
      timing,
      myAccountVersion,
      reconstruction: visibleReconstruction,
    };
    return manage ? projectElectionViewForManager(projection) : projectElectionViewForController(projection);
  }
  /**
   * Scheduled: apply the lists whose wait has run out, nobody having the page open.
   * Also starts the clock of a turn opened before it existed (or by a reconstruction),
   * without a new campaign version: it is bookkeeping, not a decision.
   */
  async expire(cid: string, now = Date.now(), maxTurns = 12) {
    let applied = 0;
    for (let step = 0; step < maxTurns; step++) {
      const d = await this.host.load(cid),
        raw = await this.read(cid);
      if (d.campaign.status !== 'open' || raw.state?.status !== 'active' || raw.state.automaticPaused) break;
      const reconstruction = await this.reconstruction().read(cid);
      if (reconstruction && reconstruction.status !== 'completed') break;
      const ctx = context(d),
        turn = currentTurn(ctx, raw.state);
      if (!turn.memberId) break;
      const stamped = stampTurn(raw.state, turn.state.cursor, new Date(now).toISOString());
      if (stamped !== raw.state) {
        // The revision bump makes open pages fetch the new deadline.
        await this.repo.batch([
          {
            sql: 'UPDATE election_states SET json=? WHERE campaign_id=? AND json=?',
            args: [JSON.stringify(stamped), cid, raw.stateJson],
          },
          { sql: "UPDATE app_state SET revision=revision+1 WHERE id='main'" },
        ]);
        break;
      }
      if (!preferredChoice(ctx, turn.state, raw.preferences, now)) break;
      const result = await this.mutate(cid, { action: 'advance', version: d.campaign.version }, now);
      if (!result?.changed) break;
      applied++;
    }
    return applied;
  }
  /** What the list of whoever holds the turn will do, for them and for managers only. */
  private listPlan(
    ctx: ElectionContext,
    raw: { state: ElectionState | null; preferences: Preference[] },
    turn: any,
    manage: boolean,
    mine: string | null,
  ) {
    if (
      raw.state?.status !== 'active' ||
      !turn?.memberId ||
      turn.participants.length !== 1 ||
      (!manage && turn.memberId !== mine)
    )
      return null;
    const pref = raw.preferences.find((p) => p.member_id === turn.memberId && p.active !== false);
    if (!activeList(pref) || pref.mode === 'manual') return null;
    const at = automaticAt(pref, turn.state, turn.state.cursor);
    let dates: string[] | null = null;
    try {
      dates = listChoice(ctx, turn, pref);
    } catch {
      dates = null;
    }
    return {
      memberId: turn.memberId as string,
      mode: pref.mode ?? 'immediate',
      waitMinutes: pref.waitMinutes ?? 0,
      deadline: at && at > 0 ? new Date(at).toISOString() : null,
      paused: !!raw.state.automaticPaused,
      dates,
    };
  }
  async mutate(cid: string, body: any, now = Date.now()) {
    if (this.actor.preview && this.actor.preview.campaignId !== cid)
      throw new ApiError('Vista previa ajena a esta campaña', 403);
    if (this.actor.preview && !this.actor.preview.writable)
      throw new ApiError('La vista previa de la campaña real no permite guardar', 403);
    const d = await this.host.load(cid),
      c = d.campaign,
      manage = canWrite(this.actor, c.team_id),
      mine = await this.memberForAccount(d),
      raw = await this.read(cid),
      ctx = context(d);
    if (c.scope_key !== 'live' && !manage && this.actor.preview?.campaignId !== cid)
      throw new ApiError('Simulación reservada a administradores', 403);
    if (!this.actor.id) throw new ApiError('Inicia sesión para guardar preferencias', 401);
    if (!manage && !mine) throw new ApiError('Tu cuenta no está vinculada a un controlador de este equipo', 403);
    if (c.status !== 'open') throw new ApiError('La campaña está cerrada');
    if (body.version !== c.version) throw new ApiError('La campaña cambió. Recarga antes de guardar.', 409);
    const action = body.action;
    if (typeof action === 'string' && action.startsWith('reconstruction_'))
      return this.reconstruction().mutate(d, raw, body);
    const reconstruction = await this.reconstruction().read(cid);
    if (reconstruction && reconstruction.status !== 'completed')
      throw new ApiError('Elección congelada: termina la reconstrucción administrativa antes de continuar', 409);
    const command = electionCommandFor(action);
    if (!command) throw new ApiError('Operación de elección no válida');
    const failed = electionPreconditionError(command, { live: c.scope_key === 'live', manage, state: raw.state });
    if (failed) throw new ApiError(failed.message, failed.status);
    const x: ElectionCommandContext = {
      service: this,
      repo: this.repo,
      actor: this.actor,
      cid,
      body,
      d,
      c,
      ctx,
      manage,
      mine,
      raw,
      now,
      ops: cas(cid, c.version),
      state: raw.state,
      preferences: raw.preferences,
      choices: [],
      recordUndo: true,
      authorizeMember: (memberId: string) => {
        if (!d.members.some((m: any) => m.id === memberId)) throw new ApiError('Controlador ajeno al equipo');
        if (!manage && memberId !== mine)
          throw new ApiError('Solo puedes modificar tus propias preferencias o elegir en tu turno', 403);
      },
    };
    const snapshot = capture(d, raw);
    try {
      const outcome = await command.execute(x);
      if (outcome && outcome.changed === false) return outcome;
    } catch (e: any) {
      if (e.status) throw e;
      throw new ApiError(e.message);
    }
    const { ops, choices, recordUndo, preferences } = x;
    let state = x.state;
    // Save preference consumption atomically with awards, requests and cursor.
    if (!command.restoresSnapshot)
      for (const p of preferences) {
        const prior = raw.preferences.find((previous) => previous.member_id === p.member_id);
        if (prior && prior.active !== p.active)
          ops.push({
            sql: 'UPDATE preferences SET active=? WHERE member_id=? AND campaign_id=?',
            args: [p.active !== false ? 1 : 0, p.member_id, cid],
          });
      }
    // Undo and redo restore their snapshot exactly; undo also pauses automatic choices, and resuming restarts the clock.
    // A draw that held up the turn opens it now: the wait counts from here, not from before the draw.
    let blockedByTie = false;
    if (action === 'resolve_tie' && raw.state)
      try {
        blockedByTie = !!currentTurn(ctx, raw.state).pendingTie;
      } catch {
        blockedByTie = false;
      }
    if (!command.restoresSnapshot)
      state = stampTurnAfter(ctx, state, choices, new Date(now).toISOString(), !!command.restartsClock || blockedByTie);
    ops.push(electionStateStatement(cid, state));
    ops.push(
      ...insertRows(
        'awards',
        ['id', 'campaign_id', 'member_id', 'cycle_date', 'version'],
        choices.map((a) => [a.id ?? crypto.randomUUID(), cid, a.member_id, a.cycle_date, 1]),
      ),
    );
    // Before closure only effective awards count. Superseded requests from older
    // reconstructions must not consume a right or block the sixth choice.
    if (choices.length)
      ops.push(
        ...syncElectionRequests(
          cid,
          [...d.awards, ...choices],
          d.requests,
          choices.map((a) => a.member_id),
        ),
      );
    // Snapshot the causal impact BEFORE committing the atomic batch. Undo/redo
    // retain the original immutable report in audit but the timeline replays only
    // currently effective decisions. An indeterminate solver proof stays explicit.
    const rules = occupancyOf(ctx);
    const impact =
      rules && choices.length
        ? rules.impact(
            rules.state(ctx, ctx.members, ctx.awards),
            rules.state(ctx, ctx.members, [...ctx.awards, ...choices]),
          )
        : null;
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
    // Persist the policy warnings of the resulting allocation with the decision,
    // so the history keeps them after undo/redo or a later fast simulation.
    let warnings: { code: string; message: string; period?: number }[] | undefined;
    if (rules && choices.length) {
      const next = rules.state(ctx, ctx.members, [...ctx.awards, ...choices]);
      const complete = next.members.every(
        (m) => next.awards.filter((a) => a.member_id === m.id).length === m.entitlement,
      );
      warnings = (
        complete
          ? rules.evaluateFinal(next).warnings
          : rules.partialAssessment(next, { maxChecks: rules.budgets.review }).warnings
      ).map((w) => ({ code: w.code, message: w.message, ...(w.period !== undefined ? { period: w.period } : {}) }));
    }
    ops.push(
      this.host.audit(action, c, recordUndo ? snapshot : null, {
        impact: auditImpact,
        ...(warnings ? { warnings } : {}),
        version: c.version + 1,
        choices,
        memberId: body.memberId ?? null,
        ...command.audited?.(x),
      }),
    );
    await this.host.commit(ops);
    return { changed: true };
  }
}
/**
 * Awards that are firm for turn timing: an early choice counts only once its slot
 * has come. Before that its turn has not happened, so it stays out of the timing
 * for everyone, its owner included (who still sees it in their own views).
 */
function firmAwards(ctx: ElectionContext, state: ElectionState | null) {
  if (!state) return ctx.awards;
  const pending = concealPendingEarly(ctx, state, null, ctx.awards).hidden;
  return pending.size ? ctx.awards.filter((a) => !pending.has(a.id)) : ctx.awards;
}
/** Start the clock of the turn that `state` leaves open (see ElectionState.turnSince). */
export function stampTurnAfter(
  ctx: ElectionContext,
  state: ElectionState | null,
  choices: { member_id: string; cycle_date: string }[],
  at: string,
  restart = false,
): ElectionState | null {
  if (!state || state.status !== 'active') return state;
  let cursor = state.cursor;
  try {
    cursor = currentTurn(
      { ...ctx, awards: [...ctx.awards, ...choices.map((c, i) => ({ ...c, id: 'stamp-' + i }))] },
      state,
    ).state.cursor;
  } catch {
    /* An undo restores other awards; its cursor is already normalized. */
  }
  return stampTurn(state, cursor, at, restart);
}
