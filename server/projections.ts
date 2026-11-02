import type { Config } from '../domain/calendar.ts';
import { effectiveScoringConfig } from '../domain/scoring.ts';
import type { Award, Member, Request, calculate } from '../domain/vacations.ts';
import type { ElectionService } from './election-service.ts';
import type { ElectionState, Preference, roundQueue, automaticChain } from '../domain/election.ts';
import type { AvailabilitySnapshot, PolicyPresentation } from '../domain/occupancy.ts';
import type { ElectionTimelineItem, PublicElectionTimelineItem } from './election-timeline.ts';
import type { ElectionTiming } from '../domain/turn-timing.ts';
import type { ReconstructionService } from './reconstruction.ts';

/** Database rows have additional columns: the administrative projection preserves them. */
export type CampaignRow = {
  id: string;
  year: number;
  team_id: string;
  status: string;
  version: number;
  data_kind: string;
  scope_key: string;
  simulation_name: string | null;
  published_run_id: string | null;
  created_at: string;
};
export type CampaignMemberRow = Member & {
  person_id: string;
  campaign_id: string;
  label: string;
  position: number;
  version: number;
};
export type RunRow = {
  id: string;
  campaign_id: string;
  source_version: number;
  engine_version: string;
  result_json: string;
  created_by: string;
  created_at: string;
};
export type RequestRow = Request & { campaign_id: string; version: number };
export type AwardRow = Award & { campaign_id: string; version: number };
export type LoadedCampaign = {
  campaign: CampaignRow;
  config: Config;
  members: CampaignMemberRow[];
  requests: RequestRow[];
  awards: AwardRow[];
  runs: RunRow[];
};
export type ElectionView = Awaited<ReturnType<ElectionService['view']>>;
export type VacationResult = ReturnType<typeof calculate>;
export type PublicVacationResult = VacationResult & { ordering: [] };
export type PublicCampaignMember = Pick<CampaignMemberRow, 'id' | 'code'>;

export type PublicCampaignView = {
  campaign: Pick<
    CampaignRow,
    'id' | 'year' | 'team_id' | 'status' | 'version' | 'data_kind' | 'scope_key' | 'simulation_name'
  >;
  members: PublicCampaignMember[];
  requests: [];
  awards: AwardRow[];
  result: PublicVacationResult;
  config: null;
  runs: [];
  election: ElectionView;
  participating: boolean;
  editable: false;
  preview: { code: string; writable: boolean } | undefined;
};

export type AdminCampaignView = Omit<LoadedCampaign, 'runs'> & {
  runs: (Omit<RunRow, 'result_json'> & { result_json: undefined })[];
  election: ElectionView;
  undo: { id: string; action: string } | null;
  redo: { id: string } | null;
  result: VacationResult;
  editable: true;
};

export type PublishedCampaignView = {
  campaign: Pick<CampaignRow, 'id' | 'year' | 'team_id'> & { status: 'published' };
  members: PublicCampaignMember[];
  awards: Award[];
  result: PublicVacationResult;
};

export type PublishedSnapshot = {
  members: PublicCampaignMember[];
  awards: Award[];
  result: VacationResult;
};

/** Keep the administrator's complete data, including future database columns. */
export function projectAdminCampaignView(
  data: LoadedCampaign,
  election: ElectionView,
  result: VacationResult,
  entry: { id: string; action: string } | null,
): AdminCampaignView {
  return {
    ...data,
    config: effectiveScoringConfig(data.campaign.year, data.config),
    election,
    undo: entry && entry.action !== 'undo_vacations' ? { id: entry.id, action: entry.action } : null,
    redo: entry?.action === 'undo_vacations' ? { id: entry.id } : null,
    result,
    runs: data.runs.map((r) => ({ ...r, result_json: undefined })),
    editable: true,
  };
}

/** Only explicitly selected campaign and controller fields cross the public boundary. */
export function projectPublicCampaignView(
  data: LoadedCampaign,
  cid: string,
  election: ElectionView,
  result: VacationResult,
  preview: { campaignId: string; code: string; writable: boolean } | undefined,
): PublicCampaignView {
  return {
    campaign: {
      id: cid,
      year: data.campaign.year,
      team_id: data.campaign.team_id,
      status: data.campaign.status,
      version: data.campaign.version,
      data_kind: data.campaign.data_kind,
      scope_key: data.campaign.scope_key,
      simulation_name: data.campaign.simulation_name,
    },
    members: data.members.map((m) => ({ id: m.id, code: m.code })),
    requests: [],
    awards: data.awards,
    result: { ...result, ordering: [] as [] },
    config: null,
    runs: [],
    election,
    participating: !!election.myMemberId,
    editable: false,
    preview: preview && preview.campaignId === cid ? { code: preview.code, writable: preview.writable } : undefined,
  };
}

