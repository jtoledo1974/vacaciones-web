'use client';
import { useEffect, useState } from 'react';
import { activeMs, formatActive } from '../domain/turn-timing';

/** «esperando desde hace 2 h», refreshed every minute, nights left out. */
const when = new Intl.DateTimeFormat('es-ES', {
  timeZone: 'Europe/Madrid',
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});
/** «jue, 22 oct, 18:57» in Madrid time. */
export const formatWhen = (iso: string) => when.format(new Date(iso));

/** The current time, refreshed every minute; null until mounted (no clock during render). */
export function useMinuteClock() {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0),
      timer = setInterval(tick, 60_000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, []);
  return now;
}

export default function WaitingSince({ since, prefix = 'esperando desde hace ' }: { since: string; prefix?: string }) {
  const now = useMinuteClock();
  if (now === null) return null;
  return (
    <span title="Sin contar de 23:00 a 9:00">
      {prefix}
      {formatActive(activeMs(Date.parse(since), now))}
    </span>
  );
}
