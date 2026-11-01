import type { Repository, Statement } from './repository.ts';
import {
  CHOICE_ACTIONS,
  RESTORING_ACTIONS,
  decodeEvent,
  encodeEvent,
  isElectionUndo,
  isVacationsUndo,
  type AuditAction,
  type AuditEvent,
} from '../domain/events.ts';

// Logical journal boundary: callers receive complete event payloads following
// domain/events.ts, never physical compression envelopes. SQL payload predicates
// belong here and must be adapted here when the physical storage changes.
// JSON string fields remain a legacy logical interchange shape, not a promise
// about how documents will be stored. Materialize before privacy redaction.

export type AuditRow = {
  id: string;
  /** Available when callers SELECT *; compact event reads may omit it. */
  actor?: string | null;
  action: string;
  before_json: string | null;
  after_json: string | null;
  created_at: string;
};

// Parsed snapshots belong to the row objects of one read context. They are
// deliberately non-enumerable: serializing an audit row still returns its
// original persisted representation, never an extra copy of its private data.
function parsedRow(row: AuditRow): AuditRow {
  const result = { ...row };
  let before: any,
    after: any,
    hasBefore = false,
    hasAfter = false;
  Object.defineProperties(result, {
    parsedBefore: {
      get() {
        if (!hasBefore) {
          before = row.before_json ? JSON.parse(row.before_json) : null;
          hasBefore = true;
        }
        return before;
      },
    },
    parsedAfter: {
      get() {
        if (!hasAfter) {
          after = row.after_json ? JSON.parse(row.after_json) : null;
          hasAfter = true;
        }
        return after;
      },
    },
  });
  return result;
}
export function auditBefore(row: Pick<AuditRow, 'before_json'>): any {
  return Object.hasOwn(row, 'parsedBefore')
    ? (row as any).parsedBefore
    : row.before_json
      ? JSON.parse(row.before_json)
      : null;
}
export function auditAfter(row: Pick<AuditRow, 'after_json'>): any {
  return Object.hasOwn(row, 'parsedAfter')
    ? (row as any).parsedAfter
    : row.after_json
      ? JSON.parse(row.after_json)
      : null;
}

/** The row with its payloads as logical JSON text, whatever their stored format.
 * Redaction and generic decoders must work on this, never on stored columns. */
export function logicalRow<R extends Pick<AuditRow, 'before_json' | 'after_json'>>(row: R): R {
  const before = auditBefore(row),
    after = auditAfter(row);
  return {
    ...row,
    before_json: before === null ? null : JSON.stringify(before),
    after_json: after === null ? null : JSON.stringify(after),
  };
}

