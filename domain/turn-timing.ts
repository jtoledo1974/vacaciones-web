/**
 * How long each turn took. Only the daytime counts: from 23:00 to 9:00
 * (Europe/Madrid, every day of the week) nobody is expected to choose.
 */
export const QUIET_FROM_HOUR = 23;
export const QUIET_TO_HOUR = 9;
const ZONE = 'Europe/Madrid';
const MAX_DAYS = 800;

const parts = new Intl.DateTimeFormat('en-GB', {
  timeZone: ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});
function local(ms: number) {
  const p = Object.fromEntries(parts.formatToParts(ms).map((x) => [x.type, Number(x.value)]));
  return { y: p.year, m: p.month, d: p.day, h: p.hour, mi: p.minute, s: p.second };
}
/** The instant at which the Madrid wall clock reads y-m-d h:00. */
function instant(y: number, m: number, d: number, h: number) {
  const wall = Date.UTC(y, m - 1, d, h);
  let guess = wall;
  for (let i = 0; i < 2; i++) {
    const l = local(guess);
    guess += wall - Date.UTC(l.y, l.m - 1, l.d, l.h, l.mi, l.s);
  }
  return guess;
}

/** Milliseconds between two instants, leaving out the nightly 23:00–9:00 in Madrid. */
export function activeMs(from: number, to: number): number {
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return 0;
  const start = local(from);
  let total = 0;
  for (let i = 0; i < MAX_DAYS; i++) {
    const open = instant(start.y, start.m, start.d + i, QUIET_TO_HOUR),
      close = instant(start.y, start.m, start.d + i, QUIET_FROM_HOUR);
    if (open >= to) break;
    total += Math.max(0, Math.min(close, to) - Math.max(open, from));
  }
  return total;
}

/** "45 min", "3 h 20 min", "26 h". */
export function formatActive(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'menos de 1 min';
  if (minutes < 60) return minutes + ' min';
  const hours = Math.floor(minutes / 60),
    rest = minutes % 60;
  return hours >= 10 || !rest ? hours + ' h' : hours + ' h ' + rest + ' min';
}

export type TimedTurn = {
  id: string;
  kind: 'choice' | 'defer';
  round: number | null;
  memberIds: string[];
  at: string;
  /** When the turn opened; null if unknown (imported or reconstructed history). */
  openedAt: string | null;
  activeMs: number | null;
};
export type ElectionTiming = {
  /** Oldest first. */
  turns: TimedTurn[];
  averages: { memberId: string; turns: number; meanMs: number }[];
  waiting: { since: string; activeMs: number } | null;
};

type Item = {
  id: string;
  kind: string;
  round: number | null;
  createdAt: string;
  memberIds: string[];
  anticipated?: boolean;
};

/**
 * Turns, in the order they closed, with the time each one stayed open. A turn opens
 * when the previous one closed or, if later, when the clock restarted (start, resume,
 * undo, redo). Every turn counts for the averages, whoever closed it.
 *
 * An early choice is a turn of zero wait: when its slot came it passed at once.
 * It sits at its slot in turn order (`items` arrive newest first, in turn order),
 * opened and closed when the previous turn closed, so neither its mark nor the
 * moment it was chosen shows (early choices are discreet), and it does not move
 * when the next turn opened.
 */
export function electionTiming(input: {
  items: Item[];
  clockRestarts: string[];
  untimed?: Set<string>;
  turnSince?: { at: string } | null;
  active: boolean;
  now: number;
}): ElectionTiming {
  const restarts = input.clockRestarts.map(Date.parse).filter(Number.isFinite);
  const closed = input.items
    .filter((i) => (i.kind === 'choice' || i.kind === 'defer') && !i.anticipated && i.createdAt)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  let previous: number | null = null;
  const turns: TimedTurn[] = closed.map((item) => {
    const at = Date.parse(item.createdAt);
    const restart = Math.max(-Infinity, ...restarts.filter((r) => r <= at));
    const opened = Math.max(previous ?? -Infinity, restart);
    previous = at;
    const known = Number.isFinite(opened) && !input.untimed?.has(item.id);
    return {
      id: item.id,
      kind: item.kind as TimedTurn['kind'],
      round: item.round,
      memberIds: [...item.memberIds],
      at: item.createdAt,
      openedAt: known ? new Date(opened).toISOString() : null,
      activeMs: known ? activeMs(opened, at) : null,
    };
  });
  // Each early choice follows the closed turn before it in turn order; closed turns keep closing order.
  const after = new Map<string | null, Item[]>();
  let before: string | null = null;
  for (const item of [...input.items].reverse()) {
    if (turns.some((t) => t.id === item.id)) before = item.id;
    else if (item.kind === 'choice' && item.anticipated && item.createdAt)
      after.set(before, [...(after.get(before) ?? []), item]);
  }
  const ordered: TimedTurn[] = [];
  const early = (key: string | null) => {
    for (const item of after.get(key) ?? []) {
      const at = ordered.at(-1)?.at ?? item.createdAt;
      ordered.push({
        id: item.id,
        kind: 'choice',
        round: item.round,
        memberIds: [...item.memberIds],
        at,
        openedAt: at,
        activeMs: 0,
      });
    }
  };
  early(null);
  for (const t of turns) {
    ordered.push(t);
    early(t.id);
  }
  const sums = new Map<string, { turns: number; total: number }>();
  for (const turn of ordered)
    if (turn.activeMs !== null)
      for (const id of turn.memberIds) {
        const s = sums.get(id) ?? { turns: 0, total: 0 };
        sums.set(id, { turns: s.turns + 1, total: s.total + turn.activeMs });
      }
  const since = input.active && input.turnSince?.at ? input.turnSince.at : null;
  return {
    turns: ordered,
    averages: [...sums].map(([memberId, s]) => ({ memberId, turns: s.turns, meanMs: Math.round(s.total / s.turns) })),
    waiting: since ? { since, activeMs: activeMs(Date.parse(since), input.now) } : null,
  };
}
