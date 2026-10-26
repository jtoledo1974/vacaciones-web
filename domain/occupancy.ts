import type { Config } from './calendar.ts';
import type { Member, Award } from './vacations.ts';

/**
 * Contract between generic election code and a year's proof-based occupancy
 * engine. Types only: an engine implements `OccupancyRules`, generic code
 * depends on this module and never on a year's implementation.
 */

/** Preverano, verano, posverano. */
export type Period = 0 | 1 | 2;
export type PolicyCycle = { date: string; period: Period; fourthExcluded?: boolean; maximum?: number };
export type PolicyMember = { id: string; entitlement: number };
export type PolicyAward = { member_id: string; cycle_date: string };
/** summerTotal: HR fixes the summer allocation (two per CTA, "Info.Cupos RRHH");
 * the rest of the year receives the remainder. Absent only in synthetic fixtures. */
export type PolicyState = {
  cycles: PolicyCycle[];
  members: PolicyMember[];
  awards: PolicyAward[];
  summerTotal?: number;
};
export type RuleProblem = {
  code: string;
  message: string;
  period?: Period;
  cycle?: string;
  actual?: number;
  limit?: number;
  /** 'proven' holds in every admissible completion; never set from one witness. */
  certainty?: 'proven' | 'indeterminate';
  evidence?: string;
};
export type FinalAssessment = { valid: boolean; issues: RuleProblem[]; warnings: RuleProblem[] };
export type Completion = {
  status: 'possible' | 'impossible' | 'indeterminate';
  witness?: PolicyAward[];
  checked: number;
  reason?: string;
};
export type CandidateAssessment = {
  allowed: boolean;
  completion: Completion;
  issues: RuleProblem[];
  warnings: RuleProblem[];
};
/** Extra-quota and fourth-place permits a state still needs, per period. */
export type PermitCount = { period: Period; kind: 'extras' | 'fourths'; used: number | null; limit: number };

export type AvailabilitySlot = {
  position: number;
  status: 'occupied' | 'available' | 'blocked' | 'indeterminate';
  memberId?: string;
  reasons: RuleProblem[];
};
export type CycleAvailability = {
  cycle: string;
  period: Period;
  occupied: number;
  localMaximum: number;
  status: 'exact' | 'indeterminate' | 'invalid';
  additional: number | null;
  provenAdditional: number;
  possibleAdditionalUpperBound: number;
  slots: AvailabilitySlot[];
};
export type AvailabilitySnapshot = {
  policyVersion: string;
  status: 'exact' | 'indeterminate' | 'invalid';
  cycles: Record<string, CycleAvailability>;
  checked: number;
  /** Fingerprint of the exact state proved (policy, calendar, roster with
   * entitlements, awards). A recorded snapshot is reused only on a match. */
  stateKey?: string;
};
/**
 * Audit form of a snapshot. Occupants are implied by the awards of the state
 * being restored; each reason is stored once and referenced by index.
 */
export type CompactAvailabilitySnapshot = {
  format: 'availability-c1';
  policyVersion: string;
  status: AvailabilitySnapshot['status'];
  checked: number;
  stateKey?: string;
  /** A reason referenced as n omits its own cycle and period; as "kn" it is stored whole. */
  reasons: Partial<RuleProblem>[];
  /** [cycle, period, occupied, localMaximum, status, additional, lower, upper, slots]
   * with slots as "o"|"a"|"b"|"i" followed by reason indices. */
  cycles: [
    string,
    Period,
    number,
    number,
    CycleAvailability['status'],
    number | null,
    number,
    number,
    (string | number)[][],
  ][];
};
export type AvailabilityChange = {
  cycle: string;
  period: Period;
  kind: 'directOccupancy' | 'globalConstraint';
  before: { occupied: number; additional: number | null; lower: number; upper: number };
  after: { occupied: number; additional: number | null; lower: number; upper: number };
  delta: number | null;
  reasons: RuleProblem[];
};
export type ImpactEvent = {
  code: string;
  period?: Period;
  actual?: number;
  limit?: number;
  cycles: string[];
};
export type AvailabilityImpact = {
  policyVersion: string;
  status: 'exact' | 'indeterminate' | 'invalid';
  before: AvailabilitySnapshot;
  after: AvailabilitySnapshot;
  changes: AvailabilityChange[];
  events: ImpactEvent[];
};
export type PreviewChoiceImpact = {
  policyVersion: string;
  allowed: boolean;
  completionStatus: Completion['status'];
  issues: RuleProblem[];
  warnings: RuleProblem[];
  impact: AvailabilityImpact | null;
};

