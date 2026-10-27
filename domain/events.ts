/**
 * Written schema of the `audit` table, the event store of a campaign.
 *
 * The stored representation never changes: old backups must keep restoring.
 * Each payload names its `format`; payloads written before formats existed
 * carry none and are read as version 1 of their event.
 */

/** Undo snapshot of an election decision (`before_json`). */
export const ELECTION_UNDO_FORMAT = 'election-undo-v1';
/** Undo snapshot of a manual vacation change (`before_json`). */
export const VACATIONS_UNDO_FORMAT = 'vacations-undo-v1';
/** Compact certified availability inside impact payloads. */
export const AVAILABILITY_FORMAT = 'availability-c1';

export const ELECTION_ACTIONS = [
  'preferences',
  'start',
  'resolve_tie',
  'register_joint',
  'cancel_joint',
  'choose',
  'choose_joint',
  'defer',
  'pause',
  'resume',
  'resume_automatic',
  'advance',
  'link_account',
  'election_undo',
  'election_redo',
  'early_choose',
  'early_cancel',
] as const;
export const RECONSTRUCTION_ACTIONS = [
  'reconstruction_start',
  'reconstruction_step',
  'reconstruction_back',
  'reconstruction_cancel',
  'reconstruction_finish',
] as const;
/** Manual vacation changes that record a `vacations-undo-v1` snapshot. */
export const VACATION_UNDO_ACTIONS = [
  'request',
  'award',
  'delete_request',
  'delete_award',
  'reset_vacations',
  'undo_vacations',
  'redo_vacations',
] as const;
export const CAMPAIGN_ACTIONS = [
  'config',
  'member',
  'bulk_members',
  'import_roster',
  'retire_member',
  'transfer_member',
  'transfer_received',
  'calculate',
  'publish',
  'close',
  'reopen',
  'create_campaign',
  'simulation_created',
  'simulation_deleted',
  'hr_names',
  'hr_export',
] as const;
export const ADMIN_ACTIONS = [
  'cli_authorized',
  'cli_authorization_rejected',
  'initialize_demo',
  'permissions',
  'delete_permissions',
  'restore',
  'local_admin_login',
  'local_admin_logout',
  'hr_template',
] as const;

export type ElectionAction = (typeof ELECTION_ACTIONS)[number];
export type ReconstructionAction = (typeof RECONSTRUCTION_ACTIONS)[number];
export type VacationUndoAction = (typeof VACATION_UNDO_ACTIONS)[number];
export type CampaignAction = (typeof CAMPAIGN_ACTIONS)[number];
export type AdminAction = (typeof ADMIN_ACTIONS)[number];
export type AuditAction = ElectionAction | ReconstructionAction | VacationUndoAction | CampaignAction | AdminAction;

/** Actions whose latest row may restore a previously certified availability. */
export const RESTORING_ACTIONS = [
  'election_undo',
  'election_redo',
  'undo_vacations',
  'redo_vacations',
  'reconstruction_back',
  'reconstruction_cancel',
] as const satisfies readonly AuditAction[];
/** Actions that may consume a controller's options. */
export const CHOICE_ACTIONS = [
  'choose',
  'choose_joint',
  'advance',
  'reconstruction_step',
  'early_choose',
] as const satisfies readonly AuditAction[];

type Payload = Record<string, any>;
export type ElectionUndoSnapshot = Payload & { format: typeof ELECTION_UNDO_FORMAT };
export type VacationsUndoSnapshot = Payload & { format: typeof VACATIONS_UNDO_FORMAT };

/** After payload of an election decision. */
export type ElectionDecision = Payload & {
  version: number;
  choices: any[];
  memberId?: string | null;
  impact?: Payload | null;
  warnings?: { code: string; message: string; period?: number }[];
  undoTargetId?: string;
  redoTargetId?: string;
  resolution?: unknown;
};
export type ReconstructionStep = Payload & {
  version: number;
  choices: any[];
  kind: string;
  usedId?: string | null;
  impact?: Payload | null;
};
export type ReconstructionMarker = Payload & {
  targetId?: string;
  keepCount?: number;
  originalIds?: string[];
  /** Logical reconstruction may retain predecessors recorded after an early choice. */
  retainedIds?: string[];
  restoreIds?: string[];
  removedAwardIds?: string[];
  version?: number;
  recordedAvailability?: unknown;
};

type Event<A extends string, B, P> = {
  id: string;
  action: A;
  createdAt: string;
  /** Payload format; absent in old rows, which read as version 1. */
  format: string;
  before: B;
  after: P;
};

export type AuditEvent =
  | Event<ElectionAction, ElectionUndoSnapshot | null, ElectionDecision>
  | Event<'reconstruction_step', ElectionUndoSnapshot, ReconstructionStep>
  | Event<Exclude<ReconstructionAction, 'reconstruction_step'>, null, ReconstructionMarker>
  | Event<VacationUndoAction, VacationsUndoSnapshot | null, Payload>
  | Event<CampaignAction | AdminAction, Payload | null, Payload>;

/** Reading form of a stored row (columns as persisted). */
export type StoredEvent = {
  id: string;
  action: string;
  before_json: string | null;
  after_json: string | null;
  created_at: string;
};

const known = new Set<string>([
  ...ELECTION_ACTIONS,
  ...RECONSTRUCTION_ACTIONS,
  ...VACATION_UNDO_ACTIONS,
  ...CAMPAIGN_ACTIONS,
  ...ADMIN_ACTIONS,
]);
export function isAuditAction(action: string): action is AuditAction {
  return known.has(action);
}

/** `<action>-v1` for payloads without a declared format. */
export function eventFormat(action: string, before: any, after: any): string {
  return (
    (typeof before?.format === 'string' && before.format) ||
    (typeof after?.format === 'string' && after.format) ||
    action + '-v1'
  );
}

/** Decode a stored row; unknown actions and old rows without format are accepted. */
export function decodeEvent(row: StoredEvent): AuditEvent {
  const before = row.before_json ? JSON.parse(row.before_json) : null,
    after = row.after_json ? JSON.parse(row.after_json) : null;
  return {
    id: row.id,
    action: row.action as AuditAction,
    createdAt: row.created_at,
    format: eventFormat(row.action, before, after),
    before,
    after,
  } as AuditEvent;
}

/** Encode an event to its stored columns, byte-compatible with existing rows. */
export function encodeEvent(event: Pick<AuditEvent, 'action' | 'before' | 'after'>): {
  action: string;
  before_json: string | null;
  after_json: string;
} {
  return {
    action: event.action,
    before_json: event.before === null ? null : JSON.stringify(event.before),
    after_json: JSON.stringify(event.after),
  };
}

export function isElectionUndo(before: any): before is ElectionUndoSnapshot {
  return before?.format === ELECTION_UNDO_FORMAT;
}
export function isVacationsUndo(before: any): before is VacationsUndoSnapshot {
  return before?.format === VACATIONS_UNDO_FORMAT;
}
