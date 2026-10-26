import {
  advanceAutomatic,
  choose,
  chooseJoint,
  currentTurn,
  defer,
  consumePreferences,
  choiceIssues,
  preferredChoice,
  validateOrder,
  validateElectionState,
  entitlementFor,
  resolveTie,
  drawTie,
  registerJointAgreement,
  cancelJointAgreement,
  ELECTION_POLICY_VERSION,
  PREFERENCE_COLUMNS,
  PREFERENCE_MODES,
  MAX_WAIT_MINUTES,
  preferenceRow,
  preferenceFromRow,
  cleanLabels,
  MAX_LABEL_LENGTH,
  stampTurn,
  automaticAt,
  automaticChain,
  listChoice,
  activeList,
  roundQueue,
  type ElectionState,
  type Preference,
  type PreferenceMode,
  type ElectionContext,
} from '../domain/election.ts';
import { calculate } from '../domain/vacations.ts';
import type { AvailabilitySnapshot, CompactAvailabilitySnapshot } from '../domain/occupancy.ts';
import { occupancyFor, type OccupancyRules, type PolicyAward } from '../domain/policy.ts';
import { canWrite, requireSuper, type Principal } from './permissions.ts';
import { cas, insertRows, type Repository, type Statement } from './repository.ts';
import { ApiError } from './errors.ts';
import { buildElectionTimeline, publicElectionTimeline, type PublicElectionTimelineItem } from './election-timeline.ts';
import { ReconstructionService, appliedAudit } from './reconstruction.ts';
import { historicalAvailability } from './availability-history.ts';
import { AuditContext, auditAfter, eventsFor } from './audit-context.ts';
import { ELECTION_UNDO_FORMAT, type AuditAction } from '../domain/events.ts';
import { peopleAhead } from '../domain/sequence.ts';

