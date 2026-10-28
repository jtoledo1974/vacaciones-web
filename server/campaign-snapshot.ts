/**
 * The restorable state of a campaign: awards, requests, preferences and the
 * election state. Undo, redo, reconstruction, reset and import all rewrite it
 * through these statements, so a new column is added in one place.
 *
 * Stored snapshots keep their written shape (see `domain/events.ts`):
 * `election-undo-v1` holds everything at the top level; `vacations-undo-v1`
 * holds awards and requests, plus `election` with state and preferences.
 */
import {
  PREFERENCE_COLUMNS,
  preferenceRow,
  upgradeElectionState,
  withLiveEarlyChoices,
  type ElectionState,
  type Preference,
} from '../domain/election.ts';
import {
  ELECTION_UNDO_FORMAT,
  VACATIONS_UNDO_FORMAT,
  type ElectionUndoSnapshot,
  type VacationsUndoSnapshot,
} from '../domain/events.ts';
import { insertRows, type Statement } from './repository.ts';

export const AWARD_COLUMNS = [
  'id',
  'campaign_id',
  'member_id',
  'cycle_date',
  'version',
  'selection_index',
  'selection_round',
];
export const REQUEST_COLUMNS = ['id', 'campaign_id', 'member_id', 'slot', 'cycle_date', 'version'];

type AwardRow = {
  id: string;
  member_id: string;
  cycle_date: string;
  version: number;
  selection_index?: number | null;
  selection_round?: number | null;
};
type RequestRow = AwardRow & { slot: number };
type StoredSnapshot = {
  format?: string;
  awards?: unknown;
  requests?: unknown;
  preferences?: unknown;
  state?: unknown;
  election?: { preferences?: unknown; state?: unknown };
};
/** What to rewrite. An omitted part is left as it is in the database. */
export type CampaignSnapshot = {
  awards?: AwardRow[];
  requests?: RequestRow[];
  preferences?: Preference[];
  state?: ElectionState | null;
};
type Election = { state: ElectionState | null; preferences: Preference[] };
/** A captured snapshot: every part present. */
export type CapturedSnapshot = ElectionUndoSnapshot & Election & { awards: AwardRow[]; requests: RequestRow[] };

export function electionStateStatement(cid: string, state: ElectionState | null): Statement {
  return state
    ? {
        sql: 'INSERT INTO election_states(campaign_id,json) VALUES(?,?) ON CONFLICT(campaign_id) DO UPDATE SET json=excluded.json',
        args: [cid, JSON.stringify(upgradeElectionState(state))],
      }
    : { sql: 'DELETE FROM election_states WHERE campaign_id=?', args: [cid] };
}

/** Election undo snapshot of the loaded campaign `d` and its election. */
export function capture(d: { awards: AwardRow[]; requests: RequestRow[] }, election: Election): CapturedSnapshot {
  return {
    format: ELECTION_UNDO_FORMAT,
    state: structuredClone(election.state),
    preferences: structuredClone(election.preferences),
    awards: structuredClone(d.awards),
    requests: structuredClone(d.requests),
  };
}

/** Vacations undo snapshot, byte-compatible with the rows already stored. */
export function captureVacations(
  d: { awards: AwardRow[]; requests: RequestRow[] },
  election: Election,
): VacationsUndoSnapshot {
  return { format: VACATIONS_UNDO_FORMAT, requests: d.requests, awards: d.awards, election };
}

const isText = (v: unknown) => typeof v === 'string' && v !== '';
const isAward = (value: unknown): value is AwardRow => {
  const a = value as AwardRow | null;
  return (
    !!a &&
    isText(a.id) &&
    isText(a.member_id) &&
    isText(a.cycle_date) &&
    Number.isInteger(a.version) &&
    ((a.selection_index == null && a.selection_round == null) ||
      (Number.isSafeInteger(a.selection_index) &&
        a.selection_index! > 0 &&
        Number.isSafeInteger(a.selection_round) &&
        a.selection_round! > 0))
  );
};
const isRequest = (r: unknown): r is RequestRow => isAward(r) && Number.isInteger((r as RequestRow).slot);
const isPreference = (value: unknown): value is Preference => {
  const p = value as Preference | null;
  return !!p && isText(p.member_id) && Array.isArray(p.dates);
};
const rowsOk = <T>(items: unknown, check: (item: unknown) => item is T): items is T[] | undefined =>
  items === undefined || (Array.isArray(items) && items.every(check));

