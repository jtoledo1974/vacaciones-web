/**
 * When a history entry happened, worded so it is never mistaken for a cycle
 * date: «18:57» today, «ayer 18:57», «J 18:57» within the week, and null
 * beyond it: older entries show only a clock icon whose tooltip gives the
 * full date (a relative «hace 380 días» says nothing a year later). Madrid days.
 */
const dayKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }),
  clock = new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit' }),
  weekday = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Madrid', weekday: 'short' }),
  full = new Intl.DateTimeFormat('es-ES', {
    timeZone: 'Europe/Madrid',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
const LETTER: Record<string, string> = { Mon: 'L', Tue: 'M', Wed: 'X', Thu: 'J', Fri: 'V', Sat: 'S', Sun: 'D' };

/** Whole Madrid calendar days between two instants. */
function daysBetween(at: Date, now: Date) {
  const day = (d: Date) => Date.parse(dayKey.format(d) + 'T00:00:00Z');
  return Math.round((day(now) - day(at)) / 86_400_000);
}

export function formatLogWhen(iso: string, now: number): string | null {
  const at = new Date(iso),
    days = daysBetween(at, new Date(now)),
    time = clock.format(at);
  if (days <= 0) return time;
  if (days === 1) return 'ayer ' + time;
  if (days < 7) return LETTER[weekday.format(at)] + ' ' + time;
  return null;
}

/** «jueves, 22 de octubre de 2026, 18:57», for the tooltip: old entries need the year. */
export const formatLogWhenFull = (iso: string) => full.format(new Date(iso));