/** The published snapshot intentionally omits ordering and all private member columns. */
export function projectPublishedCampaignView(
  data: LoadedCampaign,
  cid: string,
  snapshot: PublishedSnapshot,
): PublishedCampaignView {
  return {
    campaign: { id: cid, year: data.campaign.year, team_id: data.campaign.team_id, status: 'published' },
    members: snapshot.members.map((m) => ({ id: m.id, code: m.code })),
    awards: snapshot.awards,
    result: { ...snapshot.result, ordering: [] as [] },
  };
}

/**
 * All inputs are computed by ElectionService.view(). The projections are pure:
 * no repository reads, permissions checks, policy evaluation or clock access.
 * In particular, no incoming object is spread into a controller's response.
 */
export type EarlyView = {
  guaranteed: string[];
  indeterminate: boolean;
  round: number | null;
  owed: number;
  choices: { awardId: string; date: string; cancellable: boolean }[];
};
export type ElectionProjectionData = {
  state: ElectionState | null;
  turn: {
    memberId: string | null;
    needed: number;
    round: number;
    pendingTie: string[] | null;
    participants: string[];
    requiredByMember: Record<string, number>;
    canDefer: boolean;
  } | null;
  preferences: Preference[];
  preferenceMemberIds: string[];
  myMemberId: string | null;
  available: string[];
  availabilityPending: string[];
  availabilityReasons: Record<string, string>;
  availabilityWarnings: Record<string, unknown>;
  cycleAvailability: AvailabilitySnapshot | null;
  occupancyPolicyVersion: string | null;
  activationRulesName: string;
  /** The election order is the roster's (VA census), not last year's scores. */
  rosterOrder: boolean;
  policyPresentation: PolicyPresentation | null;
  points: { member_id: string; cycles: number; points: number }[];
  accounts: unknown[];
  undo: string | null;
  undoSummary: {
    action: string;
    memberId: string | null;
    at: string | null;
    choices: { memberId: string; date: string }[];
  } | null;
  redo: string | null;
  pendingAutomatic: boolean;
  turnsAhead: number | null;
  automaticAhead: number | null;
  /** The viewer's own early election: cycles proved safe now and early choices made. */
  early: EarlyView | null;
  listPlan: {
    memberId: string;
    mode: Preference['mode'];
    waitMinutes: number;
    deadline: string | null;
    paused: boolean;
    dates: string[] | null;
  } | null;
  queue: ReturnType<typeof roundQueue> | null;
  chain: ReturnType<typeof automaticChain> | null;
  timeline: ElectionTimelineItem[] | PublicElectionTimelineItem[];
  timing: ElectionTiming | null;
  myAccountVersion: number | null;
  reconstruction: Awaited<ReturnType<ReconstructionService['view']>>;
};

/** Copy only explicitly named, actually present optional properties. */
function own<T extends object, K extends keyof T>(source: T, keys: readonly K[]): Partial<Pick<T, K>> {
  const result: Partial<Pick<T, K>> = {};
  for (const key of keys) if (Object.hasOwn(source, key)) result[key] = source[key];
  return result;
}

/** A snapshot and policy presentation are engine outputs, not arbitrary database rows. */
function publicAvailability(value: AvailabilitySnapshot | null): AvailabilitySnapshot | null {
  if (!value) return null;
  return {
    policyVersion: value.policyVersion,
    status: value.status,
    checked: value.checked,
    ...own(value, ['stateKey']),
    cycles: Object.fromEntries(
      Object.entries(value.cycles).map(([date, cycle]) => [
        date,
        {
          cycle: cycle.cycle,
          period: cycle.period,
          occupied: cycle.occupied,
          localMaximum: cycle.localMaximum,
          status: cycle.status,
          additional: cycle.additional,
          provenAdditional: cycle.provenAdditional,
          possibleAdditionalUpperBound: cycle.possibleAdditionalUpperBound,
          slots: cycle.slots.map((slot) => ({
            position: slot.position,
            status: slot.status,
            ...own(slot, ['memberId']),
            reasons: slot.reasons.map((reason) => ({
              code: reason.code,
              message: reason.message,
              ...own(reason, ['period', 'cycle', 'actual', 'limit', 'certainty', 'evidence']),
            })),
          })),
        },
      ]),
    ),
  };
}