/** The canonical undo/redo replay, shared by history, reconstruction and timeline. */
export function appliedAudit(rows: any[]) {
  const done: any[] = [],
    redo: { original: any; undo: any; index: number }[] = [];
  const byId = new Map(rows.map((row) => [row.id, row]));
  let reconstructionOrigin: AuditRow[] | null = null;
  for (const row of rows) {
    if (row.action === 'election_undo') {
      // A manager's undo may skip newer private-list edits, so remove the entry it
      // targeted; rows without a recorded target always undid the newest entry.
      const target = auditAfter(row)?.undoTargetId,
        found = target ? done.findIndex((e) => e.id === target) : -1;
      const index = found >= 0 ? found : done.length - 1;
      if (index >= 0) redo.push({ original: done.splice(index, 1)[0], undo: row, index });
    } else if (row.action === 'election_redo') {
      const item = redo.pop();
      if (item) done.splice(Math.min(item.index, done.length), 0, item.original);
    } else if (row.action === 'reconstruction_start') {
      reconstructionOrigin = [...done];
      const after = auditAfter(row) ?? {},
        index = done.findIndex((e) => e.id === after.targetId);
      const keep = index >= 0 ? index : after.keepCount;
      if (Array.isArray(after.retainedIds)) {
        const retained = new Set(after.retainedIds);
        const removed = new Set(after.removedAwardIds ?? []);
        const effective = new Map(done.map((event) => [event.id, event]));
        const prefix = [...retained]
          .map((id) => effective.get(id) ?? byId.get(id))
          .filter(Boolean)
          .map((event) => {
            const before = auditBefore(event);
            if (!before?.awards?.some((award: { id: string }) => removed.has(award.id))) return event;
            // The raw predecessor snapshot may already contain a later early choice.
            // Its effective undo snapshot must not resurrect that removed suffix.
            return {
              ...event,
              before_json: JSON.stringify({
                ...before,
                awards: before.awards.filter((award: { id: string }) => !removed.has(award.id)),
                state: before.state
                  ? {
                      ...before.state,
                      earlyChoices: before.state.earlyChoices?.filter(
                        (choice: { awardId: string }) => !removed.has(choice.awardId),
                      ),
                    }
                  : before.state,
              }),
            };
          });
        done.splice(0, done.length, ...prefix);
      } else if (Number.isInteger(keep) && keep >= 0) done.splice(keep);
      redo.length = 0;
    } else if (row.action === 'reconstruction_back') {
      done.pop();
      redo.length = 0;
    } else if (row.action === 'reconstruction_cancel') {
      const after = auditAfter(row) ?? {};
      if (Array.isArray(after.restoreIds)) {
        const origin = new Map((reconstructionOrigin ?? []).map((event) => [event.id, event]));
        done.splice(
          0,
          done.length,
          ...after.restoreIds.map((id: string) => origin.get(id) ?? byId.get(id)).filter(Boolean),
        );
        redo.length = 0;
        continue;
      }
      const index = done.findIndex((e) => e.id === after.targetId);
      const keep = index >= 0 ? index : after.keepCount;
      if (Number.isInteger(keep) && keep >= 0) done.splice(keep);
      for (const id of after.originalIds ?? []) {
        const original = byId.get(id);
        if (original) done.push(original);
      }
      redo.length = 0;
    } else if (row.before_json && isElectionUndo(auditBefore(row))) {
      // Editing a list does not discard redo: undo and redo keep current lists.
      done.push(row);
      if (row.action !== 'preferences') redo.length = 0;
    } else if (row.action === 'resolve_tie') {
      redo.length = 0;
    }
  }
  return {
    done,
    undo: done.at(-1) ?? null,
    redo: redo.at(-1)?.undo ?? null,
    redoOriginal: redo.at(-1)?.original ?? null,
  };
}

/** One immutable read snapshot per Service.view, never a cross-request cache. */
export class AuditContext {
  private loaded?: Promise<AuditRow[]>;
  private replayed?: Promise<ReturnType<typeof appliedAudit>>;
  constructor(
    private repo: Repository,
    readonly campaignId: string,
    readonly version: number,
  ) {}
  rows(): Promise<AuditRow[]> {
    return (this.loaded ??= eventsFor(this.repo, this.campaignId).then((rows) => rows.map(parsedRow)));
  }
  replay(): Promise<ReturnType<typeof appliedAudit>> {
    return (this.replayed ??= this.rows().then(appliedAudit));
  }
}

const COLUMNS = 'id,action,before_json,after_json,created_at';