type Host = {
  load: (cid: string) => Promise<any>;
  commit: (ops: Statement[]) => Promise<any>;
  audit: (action: AuditAction, c: any, before: any, after: any) => Statement;
};
const context = (d: any): ElectionContext => ({
  year: d.campaign.year,
  team: d.campaign.team_id,
  config: d.config,
  members: d.members,
  requests: d.requests,
  awards: d.awards,
});
export function electionStateStatement(cid: string, state: ElectionState | null): Statement {
  return state
    ? {
        sql: 'INSERT INTO election_states(campaign_id,json) VALUES(?,?) ON CONFLICT(campaign_id) DO UPDATE SET json=excluded.json',
        args: [cid, JSON.stringify(state)],
      }
    : { sql: 'DELETE FROM election_states WHERE campaign_id=?', args: [cid] };
}
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
// A list's content as its owner saved it, ignoring the active flag that awards consume.
function listContent(items: Preference[], id: string) {
  const p = items.find((item) => item.member_id === id);
  return p
    ? JSON.stringify({
        dates: p.dates,
        automatic: p.automatic !== false,
        persistent: p.persistent === true,
        mode: p.mode ?? 'immediate',
        waitMinutes: p.waitMinutes ?? 0,
        labels: p.labels ?? {},
      })
    : null;
}
// Lists for an undo/redo snapshot: the snapshot's copy when the content is unchanged
// (or it is the list being restored), otherwise the current list.
function restoredPreferences(prior: Preference[], current: Preference[], restoredMember: string | null): Preference[] {
  const ids = new Set([...prior, ...current].map((p) => p.member_id));
  return [...ids].flatMap((id) => {
    const keep =
      id === restoredMember || listContent(prior, id) === listContent(current, id)
        ? prior.find((p) => p.member_id === id)
        : current.find((p) => p.member_id === id);
    return keep ? [keep] : [];
  });
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
      state: result[0].results[0] ? (JSON.parse(result[0].results[0].json) as ElectionState) : null,
      preferences: result[1].results.map(preferenceFromRow),
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
  async managerHistory(cid: string, d: any, mine: string | null, audit?: AuditContext) {
    const history = await this.history(cid, audit),
      editable = new Set(await this.preferenceMemberIds(d, mine));
    const isPrivate = (entry: any) => entry.action === 'preferences' && !editable.has(auditAfter(entry)?.memberId);
    return { ...history, undo: history.done.findLast((entry) => !isPrivate(entry)) ?? null, isPrivate };
  }
  async options(cid: string, selected: string[], jointEntries?: { member_id: string; dates: string[] }[]) {
    const d = await this.host.load(cid),
      raw = await this.read(cid),
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
      rules = occupancyFor(ctx.year);
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
      const partialState = {
        ...policyState,
        awards: [...policyState.awards, ...selected.map((cycle_date) => ({ member_id: turn.memberId!, cycle_date }))],
      };
      const reasons: Record<string, unknown> = {},
        warnings: Record<string, unknown> = {},
        available: string[] = [],
        pending: string[] = [];
      let remainingChecks = rules.budgets.options.total;
      for (const date of resultDates(ctx)) {
        const budget = Math.min(rules.budgets.options.perCandidate, remainingChecks);
        const candidate = rules.evaluateCandidate(partialState, [{ member_id: turn.memberId!, cycle_date: date }], {
          maxChecks: budget,
          witness: chosen.completion.witness,
          warnings: false,
        });
        remainingChecks = Math.max(0, remainingChecks - candidate.completion.checked);
        if (candidate.allowed) available.push(date);
        else if (candidate.completion.status === 'indeterminate') {
          // A slow proof is not a veto. Allow a provisional selection and validate
          // the entire atomic choice on confirmation with the full budget.
          available.push(date);
          pending.push(date);
        } else reasons[date] = candidate.issues;
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
    const d = await this.host.load(cid);
    if (
      d.campaign.scope_key !== 'live' &&
      !canWrite(this.actor, d.campaign.team_id) &&
      this.actor.preview?.campaignId !== cid
    )
      throw new ApiError('Simulación reservada a administradores', 403);
    const ctx = context(d),
      rules = occupancyFor(ctx.year);
    if (!rules) throw new ApiError('Disponibilidad global solo disponible con un motor de ocupación', 400);
    const state = rules.state(ctx, ctx.members, ctx.awards);
    const history = await historicalAvailability(this.repo, cid, d.campaign.version);
    const availability = history.restored
      ? (rules.recordedAvailability(state, history.recordedAvailability) ?? rules.restoredAvailability(state))
      : rules.availability(state);
    return { version: d.campaign.version, ...availability };
  }
  /**
   * Non-mutating preflight for the complete atomic choice at the current turn.
   * Preview and confirmation derive their results from the same domain evaluator;
   * the client must supply the campaign version for optimistic concurrency.
   */
  async previewImpact(cid: string, choices: PolicyAward[], version: number) {
    const d = await this.host.load(cid),
      raw = await this.read(cid),
      mine = await this.memberForAccount(d);
    const rules = occupancyFor(d.campaign.year);
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
    } = {},
  ) {
    const cid = d.campaign.id,
      manage = canWrite(this.actor, d.campaign.team_id),
      mine = await this.memberForAccount(d),
      raw = await this.read(cid),
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
      calculate(ctx.year, ctx.team, ctx.config, ctx.members, ctx.requests, ctx.awards, { skipProof: options.restored });
    const reconstruction = await this.reconstruction().view(d, raw, options.restored === true, options.auditContext);
    // Determine whether the next automatic turn can be resolved by its stored
    // preferences BEFORE starting the table-wide global availability searches.
    // The intermediate POST response is not rendered: the client immediately
    // sends the next advance request. Normal GET and final POST stay complete.
    const pendingAutomatic =
      !options.restored &&
      !reconstruction.active &&
      !!(raw.state && turn && preferredChoice(ctx, turn.state, raw.preferences, Date.now()));
    const skipFullAvailability = !!options.skipAvailabilityForPendingAutomatic && pendingAutomatic;
    // A single source of truth per snapshot. Previous code evaluated rejected
    // policy choices twice and reconstructed the full HR calendar for every date.
    const availabilityReasons: Record<string, string> = {};
    const availabilityWarnings: Record<string, unknown> = {};
    const availabilityPending: string[] = [];
    let available: string[] = [];
    const rules = occupancyFor(ctx.year);
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
        const baseline = rules.canComplete(allocation, { maxChecks: rules.budgets.commit });
        let remainingChecks = rules.budgets.options.total;
        // The empty campaign is invariant under controller permutations: each
        // final cycle must have an occupant, so every CTA can choose every cycle.
        // After one choice, relabel any other witness occupant to the next CTA;
        // the sole existing assignment is untouched and the histogram identical.
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
        for (const cycle of result.cycles) {
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
            availabilityPending.push(cycle.date);
            availabilityWarnings[cycle.date] = [
              {
                code: 'COMPLETION_UNDETERMINED',
                message: 'Disponibilidad provisional: se comprobará con el solver completo al confirmar.',
              },
            ];
          } else
            availabilityReasons[cycle.date] =
              diagnostic.issues.map((i) => i.message).join('; ') || 'No disponible en el contexto actual';
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
    const history = manage ? await this.managerHistory(cid, d, mine, options.auditContext) : null;
    // Replay persisted actions, then expose only an allowlisted compact projection
    // to public viewers. Managers retain the complete existing timeline.
    let timeline: ReturnType<typeof buildElectionTimeline> | PublicElectionTimelineItem[] = [];
    if (manage || raw.state || ctx.awards.length) {
      const rows = await (options.auditContext?.rows() ?? eventsFor(this.repo, cid));
      const events = buildElectionTimeline(rows as any, ctx, raw.state, history ?? undefined);
      timeline = manage ? events : publicElectionTimeline(events, rows as any);
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
    // Only a count, for the controller's own forecast; never whose lists are active.
    const ahead =
      mine && raw.state?.status === 'active' && !raw.state.automaticPaused && !turn?.pendingTie
        ? peopleAhead(raw.state, ctx.awards, ctx.config.cyclesPerPerson, mine)
        : null;
    // A list that waits, or is only a note, does not shorten anybody's wait.
    const automaticAhead = ahead
      ? ahead.filter((id) =>
          raw.preferences.some((p) => p.member_id === id && activeList(p) && (p.mode ?? 'immediate') === 'immediate'),
        ).length
      : null;
    const listPlan = !skipFullAvailability ? this.listPlan(ctx, raw, turn, manage, mine) : null;
    const queue =
      manage && raw.state && raw.state.status !== 'complete' ? roundQueue(ctx, raw.state, raw.preferences) : null;
    let chain: ReturnType<typeof automaticChain> | null = null;
    if (manage && queue && !skipFullAvailability && !reconstruction.active && !turn?.pendingTie) {
      try {
        chain = automaticChain(ctx, raw.state!, raw.preferences, 6);
      } catch {
        chain = null;
      }
    }
    return {
      state: raw.state
        ? {
            ...raw.state,
            source: manage ? raw.state.source : undefined,
            tieResolutions: raw.state.tieResolutions?.map((r) => ({ ...r, actor: manage ? r.actor : undefined })),
          }
        : null,
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
              (raw.state.credits[turn.memberId] ?? 0) < 2 &&
              ctx.awards.filter((a) => a.member_id === turn.memberId).length +
                2 +
                (raw.state.credits[turn.memberId] ?? 0) <=
                entitlementFor(ctx, turn.memberId)
            ),
          }
        : null,
      preferences: raw.preferences.filter((p) => preferenceMemberIds.includes(p.member_id)),
      preferenceMemberIds,
      myMemberId: mine,
      canManage: manage,
      available,
      availabilityPending,
      availabilityReasons,
      availabilityWarnings,
      cycleAvailability,
      occupancyPolicyVersion: rules?.version ?? null,
      points,
      accounts,
      undo: history?.undo?.id ?? null,
      undoSummary: history?.undo ? undoSummary(history.undo) : null,
      redo: history?.redo?.id ?? null,
      pendingAutomatic,
      automaticAhead,
      listPlan,
      queue,
      chain,
      timeline,
      reconstruction,
    };
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
            args: [JSON.stringify(stamped), cid, JSON.stringify(raw.state)],
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
    const ops = cas(cid, c.version),
      snapshot = { format: ELECTION_UNDO_FORMAT, ...raw, awards: d.awards, requests: d.requests };
    let state = raw.state,
      preferences = raw.preferences,
      choices: any[] = [],
      recordUndo = true;
    const authorizeMember = (memberId: string) => {
      if (!d.members.some((m: any) => m.id === memberId)) throw new ApiError('Controlador ajeno al equipo');
      if (!manage && memberId !== mine)
        throw new ApiError('Solo puedes modificar tus propias preferencias o elegir en tu turno', 403);
    };
    try {
      if (action === 'preferences') {
        authorizeMember(body.memberId);
        if (!(await this.preferenceMemberIds(d, mine)).includes(body.memberId))
          throw new ApiError(
            'Las preferencias de un controlador con cuenta vinculada solo pueden modificarlas su titular o un superadministrador',
            403,
          );
        const dates = body.dates,
          validDates = new Set(resultDates(ctx));
        if (
          !Array.isArray(dates) ||
          dates.length > 100 ||
          dates.some((date) => typeof date !== 'string' || !validDates.has(date)) ||
          new Set(dates).size !== dates.length ||
          (body.persistent !== undefined && typeof body.persistent !== 'boolean')
        )
          throw new ApiError('Lista de preferencias no válida: usa ciclos del calendario, sin duplicados');
        // Older clients send no mode: their lists keep applying at once.
        const mode: PreferenceMode = body.mode ?? 'immediate',
          waitMinutes = mode === 'wait' ? body.waitMinutes : 0;
        if (
          !PREFERENCE_MODES.includes(mode) ||
          !Number.isInteger(waitMinutes) ||
          waitMinutes < 0 ||
          waitMinutes > MAX_WAIT_MINUTES ||
          (mode === 'wait' && waitMinutes < 1)
        )
          throw new ApiError('Indica un plazo de espera entre 1 minuto y 24 horas');
        const persistent = body.persistent === true,
          active = dates.length > 0;
        const labels = cleanLabels(body.labels, dates);
        if (!labels)
          throw new ApiError('Los nombres de los ciclos deben tener como mucho ' + MAX_LABEL_LENGTH + ' caracteres');
        const saved: Preference = {
          member_id: body.memberId,
          dates,
          automatic: true,
          persistent,
          active,
          mode,
          waitMinutes,
          labels,
        };
        preferences = [...preferences.filter((p) => p.member_id !== body.memberId), saved];
        ops.push({
          sql: `INSERT INTO preferences(${PREFERENCE_COLUMNS.join(',')}) VALUES(${PREFERENCE_COLUMNS.map(() => '?').join(',')}) ON CONFLICT(member_id) DO UPDATE SET dates_json=excluded.dates_json,automatic=excluded.automatic,persistent=excluded.persistent,active=excluded.active,mode=excluded.mode,wait_minutes=excluded.wait_minutes,labels_json=excluded.labels_json`,
          args: preferenceRow(saved, cid),
        });
      } else if (action === 'start') {
        if (!manage) throw new ApiError('Solo el responsable puede activar esta elección', 403);
        if (d.config.cyclesPerPerson < 1 || d.config.cyclesPerPerson > 6)
          throw new ApiError('La elección admite entre uno y seis ciclos por persona');
        if (state && (d.awards.length || state.tieResolutions?.length))
          throw new ApiError('No cambies el orden después de comenzar a elegir');
        if (body.rulesConfirmed !== true || typeof body.allowDeferral !== 'boolean')
          throw new ApiError('Confirma las reglas de elección');
        const scores = d.config.previousScores,
          source = d.config.previousScoresSource;
        if (!scores || d.members.some((m: any) => !Number.isFinite(scores[m.code])) || !d.members.length)
          throw new ApiError('Faltan puntuaciones anteriores: complétalas en Administración antes de activar');
        if (typeof source !== 'string' || source.trim().length < 10)
          throw new ApiError('Indica y guarda el origen de las puntuaciones anteriores');
        const order = [...d.members].sort((a: any, b: any) => scores[a.code] - scores[b.code]).map((m: any) => m.id);
        const groups = new Map<number, string[]>();
        for (const id of order) {
          const m = d.members.find((candidate: any) => candidate.id === id),
            score = scores[m.code];
          groups.set(score, [...(groups.get(score) ?? []), id]);
        }
        const tieGroups = [...groups.values()].filter((group) => group.length > 1);
        const rules = occupancyFor(ctx.year);
        if (rules) {
          const feasibility = rules.canComplete(rules.state(ctx, ctx.members, ctx.awards));
          if (feasibility.status !== 'possible')
            throw new ApiError(
              'La campaña no tiene completación validada conforme a ' +
                rules.authority +
                ': ' +
                (feasibility.reason ?? feasibility.status),
            );
        }
        state = {
          status: 'active',
          order,
          cursor: 0,
          credits: {},
          source: source.trim(),
          allowDeferral: body.allowDeferral,
          policyVersion: ELECTION_POLICY_VERSION,
          tieGroups,
          pendingTieGroups: structuredClone(tieGroups),
          tieResolutions: [],
          jointGroups: [],
          jointAgreements: [],
        };
        validateElectionState(state, d.members);
      } else if (action === 'resolve_tie') {
        if (!manage) throw new ApiError('Solo el responsable puede registrar el sorteo', 403);
        if (!state) throw new ApiError('No hay una elección configurada');
        const group =
          body.groupMemberIds === undefined
            ? currentTurn(ctx, state).pendingTie
            : Array.isArray(body.groupMemberIds)
              ? (state.pendingTieGroups ?? []).find(
                  (pending: string[]) =>
                    pending.length === body.groupMemberIds.length &&
                    pending.every((id) => body.groupMemberIds.includes(id)),
                )
              : undefined;
        if (!group) throw new ApiError('No hay un empate pendiente para el grupo indicado');
        if (!['random', 'external'].includes(body.method)) throw new ApiError('Método de sorteo no válido');
        state = resolveTie(
          ctx,
          state,
          body.method === 'random' ? drawTie(group) : body.order,
          body.method,
          this.actor.id!,
          new Date().toISOString(),
          body.groupMemberIds,
        );
        // The result must be visible and reviewable before an automatic choice uses it.
      } else if (action === 'register_joint' || action === 'cancel_joint') {
        if (!manage) throw new ApiError('Solo el responsable puede gestionar acuerdos de elección conjunta', 403);
        if (!state) throw new ApiError('No hay una elección activa');
        const at = new Date().toISOString();
        state =
          action === 'register_joint'
            ? registerJointAgreement(ctx, state, body.members, body.round, this.actor.id!, at)
            : cancelJointAgreement(ctx, state, body.members, body.round, this.actor.id!, at);
      } else if (action === 'choose' || action === 'choose_joint' || action === 'defer') {
        if (action === 'choose_joint') {
          if (!manage) throw new ApiError('El turno conjunto requiere la confirmación del responsable', 403);
        } else authorizeMember(body.memberId);
        if (!state) throw new ApiError('El administrador debe confirmar el orden de elección primero');
        if (action === 'choose') {
          if (!Array.isArray(body.dates) || body.dates.some((v: any) => typeof v !== 'string'))
            throw new ApiError('Selección no válida');
          const next = choose(ctx, state, body.memberId, body.dates);
          state = next.state;
          choices = next.choices;
        } else if (action === 'choose_joint') {
          const next = chooseJoint(ctx, state, body.entries);
          state = next.state;
          choices = next.choices;
        } else state = defer(ctx, state, body.memberId);
        if (action === 'choose' || action === 'choose_joint')
          preferences = consumePreferences(
            preferences,
            action === 'choose' ? [body.memberId] : body.entries.map((entry: any) => entry.member_id),
          );
      } else if (action === 'pause' || action === 'resume') {
        if (!manage) throw new ApiError('Solo el responsable puede pausar o reanudar la elección', 403);
        if (!state) throw new ApiError('No hay una elección configurada');
        state = { ...state, status: action === 'pause' ? 'paused' : 'active' };
      } else if (action === 'resume_automatic') {
        if (!manage) throw new ApiError('Solo el responsable del equipo puede reanudar los automatismos', 403);
        if (!state || state.status !== 'active' || !state.automaticPaused)
          throw new ApiError('No hay automatismos detenidos para reanudar');
        state = { ...state, automaticPaused: false };
      } else if (action === 'advance') {
        if (!state) throw new ApiError('No hay una elección configurada');
        // advanceAutomatic checks stored preferences and validates its chosen
        // cycles; do not perform an identical, expensive solver search beforehand.
        // Each successful advance still commits EXACTLY ONE undoable turn.
        const next = advanceAutomatic(ctx, state, preferences, 1, now);
        if (!next.choices.length) return { changed: false };
        state = next.state;
        preferences = next.preferences;
        choices = next.choices;
      } else if (action === 'link_account') {
        if (c.scope_key !== 'live') throw new ApiError('Vincula las cuentas desde una campaña real');
        if (!manage) throw new ApiError('Solo el responsable puede vincular cuentas', 403);
        authorizeMember(body.memberId);
        recordUndo = false;
        const member = d.members.find((m: any) => m.id === body.memberId),
          existing = (
            await this.repo.all('SELECT * FROM controller_accounts WHERE person_id=?', [member.person_id])
          )[0];
        if ((existing?.version ?? 0) !== body.accountVersion)
          throw new ApiError('La vinculación cambió. Recarga antes de guardar.', 409);
        const subject = String(body.subject ?? '').trim(),
          provider = body.provider ?? 'chatgpt';
        const email = subject.toLowerCase();
        const isEmail =
          provider === 'chatgpt' &&
          /^[^\s@:\x00-\x1f]+@[^\s@:\x00-\x1f]+\.[^\s@:\x00-\x1f]+$/.test(email) &&
          email.length <= 250;
        const isFirebaseUid =
          provider === 'firebase' && subject.length <= 250 && subject.length > 0 && !/[\s\r\n:]/.test(subject);
        if ((subject && !isEmail && !isFirebaseUid) || !['chatgpt', 'firebase'].includes(provider))
          throw new ApiError('Introduce un correo válido de ChatGPT Sites o un UID de Firebase');
        if (
          c.scope_key === 'live' &&
          this.actor.role !== 'superadmin' &&
          existing?.principal_key &&
          existing.principal_key !== (provider === 'chatgpt' ? 'chatgpt-email:' + email : 'firebase:' + subject)
        )
          throw new ApiError('Solo el superadministrador puede sustituir una cuenta ya vinculada', 403);
        if (subject)
          ops.push({
            sql: 'INSERT INTO controller_accounts(person_id,principal_key,version) VALUES(?,?,1) ON CONFLICT(person_id) DO UPDATE SET principal_key=excluded.principal_key,version=controller_accounts.version+1',
            args: [member.person_id, provider === 'chatgpt' ? 'chatgpt-email:' + email : 'firebase:' + subject],
          });
        else ops.push({ sql: 'DELETE FROM controller_accounts WHERE person_id=?', args: [member.person_id] });
      } else if (action === 'election_undo' || action === 'election_redo') {
        if (!manage) throw new ApiError('Solo el responsable del equipo puede deshacer o rehacer elecciones', 403);
        const history = await this.managerHistory(cid, d, mine);
        const entry = action === 'election_undo' ? history.undo : history.redo;
        const privateDenied =
          'Solo el titular o un superadministrador pueden restaurar preferencias de cuentas vinculadas';
        if (
          action === 'election_undo' &&
          entry?.id !== body.historyId &&
          history.done.some((e) => e.id === body.historyId && history.isPrivate(e))
        )
          throw new ApiError(privateDenied, 403);
        if (!entry || entry.id !== body.historyId)
          throw new ApiError('El cambio ya no está disponible para deshacer o rehacer', 409);
        const prior = JSON.parse(entry.before_json);
        // Restore the undone list edit itself and list flags (active) consumed by an
        // undone award; every other list keeps what its owner has saved since.
        const original = action === 'election_undo' ? entry : history.redoOriginal;
        const next = restoredPreferences(
          prior.preferences ?? [],
          preferences,
          original?.action === 'preferences' ? auditAfter(original)?.memberId : null,
        );
        // Linked accounts' private lists are protected.
        if (c.scope_key === 'live' && this.actor.role !== 'superadmin') {
          const linked = await this.repo.all(
            'SELECT m.id FROM campaign_members m JOIN controller_accounts a ON m.person_id=a.person_id WHERE m.campaign_id=?',
            [cid],
          );
          if (linked.some((m: any) => m.id !== mine && listContent(next, m.id) !== listContent(preferences, m.id)))
            throw new ApiError(privateDenied, 403);
        }
        state = prior.state;
        preferences = next;
        // Undo must leave the recovered turn editable, never automatically re-award it.
        // Redo restores the prior snapshot exactly (including the old pause state).
        if (action === 'election_undo' && state) state = { ...state, automaticPaused: true };
        ops.push(
          { sql: 'DELETE FROM awards WHERE campaign_id=?', args: [cid] },
          { sql: 'DELETE FROM requests WHERE campaign_id=?', args: [cid] },
          { sql: 'DELETE FROM preferences WHERE campaign_id=?', args: [cid] },
          ...insertRows(
            'awards',
            ['id', 'campaign_id', 'member_id', 'cycle_date', 'version'],
            prior.awards.map((a: any) => [a.id, cid, a.member_id, a.cycle_date, a.version]),
          ),
          ...insertRows(
            'requests',
            ['id', 'campaign_id', 'member_id', 'slot', 'cycle_date', 'version'],
            (prior.requests ?? d.requests).map((a: any) => [a.id, cid, a.member_id, a.slot, a.cycle_date, a.version]),
          ),
          ...insertRows(
            'preferences',
            PREFERENCE_COLUMNS,
            preferences.map((p) => preferenceRow(p, cid)),
          ),
        );
      } else throw new ApiError('Operación de elección no válida');
    } catch (e: any) {
      if (e.status) throw e;
      throw new ApiError(e.message);
    }
    // Save preference consumption atomically with awards, requests and cursor.
    if (!['election_undo', 'election_redo'].includes(action))
      for (const p of preferences) {
        const prior = raw.preferences.find((previous) => previous.member_id === p.member_id);
        if (prior && prior.active !== p.active)
          ops.push({
            sql: 'UPDATE preferences SET active=? WHERE member_id=? AND campaign_id=?',
            args: [p.active !== false ? 1 : 0, p.member_id, cid],
          });
      }
    // Undo and redo restore their snapshot exactly; undo also pauses automatic choices, and resuming restarts the clock.
    if (!['election_undo', 'election_redo'].includes(action))
      state = stampTurnAfter(
        ctx,
        state,
        choices,
        new Date(now).toISOString(),
        ['start', 'resume', 'resume_automatic'].includes(action),
      );
    ops.push(electionStateStatement(cid, state));
    ops.push(
      ...insertRows(
        'awards',
        ['id', 'campaign_id', 'member_id', 'cycle_date', 'version'],
        choices.map((a) => [crypto.randomUUID(), cid, a.member_id, a.cycle_date, 1]),
      ),
    );
    // Criterios 1.1 p.2: the original selection persists even if an award is
    // later changed. Existing imported requests for the same cycle are reused.
    const newRequests: any[][] = [],
      usedByMember = new Map<string, Set<number>>();
    for (const a of choices) {
      if (d.requests.some((r: any) => r.member_id === a.member_id && r.cycle_date === a.cycle_date)) continue;
      let used = usedByMember.get(a.member_id);
      if (!used) {
        used = new Set(d.requests.filter((r: any) => r.member_id === a.member_id).map((r: any) => r.slot));
        usedByMember.set(a.member_id, used);
      }
      const slot = Array.from({ length: ctx.config.cyclesPerPerson }, (_, i) => i + 1).find((n) => !used!.has(n));
      if (slot === undefined) throw new ApiError('No quedan posiciones para registrar la solicitud original');
      used.add(slot);
      newRequests.push([crypto.randomUUID(), cid, a.member_id, slot, a.cycle_date, 1]);
    }
    ops.push(
      ...insertRows('requests', ['id', 'campaign_id', 'member_id', 'slot', 'cycle_date', 'version'], newRequests),
    );
    // Snapshot the causal impact BEFORE committing the atomic batch. Undo/redo
    // retain the original immutable report in audit but the timeline replays only
    // currently effective decisions. An indeterminate solver proof stays explicit.
    const rules = occupancyFor(ctx.year);
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
        ...(action === 'election_undo'
          ? { undoTargetId: body.historyId }
          : action === 'election_redo'
            ? { redoTargetId: body.historyId }
            : {}),
        ...(action === 'resolve_tie' ? { resolution: state?.tieResolutions?.at(-1) } : {}),
        ...(['register_joint', 'cancel_joint'].includes(action)
          ? { joint: { round: body.round, members: body.members, actor: this.actor.id, at: new Date().toISOString() } }
          : {}),
      }),
    );
    await this.host.commit(ops);
    return { changed: true };
  }
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
function resultDates(ctx: ElectionContext) {
  return calculate(ctx.year, ctx.team, ctx.config, ctx.members, ctx.requests, ctx.awards).cycles.map((c) => c.date);
}