function publicPresentation(value: PolicyPresentation | null): PolicyPresentation | null {
  if (!value) return null;
  return {
    periodNames: [...value.periodNames],
    permits: Object.fromEntries(
      Object.entries(value.permits).map(([code, permit]) => [code, { name: permit.name, ...own(permit, ['suffix']) }]),
    ),
    impactEvents: Object.fromEntries(
      Object.entries(value.impactEvents).map(([code, event]) => [
        code,
        {
          ...own(event, ['highlight', 'cycles', 'line']),
          ...(Object.hasOwn(event, 'lineByPeriod')
            ? { lineByPeriod: event.lineByPeriod && { ...event.lineByPeriod } }
            : {}),
        },
      ]),
    ),
    staticReasons: [...value.staticReasons],
    ...own(value, ['ownRightsReason']),
    ...(value.units ? { units: { ...value.units } } : {}),
    explanationId: value.explanationId,
  };
}

function sharedElectionFields(data: ElectionProjectionData) {
  const editable = new Set(data.preferenceMemberIds);
  return {
    // Public by design: everyone sees how long each turn took.
    timing: data.timing && publicTiming(data.timing),
    myAccountVersion: data.myAccountVersion,
    turn: data.turn
      ? {
          memberId: data.turn.memberId,
          needed: data.turn.needed,
          round: data.turn.round,
          pendingTie: data.turn.pendingTie,
          participants: [...data.turn.participants],
          requiredByMember: { ...data.turn.requiredByMember },
          canDefer: data.turn.canDefer,
        }
      : null,
    preferences: data.preferences.filter((preference) => editable.has(preference.member_id)),
    preferenceMemberIds: data.preferenceMemberIds,
    myMemberId: data.myMemberId,
    available: data.available,
    availabilityPending: data.availabilityPending,
    availabilityReasons: data.availabilityReasons,
    availabilityWarnings: Object.fromEntries(
      Object.entries(data.availabilityWarnings).map(([date, warnings]) => [
        date,
        Array.isArray(warnings)
          ? warnings.map((warning) => ({
              code: warning.code,
              message: warning.message,
            }))
          : warnings,
      ]),
    ),
    cycleAvailability: publicAvailability(data.cycleAvailability),
    occupancyPolicyVersion: data.occupancyPolicyVersion,
    activationRulesName: data.activationRulesName,
    rosterOrder: data.rosterOrder,
    policyPresentation: publicPresentation(data.policyPresentation),
    points: data.points.map(({ member_id, cycles, points }) => ({ member_id, cycles, points })),
    pendingAutomatic: data.pendingAutomatic,
    turnsAhead: data.turnsAhead,
    automaticAhead: data.automaticAhead,
    early: data.early
      ? {
          guaranteed: [...data.early.guaranteed],
          indeterminate: data.early.indeterminate,
          round: data.early.round,
          owed: data.early.owed,
          choices: data.early.choices.map(({ awardId, date, cancellable }) => ({ awardId, date, cancellable })),
        }
      : null,
  };
}

/** Preserve every existing administrative field, including full audit data. */
export function projectElectionViewForManager(data: ElectionProjectionData) {
  return {
    state: data.state
      ? {
          ...data.state,
          source: data.state.source,
          tieResolutions: data.state.tieResolutions?.map((resolution) => ({
            ...resolution,
            actor: resolution.actor,
          })),
        }
      : null,
    ...sharedElectionFields(data),
    canManage: true as const,
    accounts: data.accounts,
    undo: data.undo,
    undoSummary: data.undoSummary,
    redo: data.redo,
    listPlan: data.listPlan,
    queue: data.queue,
    chain: data.chain,
    timeline: data.timeline,
    reconstruction: data.reconstruction,
  };
}