/** Every row of a campaign, in append order. */
export function eventsFor(repo: Repository, campaignId: string): Promise<AuditRow[]> {
  return repo.all<AuditRow>(`SELECT ${COLUMNS} FROM audit WHERE campaign_id=? ORDER BY rowid ASC`, [campaignId]);
}
/** Typed events of a campaign, in append order. */
export async function decodedEventsFor(repo: Repository, campaignId: string): Promise<AuditEvent[]> {
  return (await eventsFor(repo, campaignId)).map((row) => decodeEvent(logicalRow(row)));
}
export async function eventById(repo: Repository, campaignId: string, eventId: string): Promise<AuditRow | null> {
  return (
    (await repo.all<AuditRow>(`SELECT ${COLUMNS} FROM audit WHERE campaign_id=? AND id=?`, [campaignId, eventId]))[0] ??
    null
  );
}
/** The latest row of a campaign when it restores availability (undo, redo, back, cancel). */
export async function lastRestoring(repo: Repository, campaignId: string): Promise<AuditRow | null> {
  const latest = (
    await repo.all<AuditRow>(`SELECT ${COLUMNS} FROM audit WHERE campaign_id=? ORDER BY rowid DESC LIMIT 1`, [
      campaignId,
    ])
  )[0];
  return latest && (RESTORING_ACTIONS as readonly string[]).includes(latest.action) ? latest : null;
}
/** The vacation change whose undo snapshot yields campaign `version`. */
export async function lastUndoableVacation(repo: Repository, campaignId: string, version: number) {
  const entries = await repo.all<AuditRow>('SELECT * FROM audit WHERE campaign_id=? ORDER BY rowid DESC LIMIT 30', [
    campaignId,
  ]);
  return entries.find((e) => isVacationsUndo(auditBefore(e)) && auditAfter(e).version === version) ?? null;
}
/** Global administrative log for superadmins. */
export function recentAudit(limit = 100): Statement {
  return { sql: 'SELECT * FROM audit ORDER BY created_at DESC LIMIT ?', args: [limit] };
}
/** Recent automatic `advance` rows of a live campaign, with the turn cursor before each one. */
export function automaticAdvancesSince(repo: Repository, campaignId: string, since: string) {
  return repo.all<{ id: string; after_json: string; created_at: string; cursor: any; turns: any }>(
    `SELECT a.id,a.after_json,a.created_at,
    json_extract(a.before_json,'$.state.cursor') AS cursor,json_array_length(a.before_json,'$.state.order') AS turns
   FROM audit a JOIN campaigns c ON c.id=a.campaign_id
   WHERE a.campaign_id=? AND a.action='advance' AND c.scope_key='live' AND a.created_at>=?`,
    [campaignId, since],
  );
}
/** Whether any decision consuming options happened since `since`. */
export async function hasChoicesSince(repo: Repository, campaignId: string, since: string): Promise<boolean> {
  const rows = await repo.all(
    `SELECT id FROM audit WHERE campaign_id=? AND action IN (${CHOICE_ACTIONS.map((a) => `'${a}'`).join(',')}) AND created_at>=? LIMIT 1`,
    [campaignId, since],
  );
  return rows.length > 0;
}

export type AppendInput = {
  id: string;
  actor: string | null;
  action: AuditAction;
  teamId?: string | null;
  campaignId?: string | null;
  before: any;
  after: any;
  createdAt: string;
};
/** The only writer of audit rows. */
export function append(event: AppendInput): Statement {
  const stored = encodeEvent(event as any);
  return {
    sql: 'INSERT INTO audit(id,actor,action,team_id,campaign_id,before_json,after_json,created_at) VALUES(?,?,?,?,?,?,?,?)',
    args: [
      event.id,
      event.actor,
      stored.action,
      event.teamId ?? null,
      event.campaignId ?? null,
      stored.before_json,
      stored.after_json,
      event.createdAt,
    ],
  };
}
/** Appends only when the previous statement of the same batch changed exactly one row. */
export function appendIfChanged(event: AppendInput): Statement {
  const { sql, args } = append(event);
  return { sql: sql.replace(/ VALUES\((.*)\)$/, ' SELECT $1 WHERE changes()=1'), args };
}
/** SQL-only eligibility guard: never discard a session's sole surviving copy. */
export function originalEventCopiesMatchSQL(event: string): string {
  return `EXISTS (SELECT 1 FROM audit a WHERE a.id=json_extract(${event},'$.id')
    AND json_valid(a.before_json) AND json_valid(a.after_json)
    AND json_extract(a.before_json,'$.awards') IS json_extract(${event},'$.before.awards')
    AND json_extract(a.before_json,'$.requests') IS json_extract(${event},'$.before.requests')
    AND json_extract(a.before_json,'$.preferences') IS json_extract(${event},'$.before.preferences')
    AND json_extract(a.after_json,'$.impact') IS json_extract(${event},'$.after.impact'))`;
}

/** Maintenance metadata contains the confirmed plan, not historical snapshot data. */
export function maintenanceCleanupEvent(actor: string | null, plan: unknown, token: string): Statement {
  return {
    sql: "INSERT INTO audit(id,actor,action,before_json,after_json,created_at) VALUES(?,?,'maintenance_cleanup',NULL,?,?)",
    args: [crypto.randomUUID(), actor, JSON.stringify({ plan, token }), new Date().toISOString()],
  };
}

// Trusted SQL fragments for the read-only diagnostic capture; values remain bound.
export function diagnosticAuditSelect(projection: string, where: string): string {
  return `SELECT ${projection} FROM audit WHERE ${where}`;
}

export function deleteEventsFor(campaignId: string): Statement {
  return { sql: 'DELETE FROM audit WHERE campaign_id=?', args: [campaignId] };
}
