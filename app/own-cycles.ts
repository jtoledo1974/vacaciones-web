import { visiblePreferenceDates } from '../domain/election.ts';
import type { AvailabilitySnapshot } from '../domain/occupancy.ts';
import { cycleAvailability } from './cycle-availability-ui.ts';

type Cycle = { date: string; occupied: number; max: number; available?: boolean };

/** One person's awarded cycles and saved preference order: whose marks the calendar shows. */
export function ownCycles(
  memberId: string | null | undefined,
  awards: { member_id: string; cycle_date: string; simulated?: boolean }[],
  preferences: { member_id: string; dates: string[] }[] | undefined,
) {
  if (!memberId) return { owner: undefined, mine: [], preferences: [] };
  return {
    owner: memberId,
    mine: awards.filter((a) => a.member_id === memberId && !a.simulated).map((a) => a.cycle_date),
    preferences: preferences?.find((p) => p.member_id === memberId)?.dates ?? [],
  };
}

/**
 * Whose marks and locked days the calendar shows: whoever a VA turn being chosen belongs to
 * (an administrator may be acting for someone else), else the list edited, else the viewer.
 */
export function calendarOwner(c: {
  daily: boolean;
  choosing: boolean;
  participants?: string[];
  jointTarget?: string;
  editedList?: string | null;
  mine?: string | null;
}) {
  if (c.daily && c.choosing && c.participants?.length) {
    return c.jointTarget && c.participants.includes(c.jointTarget) ? c.jointTarget : c.participants[0];
  }
  return c.editedList ?? c.mine;
}

export type DaysOff = { ordinary: string[]; rest: string[] };
export type LockedDay = 'va' | 'ordinary' | 'rest';
export const lockedDayLabel: Record<LockedDay, string> = {
  va: 'VA ya adjudicada',
  ordinary: 'Vacaciones ordinarias',
  rest: 'Libre por turnero',
};

/** VA days the person cannot choose, and why; a day that is both reads as the vacation it is. */
export function lockedDays(mine: Iterable<string>, daysOff: DaysOff | undefined) {
  const locked = new Map<string, LockedDay>();
  for (const date of daysOff?.rest ?? []) locked.set(date, 'rest');
  for (const date of daysOff?.ordinary ?? []) locked.set(date, 'ordinary');
  if (daysOff) for (const date of mine) locked.set(date, 'va');
  return locked;
}

/** Seats left in words, from the same availability the calendar shows. */
export function seatsLeft(
  cycle: { date: string; occupied: number; max: number; available?: boolean },
  snapshot: AvailabilitySnapshot | null | undefined,
  ruled: boolean,
): string {
  const label = cycleAvailability(cycle, snapshot, ruled).label;
  // Without an engine a full cycle may still admit an authorised extra seat, as the map says.
  if (!ruled && label === '0' && cycle.available === true) return 'cupo adicional posible';
  if (label === '?') return 'plazas por confirmar';
  if (label === '—') return 'requiere revisión';
  return label === '1' ? 'queda 1 plaza' : `quedan ${label} plazas`;
}

export type PreferenceSplit = {
  /** Preferences that can still be awarded, in order: what P1, P2… number. */
  active: string[];
  owned: Set<string>;
  /** No seat left: proven by the occupancy engine when the campaign has one, else the local quota. */
  full: Set<string>;
  /** Still in the list but not proven either way; the server re-checks when the list is applied. */
  unknown: Set<string>;
};

/** Splits a preference list with the same availability the calendar shows, so both agree on every cycle. */
export function splitPreferences(
  dates: string[],
  owned: Iterable<string>,
  cycles: Cycle[],
  snapshot: AvailabilitySnapshot | null | undefined,
  ruled: boolean,
): PreferenceSplit {
  const own = new Set(owned),
    split: PreferenceSplit = { active: [], owned: new Set(), full: new Set(), unknown: new Set() };
  for (const date of dates) {
    if (own.has(date)) {
      split.owned.add(date);
      continue;
    }
    if (!ruled) {
      if (visiblePreferenceDates([date], cycles).length) split.active.push(date);
      else split.full.add(date);
      continue;
    }
    const data = snapshot?.cycles?.[date];
    if (
      (data?.status === 'exact' && data.additional === 0) ||
      (data?.status === 'indeterminate' && data.possibleAdditionalUpperBound === 0)
    )
      split.full.add(date);
    else {
      if (!data || data.status !== 'exact') split.unknown.add(date);
      split.active.push(date);
    }
  }
  return split;
}