function publicTiming(timing: ElectionTiming): ElectionTiming {
  return {
    turns: timing.turns.map((t) => ({
      id: t.id,
      kind: t.kind,
      round: t.round,
      memberIds: [...t.memberIds],
      at: t.at,
      openedAt: t.openedAt,
      activeMs: t.activeMs,
    })),
    averages: timing.averages.map((a) => ({ memberId: a.memberId, turns: a.turns, meanMs: a.meanMs })),
    waiting: timing.waiting && { since: timing.waiting.since, activeMs: timing.waiting.activeMs },
  };
}

function publicState(state: ElectionState | null) {
  if (!state) return null;
  return {
    status: state.status,
    order: [...state.order],
    cursor: state.cursor,
    credits: { ...state.credits },
    allowDeferral: state.allowDeferral,
    ...own(state, ['automaticPaused', 'policyVersion']),
    ...(Object.hasOwn(state, 'tieGroups') ? { tieGroups: state.tieGroups?.map((group) => [...group]) } : {}),
    ...(Object.hasOwn(state, 'pendingTieGroups')
      ? { pendingTieGroups: state.pendingTieGroups?.map((group) => [...group]) }
      : {}),
    ...(Object.hasOwn(state, 'jointGroups') ? { jointGroups: state.jointGroups?.map((group) => [...group]) } : {}),
    ...(Object.hasOwn(state, 'jointAgreements')
      ? {
          jointAgreements: state.jointAgreements?.map((agreement) => ({
            round: agreement.round,
            members: [...agreement.members],
            actor: agreement.actor,
            at: agreement.at,
            ...own(agreement, ['cancelledBy', 'cancelledAt']),
          })),
        }
      : {}),
    ...(Object.hasOwn(state, 'turnSince')
      ? { turnSince: state.turnSince && { cursor: state.turnSince.cursor, at: state.turnSince.at } }
      : {}),
    // These keys existed on the old public response as explicitly undefined.
    source: undefined,
    tieResolutions: state.tieResolutions?.map((resolution) => ({
      order: [...resolution.order],
      method: resolution.method,
      at: resolution.at,
      actor: undefined,
      ...own(resolution, ['anticipated']),
    })),
  };
}

/**
 * Explicit allowlist for the controller and anonymous view. A newly added
 * ElectionState, Preference or timeline property is private until reviewed here.
 * Existing joint-agreement actors remain for wire compatibility with the old
 * response; restricting those would be a separate API behaviour change.
 */
export function projectElectionViewForController(data: ElectionProjectionData) {
  const common = sharedElectionFields(data);
  const visible = new Set(data.preferenceMemberIds);
  return {
    state: publicState(data.state),
    ...common,
    preferences: data.preferences
      .filter((preference) => visible.has(preference.member_id))
      .map((preference) => ({
        member_id: preference.member_id,
        dates: [...preference.dates],
        automatic: preference.automatic,
        ...own(preference, ['persistent', 'active', 'mode', 'waitMinutes']),
        ...(Object.hasOwn(preference, 'labels') ? { labels: preference.labels && { ...preference.labels } } : {}),
      })),
    canManage: false as const,
    accounts: [] as [],
    undo: null,
    undoSummary: null,
    redo: null,
    listPlan:
      data.listPlan && data.listPlan.memberId === data.myMemberId
        ? {
            memberId: data.listPlan.memberId,
            mode: data.listPlan.mode,
            waitMinutes: data.listPlan.waitMinutes,
            deadline: data.listPlan.deadline,
            paused: data.listPlan.paused,
            dates: data.listPlan.dates ? [...data.listPlan.dates] : null,
          }
        : null,
    queue: null,
    chain: null,
    timeline: (data.timeline as PublicElectionTimelineItem[]).map((item) => ({
      id: item.id,
      kind: item.kind,
      round: item.round,
      memberIds: [...item.memberIds],
      choices: item.choices.map(({ member_id, cycle_date }) => ({ member_id, cycle_date })),
      deferredTurns: item.deferredTurns,
      ...own(item, ['method', 'order', 'automatic', 'selectionCursor']),
      // Only the owner learns that a choice was made ahead of its turn.
      ...(item.anticipated && data.myMemberId && item.memberIds.includes(data.myMemberId)
        ? { anticipated: item.anticipated }
        : {}),
    })),
    reconstruction: { active: data.reconstruction.active },
  };
}

export type ElectionViewForManager = ReturnType<typeof projectElectionViewForManager>;
export type ElectionViewForController = ReturnType<typeof projectElectionViewForController>;
