'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { AvailabilitySnapshot } from '../domain/occupancy';
import { cycleAvailability, slotExplanation } from './cycle-availability-ui';

type Cycle = {
  date: string;
  end: string;
  score: number;
  period: number;
  occupied: number;
  max: number;
  available?: boolean;
};
type Award = { id: string; member_id: string; cycle_date: string };
type Member = { id: string; code: string };

type Props = {
  year: number;
  /** The campaign has an occupancy engine: show proven availability per slot. */
  ruled: boolean;
  cycles: Cycle[];
  awards: Award[];
  members: Member[];
  selected: string[];
  highlighted: string[];
  preferenceMode: boolean;
  busy: boolean;
  onSelect: (cycle: Cycle) => void;
  availability?: AvailabilitySnapshot | null;
  notForMe?: string[];
  /** Cycles the viewer may take now, ahead of their turn (proved safe by the server). */
  secured?: string[];
  mine?: string[];
  /** The viewer's preference list in order, edited or only shown. */
  preferences?: string[];
  /** Code of the member the marks belong to, when it is not the viewer. */
  ownerCode?: string;
  /** Single-day units (VA): one row per day, no points. */
  daily?: boolean;
};

function shortDate(iso: string): string {
  return new Date(iso + 'T12:00:00Z')
    .toLocaleDateString('es-ES', { day: 'numeric', month: 'short' })
    .replaceAll('.', '')
    .replaceAll(' ', '-');
}