/** Search budget of one evaluation. Omitted: the engine's own default. */
export type CheckOptions = { maxChecks?: number };
/** exact: prove the precise final occupation rather than accept a cached certificate family. */
export type CompletionOptions = CheckOptions & { exact?: boolean };
export type AvailabilityOptions = CompletionOptions & { useCache?: boolean };
export type CandidateOptions = CompletionOptions & {
  /** A known completion of the prior state, repaired instead of solving again. */
  witness?: PolicyAward[];
  /** Informative warnings; admission only needs issues. Default true. */
  warnings?: boolean;
};

/**
 * Search budgets in completion checks, by purpose. Generic code asks for a
 * purpose; the engine, which knows what a check costs, sets the number.
 */
export type Budgets = {
  /** Proving one decision before it is stored: a choice, a joint batch, an administrative change. */
  commit: number;
  /** Listing what one controller may choose: a total shared by every cycle and a cap per cycle. */
  options: { total: number; perCandidate: number };
  /** Warnings of the current partial allocation. */
  review: number;
};

/** The campaign facts every year's rules are evaluated against. */
export type PolicyCampaign = { year: number; team: string; config: Config };

/**
 * A proof-based occupancy engine: it certifies that the team can still
 * complete every entitlement. Years without one keep the legacy relation
 * quotas computed by `calculate`.
 */
export type OccupancyRules = {
  /** Stored with results and journals; a change invalidates earlier reviews. */
  version: string;
  /** Human-readable authority, for error messages ("RRHH 2027"). */
  authority: string;
  /** Human-readable name of the rule set ("normas 2027"). */
  name: string;
  budgets: Budgets;
  state(
    campaign: PolicyCampaign,
    members: Member[],
    awards: readonly Pick<Award, 'member_id' | 'cycle_date'>[],
  ): PolicyState;
  /** Hard per-cycle maximum before any global proof. */
  cycleMaximum(campaign: PolicyCampaign, date: string): number;
  /** An atomic batch of choices on the same prior state. */
  evaluateCandidate(state: PolicyState, choices: PolicyAward[], options?: CandidateOptions): CandidateAssessment;
  /** A complete allocation. */
  evaluateFinal(state: PolicyState): FinalAssessment;
  /** Whether every entitlement can still be completed; a bounded search ends 'indeterminate'. */
  canComplete(state: PolicyState, options?: CompletionOptions): Completion;
  /** Violations visible without any completion search. */
  immediateIssues(state: PolicyState, choices: PolicyAward[]): RuleProblem[];
  /** The current partial allocation, cached so one decision pays for its warnings once. */
  partialAssessment(state: PolicyState, options?: CheckOptions): CandidateAssessment;
  availability(state: PolicyState, options?: AvailabilityOptions): AvailabilitySnapshot;
  /** A stored snapshot, only when it proves this exact state. */
  recordedAvailability(
    state: PolicyState,
    stored: AvailabilitySnapshot | CompactAvailabilitySnapshot | null | undefined,
  ): AvailabilitySnapshot | null;
  /** Availability without search, after undo/redo. */
  restoredAvailability(state: PolicyState): AvailabilitySnapshot;
  impact(before: PolicyState, after: PolicyState, options?: AvailabilityOptions): AvailabilityImpact;
  previewChoiceImpact(state: PolicyState, choices: PolicyAward[], options?: AvailabilityOptions): PreviewChoiceImpact;
  /** Permits every legal completion still consumes, for the personal simulator. */
  permitReport(state: PolicyState, options?: CheckOptions): PermitCount[];
  /** The audit form of a snapshot. */
  compact(snapshot: AvailabilitySnapshot): CompactAvailabilitySnapshot;
};
