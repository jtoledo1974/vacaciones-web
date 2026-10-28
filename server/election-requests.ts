import { insertRows, type Statement } from './repository.ts';

type Award = { member_id: string; cycle_date: string };
type Request = Award & { id: string; slot: number; version?: number };
type RequestRow = Request & { version: number };

/** Open-election requests are a working projection, not the protected RRHH reference.
 * Keep effective selection order and stable row ids, discarding superseded choices.
 * Callers supply awards in selection order (the loader orders existing rows by slot).
 */
export function requestsForAwards(cid: string, awards: readonly Award[], previous: readonly Request[]): RequestRow[] {
  const slots = new Map<string, number>();
  return awards.map((award) => {
    const slot = (slots.get(award.member_id) ?? 0) + 1;
    slots.set(award.member_id, slot);
    const old = previous.find((r) => r.member_id === award.member_id && r.cycle_date === award.cycle_date);
    return {
      id: old?.id ?? crypto.randomUUID(),
      campaign_id: cid,
      member_id: award.member_id,
      slot,
      cycle_date: award.cycle_date,
      version: old ? (old.version ?? 1) + (old.slot === slot ? 0 : 1) : 1,
    };
  });
}

/** Replace only the affected members; other controllers' requests stay untouched. */
export function syncElectionRequests(
  cid: string,
  awards: readonly Award[],
  previous: readonly Request[],
  memberIds: readonly string[],
): Statement[] {
  const members = new Set(memberIds);
  const rows = requestsForAwards(
    cid,
    awards.filter((a) => members.has(a.member_id)),
    previous,
  );
  return [
    ...[...members].map((memberId) => ({
      sql: 'DELETE FROM requests WHERE campaign_id=? AND member_id=?',
      args: [cid, memberId],
    })),
    ...insertRows(
      'requests',
      ['id', 'campaign_id', 'member_id', 'slot', 'cycle_date', 'version'],
      rows.map((r) => [r.id, cid, r.member_id, r.slot, r.cycle_date, r.version]),
    ),
  ];
}