export default function CycleTable({
  year,
  ruled,
  cycles,
  awards,
  members,
  selected,
  highlighted,
  preferenceMode,
  busy,
  onSelect,
  availability,
  notForMe,
  secured,
  mine = [],
  preferences = [],
  ownerCode,
  daily = false,
}: Props) {
  const blocked = new Set(notForMe ?? []),
    safe = new Set(secured ?? []);
  const [fontSize, setFontSize] = useState(12);
  // On desktop the table follows the page scroll (sticky header) only while it fits its
  // column: a wider one (narrow window, many places, long codes) keeps its own scroll box.
  const scrollRef = useRef<HTMLDivElement>(null),
    tableRef = useRef<HTMLTableElement>(null);
  const [fits, setFits] = useState(false);
  useEffect(() => {
    const box = scrollRef.current,
      table = tableRef.current;
    if (!box || !table || typeof ResizeObserver === 'undefined') return;
    // Against the wrapper, not the box: the box's own border and scrollbar gutter change with the mode.
    const column = box.parentElement ?? box;
    const measure = () => setFits(table.offsetWidth + 2 <= column.clientWidth);
    const observer = new ResizeObserver(measure);
    observer.observe(column);
    observer.observe(table);
    measure();
    return () => observer.disconnect();
  }, []);
  const codes = useMemo(() => new Map(members.map((m) => [m.id, m.code])), [members]);
  const occupants = useMemo(() => {
    const result = new Map<string, string[]>();
    for (const a of awards)
      result.set(a.cycle_date, [...(result.get(a.cycle_date) ?? []), codes.get(a.member_id) ?? '?']);
    return result;
  }, [awards, codes]);
  // Ordinary cycles keep at least four columns; VA days show exactly their places.
  const columns = Math.max(daily ? 1 : 4, ...cycles.map((c) => Math.max(c.max, c.occupied)));
  const chosen = new Set(selected),
    marked = new Set(highlighted),
    owned = new Set(mine);
  const styles = { '--vac3-font-size': fontSize + 'px' } as CSSProperties;
  return (
    <div className={'vac3' + (ruled ? ' vac3-ruled' : '')} style={styles}>
      <div className="vac3-tools">
        <span>
          <strong>{cycles.length}</strong> {daily ? 'días' : 'ciclos · 8 días por ciclo'} · 1º eligió antes
        </span>
        <span className="vac3-size-actions">
          <button
            type="button"
            onClick={() => setFontSize((x) => Math.max(12, x - 1))}
            disabled={fontSize <= 12}
            aria-label="Reducir letra de la tabla"
          >
            A−
          </button>
          <button
            type="button"
            onClick={() => setFontSize((x) => Math.min(16, x + 1))}
            disabled={fontSize >= 16}
            aria-label="Ampliar letra de la tabla"
          >
            A+
          </button>
        </span>
      </div>
      <div
        ref={scrollRef}
        className={'vac3-scroll' + (fits ? ' vac3-fits' : '')}
        role="region"
        tabIndex={0}
        aria-label={
          'Tabla de ' +
          (daily ? 'días' : 'ciclos') +
          ' de vacaciones; desplaza para consultar todas las filas y columnas'
        }
      >
        <table ref={tableRef} className="vac3-table">
          <caption className="vac3-sr">
            {daily
              ? 'Cada día y controladores en orden de elección (primera plaza: primera elección)'
              : 'Baremo, inicio de cada ciclo y controladores en orden de elección (primera plaza: primera elección)'}
          </caption>
          <thead>
            <tr>
              {!daily && (
                <th scope="col" className="vac3-points">
                  Pts
                </th>
              )}
              <th scope="col" className="vac3-date">
                {daily ? 'Día' : 'Ciclo'}
              </th>
              {Array.from({ length: columns }, (_, i) => (
                <th scope="col" className="vac3-slot" key={i}>
                  {i + 1}º
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {cycles.map((c) => {
              const people = occupants.get(c.date) ?? [],
                selectedIndex = selected.indexOf(c.date),
                rank = preferences.indexOf(c.date) + 1;
              const free = Math.max(0, c.max - c.occupied),
                extra = free === 0 && c.available === true;
              const status = cycleAvailability(c, availability, ruled);
              const label =
                shortDate(c.date) +
                (daily ? ', ' : ' a ' + shortDate(c.end) + ', ' + c.score + ' puntos, ') +
                c.occupied +
                ' plazas ocupadas, ' +
                status.description +
                (safe.has(c.date) ? ', asegurado para ti' : '') +
                (owned.has(c.date) ? ', adjudicado a ' + (ownerCode ?? 'ti') : '') +
                (rank ? (ownerCode ? ', preferencia de ' + ownerCode + ' ' : ', tu preferencia ') + rank : '') +
                (extra && !ruled ? ', posible cupo adicional' : '') +
                (people.length ? ', ' + people.join(', ') : '');
              return (
                <tr
                  key={c.date}
                  className={
                    (c.period === 1 ? 'vac3-summer ' : '') +
                    (blocked.has(c.date) ? 'vac3-not-for-me ' : '') +
                    (safe.has(c.date) ? 'vac3-secured ' : '') +
                    (chosen.has(c.date) ? 'vac3-selected ' : '') +
                    (marked.has(c.date) ? 'vac3-highlight ' : '') +
                    (owned.has(c.date) ? 'vac3-mine ' : '')
                  }
                  onClick={() => {
                    if (!busy) onSelect(c);
                  }}
                  data-cycle-date={c.date}
                >
                  {!daily && <td className="vac3-points">{c.score}</td>}
                  <td className="vac3-date">
                    <button
                      type="button"
                      data-cycle-date={c.date}
                      aria-label={label}
                      aria-pressed={chosen.has(c.date)}
                      disabled={busy}
                      title={label}
                      onClick={(event) => {
                        event.stopPropagation();
                        onSelect(c);
                      }}
                    >
                      <time dateTime={c.date}>{shortDate(c.date)}</time>
                      {safe.has(c.date) && (
                        <span className="vac3-secured-badge" aria-label="Asegurado para ti" title="Asegurado para ti">
                          ★
                        </span>
                      )}
                      {owned.has(c.date) && (
                        <span
                          className="vac2-mine-badge"
                          aria-hidden="true"
                          title={'Adjudicado a ' + (ownerCode ?? 'ti')}
                        >
                          ✓
                        </span>
                      )}
                      {rank > 0 && (
                        <span
                          className="vac2-rank-chip"
                          aria-hidden="true"
                          title={(ownerCode ? 'Preferencia de ' + ownerCode + ' ' : 'Tu preferencia ') + rank}
                        >
                          P{rank}
                        </span>
                      )}
                      {!preferenceMode && selectedIndex !== -1 && (
                        <span className="vac3-choice-indicator" aria-label={'Seleccionado ' + (selectedIndex + 1)}>
                          ●
                        </span>
                      )}
                    </button>
                  </td>
                  {Array.from({ length: columns }, (_, i) => {
                    const occupant = people[i],
                      slot = status.data?.slots[i];
                    // A day has exactly its places: a column past them does not exist, it is not unknown.
                    const beyond = daily && !!status.data && !slot;
                    const disabled = ruled ? beyond || slot?.status === 'blocked' : i >= c.max;
                    const unknown = ruled && !beyond && (!slot || slot.status === 'indeterminate');
                    const occupied = Boolean(occupant);
                    const add = !ruled && disabled && i === c.max && extra;
                    const cellTitle = occupant
                      ? 'Ocupado por ' + occupant
                      : beyond
                        ? 'Sin plaza ese día'
                        : ruled
                          ? slotExplanation(slot)
                          : add
                            ? 'Cupo adicional potencial, sujeto a confirmación'
                            : disabled
                              ? 'Cupo no autorizado'
                              : 'Cupo libre';
                    return (
                      <td
                        key={i}
                        className={
                          'vac3-slot' +
                          (disabled ? ' vac3-disabled' : '') +
                          (unknown ? ' vac3-unknown' : '') +
                          (occupied ? ' vac3-occupied' : '')
                        }
                        title={cellTitle}
                        aria-label={i + 1 + 'ª plaza: ' + cellTitle}
                      >
                        <span className="vac3-slot-code">
                          {occupant ?? (unknown ? '?' : add ? '+?' : disabled ? '×' : '')}
                        </span>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!ruled && (
        <div className="vac3-legend">
          <span>× No autorizado · +? Cupo adicional posible</span>
        </div>
      )}
    </div>
  );
}