/**
 * Read a stored snapshot into its restorable parts, or null if it cannot be
 * restored. `format` names the payload when old rows carry none.
 *
 * It checks the shape every restored row needs (ids, dates, versions, slots)
 * and that the state is an object; the election rules validate the state's
 * content when it is next read.
 */
export function validateSnapshot(
  value: unknown,
  format: string | undefined = (value as StoredSnapshot | null)?.format,
): (CampaignSnapshot & { awards: AwardRow[]; preferences?: Preference[]; state?: ElectionState | null }) | null {
  const before = value as StoredSnapshot | null;
  if (!before || typeof before !== 'object' || !Array.isArray(before.awards)) return null;
  if (!rowsOk(before.awards, isAward) || !rowsOk(before.requests, isRequest)) return null;
  const stateOk = (state: unknown) =>
    state === undefined || state === null || (typeof state === 'object' && !Array.isArray(state));
  const restoredState = (state: unknown, awards: { id: string }[]): ElectionState | null => {
    const upgraded = upgradeElectionState(state);
    return upgraded ? withLiveEarlyChoices(upgraded, awards) : null;
  };
  if (format === ELECTION_UNDO_FORMAT) {
    if (!rowsOk(before.preferences, isPreference) || !stateOk(before.state)) return null;
    return {
      awards: before.awards,
      // Election snapshots predating requests leave them as they are.
      ...(before.requests ? { requests: before.requests } : {}),
      preferences: before.preferences ?? [],
      state: restoredState(before.state, before.awards),
    };
  }
  if (format === VACATIONS_UNDO_FORMAT) {
    if (!Array.isArray(before.requests)) return null;
    const election = before.election;
    if (election && (!Array.isArray(election.preferences) || !rowsOk(election.preferences, isPreference))) return null;
    if (election && !stateOk(election.state)) return null;
    return {
      awards: before.awards,
      requests: before.requests,
      ...(election
        ? { preferences: election.preferences as Preference[], state: restoredState(election.state, before.awards) }
        : {}),
    };
  }
  return null;
}

/** Statements that leave campaign `cid` exactly as `s`, part by part. */
export function restoreStatements(cid: string, s: CampaignSnapshot): Statement[] {
  const ops: Statement[] = [];
  if (s.awards) ops.push({ sql: 'DELETE FROM awards WHERE campaign_id=?', args: [cid] });
  if (s.requests) ops.push({ sql: 'DELETE FROM requests WHERE campaign_id=?', args: [cid] });
  if (s.preferences) ops.push({ sql: 'DELETE FROM preferences WHERE campaign_id=?', args: [cid] });
  if (s.awards)
    ops.push(
      ...insertRows(
        'awards',
        AWARD_COLUMNS,
        s.awards.map((a) => [
          a.id,
          cid,
          a.member_id,
          a.cycle_date,
          a.version,
          a.selection_index ?? null,
          a.selection_round ?? null,
        ]),
      ),
    );
  if (s.requests)
    ops.push(
      ...insertRows(
        'requests',
        REQUEST_COLUMNS,
        s.requests.map((r) => [r.id, cid, r.member_id, r.slot, r.cycle_date, r.version]),
      ),
    );
  if (s.preferences)
    ops.push(
      ...insertRows(
        'preferences',
        PREFERENCE_COLUMNS,
        s.preferences.map((p) => preferenceRow(p, cid)),
      ),
    );
  if (s.state !== undefined)
    ops.push(
      electionStateStatement(
        cid,
        s.state && s.awards ? withLiveEarlyChoices(upgradeElectionState(s.state)!, s.awards) : s.state,
      ),
    );
  return ops;
}
