import { auditAfter, auditBefore, type AuditRow } from './audit-context.ts';
import type { Statement } from './repository.ts';

/**
 * Early choices are discreet (domain/early-election.ts, concealPendingEarly): until the
 * turn reaches their slot nobody but their owner learns of them, administrators included.
 * What would tell is private to everybody else:
 * - the early award still waiting (`hidden`);
 * - one that went away unseen, withdrawn before its slot (a discreet `early_cancel`) or
 *   taken away by an undo or a rebuild (`withdrawnEarly` on `election_undo` and
 *   `reconstruction_start`), unless a redo or a cancelled rebuild brought it back (`live`);
 * - the audit rows that made or withdrew them, and the original request each one
 *   recorded (Criterios 1.1 p.2), never a request that existed before it;
 * - while it waits, the one-turn list it consumed (consumePreferences): shown as it was.
 */
export type Discretion = {
  /** Rows to leave out entirely. */
  row: (row: AuditRow) => boolean;
  /** Ids (awards, requests, rows) whose every copy must be left out. */
  ids: Set<string>;
  /** Members whose list a waiting early choice consumed, with the dates it had then. */
  consumed: Map<string, string>;
};

type Choice = { id?: string; member_id?: string; cycle_date?: string };
type Request = { id?: string; member_id?: string; cycle_date?: string };

function parse(row: AuditRow, side: 'before' | 'after') {
  try {
    return side === 'before' ? auditBefore(row) : auditAfter(row);
  } catch {
    return null;
  }
}
type After = ReturnType<typeof auditAfter>;
const isEarly = (row: AuditRow, after: After) =>
  row.action === 'early_choose' || (row.action === 'advance' && after?.early === true);
const ownerOf = (after: After): string | undefined => after?.memberId ?? after?.choices?.[0]?.member_id;

export function discretion(
  rows: readonly AuditRow[],
  hidden: ReadonlySet<string>,
  viewer: string | null,
  live: ReadonlySet<string>,
  /** Requests that may be copies of an early one: the current ones, or any in a snapshot. */
  requests: readonly Request[] = [],
): Discretion {
  const gone = new Set<string>();
  for (const row of rows) {
    const after = parse(row, 'after');
    if (row.action === 'early_cancel' && after?.discreet === true && typeof after.cancelled === 'string')
      gone.add(after.cancelled);
    if (['election_undo', 'reconstruction_start'].includes(row.action) && Array.isArray(after?.withdrawnEarly))
      for (const id of after.withdrawnEarly) if (typeof id === 'string') gone.add(id);
  }
  const awards = new Set(hidden);
  for (const id of gone) if (!live.has(id)) awards.add(id);
  const ids = new Set(awards);
  const consumed = new Map<string, string>();
  for (const row of rows) {
    const after = parse(row, 'after');
    if (row.action === 'early_cancel' && after?.discreet === true && ownerOf(after) !== viewer) {
      if (awards.has(after.cancelled)) ids.add(row.id);
      continue;
    }
    if (!isEarly(row, after) || ownerOf(after) === viewer) continue;
    const mine = ((after?.choices ?? []) as Choice[]).filter((c) => !!c?.id && awards.has(c.id));
    if (!mine.length) continue;
    ids.add(row.id);
    const snapshot = parse(row, 'before');
    const owner = ownerOf(after);
    const list = ((snapshot?.preferences ?? []) as ListLike[]).find((p) => p?.member_id === owner);
    if (owner && list && list.active !== false && !list.persistent && mine.some((c) => hidden.has(c.id!)))
      consumed.set(owner, datesKey(list));
    // The request recorded with it, not one that was already there.
    const before = new Set(((snapshot?.requests ?? []) as Request[]).map((r) => r?.id));
    for (const choice of mine)
      for (const r of requests)
        if (r?.id && !before.has(r.id) && r.member_id === choice.member_id && r.cycle_date === choice.cycle_date)
          ids.add(r.id);
  }
  return { row: (row) => ids.has(row.id), ids, consumed };
}

type ListLike = { member_id?: string; dates?: unknown; active?: boolean; persistent?: boolean };
const datesKey = (list: ListLike) => JSON.stringify(list.dates ?? []);

/**
 * Lists as they were before a waiting early choice consumed them, for display only: the
 * election itself keeps reading the stored ones. A list its owner changed since stays as is.
 */
export function unconsumed<P extends ListLike>(lists: readonly P[], consumed: ReadonlyMap<string, string>): P[] {
  if (!consumed.size) return [...lists];
  return lists.map((p) =>
    p?.member_id && p.active === false && consumed.get(p.member_id) === datesKey(p) ? { ...p, active: true } : p,
  );
}

/** Every request copied in the snapshots of `rows`, to look for early ones among them. */
export function snapshotRequests(rows: readonly AuditRow[]): Request[] {
  const found: Request[] = [];
  for (const row of rows)
    for (const side of ['before', 'after'] as const) {
      const value = parse(row, side);
      const requests = value?.requests ?? value?.origin?.requests;
      if (Array.isArray(requests)) found.push(...requests);
    }
  return found;
}

/**
 * A copy of a snapshot (audit before/after, a reconstruction origin) without anything
 * that names one of `ids`: list items that are one of them, or whose `id` or `awardId` is, go, wherever
 * they are nested (awards, requests, early-choice entries, choices, copied audit events).
 */
export function redactDiscreet<T>(
  value: T,
  ids: ReadonlySet<string>,
  consumed: ReadonlyMap<string, string> = new Map(),
): T {
  if (!ids.size && !consumed.size) return value;
  const named = (item: unknown) =>
    !!item &&
    typeof item === 'object' &&
    (ids.has((item as { id?: string }).id ?? '') || ids.has((item as { awardId?: string }).awardId ?? ''));
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node))
      return node.filter((item) => !named(item) && !(typeof item === 'string' && ids.has(item))).map(walk);
    if (node && typeof node === 'object')
      return Object.fromEntries(
        Object.entries(node).flatMap(([key, item]) => {
          const kept = key === 'preferences' && Array.isArray(item) ? walk(unconsumed(item, consumed)) : walk(item);
          // An undo that only took discreet choices away says nothing about them.
          return key === 'withdrawnEarly' && Array.isArray(kept) && !kept.length ? [] : [[key, kept]];
        }),
      );
    return node;
  };
  return walk(value) as T;
}

/**
 * Tell an early choice's owner that it was taken away unseen, by an undo or a rebuild.
 * withdrawn:<campaign>:<member>:<award>, read by server/notifications.ts.
 */
export function withdrawnNotice(
  cid: string,
  early: { memberId: string; awardId: string; round: number },
  at: string,
): Statement {
  return {
    sql: `INSERT OR IGNORE INTO turn_notifications(id,owner_key,campaign_id,member_id,round,created_at)
     SELECT ?,ca.principal_key,?,m.id,?,? FROM campaign_members m JOIN controller_accounts ca ON ca.person_id=m.person_id WHERE m.id=? AND EXISTS(SELECT 1 FROM campaigns c WHERE c.id=m.campaign_id AND c.scope_key='live')`,
    args: [['withdrawn:' + cid, early.memberId, early.awardId].join(':'), cid, early.round, at, early.memberId],
  };
}
