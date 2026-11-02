'use client';
import { useEffect, useMemo, useState } from 'react';
import CycleTable from './cycle-table';
import { AvailabilityScale, MonthNavigation } from './calendar-controls';
import { orderMemberAwards, orderMemberIds, type CycleOrder, type MemberOrder } from '../domain/member-display-order';
import type { AvailabilitySnapshot } from '../domain/occupancy';
import { splitPreferences } from './own-cycles';
import { cycleAvailability, cycleOccupancyLabel } from './cycle-availability-ui';

export const formatDate = (date: string) =>
  new Date(date + 'T12:00:00Z').toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
/** A unit's first and last day; one date for single days (VA). */
export const formatSpan = (date: string, end: string) =>
  date === end ? formatDate(date) : formatDate(date) + ' – ' + formatDate(end);
const months = [
  'Enero',
  'Febrero',
  'Marzo',
  'Abril',
  'Mayo',
  'Junio',
  'Julio',
  'Agosto',
  'Septiembre',
  'Octubre',
  'Noviembre',
  'Diciembre',
];
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
type View = 'map' | 'calendar' | 'members' | 'table';
type Props = {
  year: number;
  ruled: boolean;
  cycles: Cycle[];
  selected: string[];
  onSelect: (cycle: Cycle) => void;
  preferenceMode?: boolean;
  busy?: boolean;
  highlighted?: string[];
  awards?: Award[];
  members?: Member[];
  order?: string[];
  points?: { member_id: string; points: number; cycles: number }[];
  availability?: AvailabilitySnapshot | null;
  notForMe?: string[];
  /** Cycles the viewer may take now, ahead of their turn (proved safe by the server). */
  secured?: string[];
  glossary?: boolean;
  /** Member whose marks are shown (see `ownCycles`): the viewer, or whoever's list is being edited. */
  owner?: string;
  /** That member's code, when it is not the viewer: marks then name them instead of saying «Tuyo». */
  ownerCode?: string;
  /** Cycles already awarded to the owner: marked in every view and mode. */
  mine?: string[];
  /** The owner's saved preference list, in order; outside preference mode it is shown, not edited. */
  preferences?: string[];
};

/** The viewer's own marks, identical in every view so «mine» and «my order» read the same everywhere. */
function OwnMarks({ owned, rank, who }: { owned: boolean; rank: number; who?: string }) {
  if (!owned && rank < 1) return null;
  return (
    <span className="vac2-own-marks">
      {owned && (
        <span className="vac2-mine-badge" title={who ? 'Adjudicado a ' + who : 'Adjudicado a ti'}>
          ✓ {who ?? 'Tuyo'}
        </span>
      )}
      {rank > 0 && (
        <span className="vac2-rank-chip" title={(who ? 'Preferencia de ' + who + ' ' : 'Tu preferencia ') + rank}>
          P{rank}
        </span>
      )}
    </span>
  );
}

function rememberView(next: View) {
  try {
    document.cookie = 'vacaciones_cycle_view=' + encodeURIComponent(next) + '; Max-Age=31536000; Path=/; SameSite=Lax';
    localStorage.setItem('vacaciones_cycle_view', next);
  } catch {
    /* La vista funciona sin cookies. */
  }
}
function slots(c: Cycle) {
  return Math.max(0, c.max - c.occupied);
}
function extraAvailable(c: Cycle) {
  return slots(c) === 0 && c.available === true;
}
function isSummer(c: Cycle) {
  return c.period === 1;
}
function monthIndex(date: string) {
  return Number(date.slice(5, 7)) - 1;
}
function cycleTitle(c: Cycle, ruled: boolean, availability?: AvailabilitySnapshot | null) {
  const status = cycleAvailability(c, availability, ruled);
  return formatSpan(c.date, c.end) + (c.date === c.end ? '' : ' · ' + c.score + ' puntos') + ' · ' + status.description;
}

export default function CycleCalendar({
  year,
  ruled,
  cycles,
  selected,
  onSelect,
  preferenceMode = false,
  busy = false,
  highlighted = [],
  awards = [],
  members = [],
  order = [],
  points = [],
  availability,
  notForMe,
  secured,
  glossary = false,
  owner,
  ownerCode,
  mine: mineDates = [],
  preferences = [],
}: Props) {
  // On one's own turn, cycles one cannot take are marked up front rather than discovered by tapping.
  const blocked = new Set(notForMe ?? []),
    safe = new Set(secured ?? []),
    owned = new Set(mineDates);
  // In preference mode the selection is the list being edited; otherwise the saved list is shown read-only.
  // Pn counts only usable preferences, as the editor numbers them; owned or full ones are skipped.
  const ranked = splitPreferences(preferenceMode ? selected : preferences, owned, cycles, availability, ruled).active;
  const rankOf = (date: string) => ranked.indexOf(date) + 1;
  const ownLabel = (date: string) =>
    (owned.has(date) ? (ownerCode ? ' · adjudicado a ' + ownerCode : ' · adjudicado a ti') : '') +
    (rankOf(date) ? (ownerCode ? ' · preferencia de ' + ownerCode + ' ' : ' · tu preferencia ') + rankOf(date) : '');
  // Single-day units (VA) have no cycle map: their days read best on the month grids.
  const daily = cycles.length > 0 && cycles.every((c) => c.date === c.end),
    unit = daily ? 'día' : 'ciclo';
  const [view, setView] = useState<View>(daily ? 'calendar' : 'map');
  useEffect(() => {
    try {
      const stored = document.cookie
        .split('; ')
        .find((part) => part.startsWith('vacaciones_cycle_view='))
        ?.split('=')
        .slice(1)
        .join('=');
      const choice = stored ? decodeURIComponent(stored) : localStorage.getItem('vacaciones_cycle_view');
      if (choice === 'table' || (choice === 'map' && !daily) || choice === 'calendar' || choice === 'members')
        setView(choice);
    } catch {
      /* La vista sigue disponible si el navegador bloquea el almacenamiento. */
    }
  }, []);
  function changeView(next: View) {
    setView(next);
    rememberView(next);
  }
  /** Only shows the cycle on the map: onSelect would add or remove it from a list being edited. */
  function showCycle(date: string) {
    if (daily) return changeView('calendar');
    changeView('map');
    requestAnimationFrame(() => {
      const card = document.querySelector<HTMLElement>('.vac2-map [data-cycle-date="' + date + '"]');
      card?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      card?.focus({ preventScroll: true });
    });
  }
  function prefChips() {
    return (
      <span className="vac2-own-marks">
        {ranked.map((date, i) => {
          const c = cycles.find((x) => x.date === date);
          return (
            <button type="button" className="vac2-pref-link" key={date} onClick={() => showCycle(date)} disabled={!c}>
              <span className="vac2-rank-chip">P{i + 1}</span> {formatDate(date)}
            </button>
          );
        })}
      </span>
    );
  }
  const [activeMonth, setActiveMonth] = useState(0);
  const [memberOrder, setMemberOrder] = useState<MemberOrder>('request');
  const [cycleOrder, setCycleOrder] = useState<CycleOrder>('request');
  const byDate = useMemo(() => new Map(cycles.map((c) => [c.date, c])), [cycles]);
  const byId = useMemo(() => new Map(members.map((m) => [m.id, m.code])), [members]);
  const holders = useMemo(() => {
    const out = new Map<string, string[]>();
    for (const a of awards) {
      const names = out.get(a.cycle_date) ?? [];
      names.push(byId.get(a.member_id) ?? '?');
      out.set(a.cycle_date, names);
    }
    return out;
  }, [awards, byId]);
  const membersOrder = useMemo(() => {
    const ids = [...order, ...members.map((m) => m.id)];
    return [...new Set(ids)].filter((id) => byId.has(id));
  }, [order, members, byId]);
  const memberPoints = useMemo(() => {
    const totals = new Map<string, number>();
    for (const award of awards)
      totals.set(award.member_id, (totals.get(award.member_id) ?? 0) + (byDate.get(award.cycle_date)?.score ?? 0));
    for (const p of points) totals.set(p.member_id, p.points);
    return totals;
  }, [awards, byDate, points]);
  const displayedMembers = useMemo(
    () => orderMemberIds(membersOrder, memberPoints, memberOrder),
    [membersOrder, memberPoints, memberOrder],
  );
  const memberEntries = (id: string): Cycle[] =>
    orderMemberAwards(
      awards.filter((a) => a.member_id === id),
      cycleOrder,
    )
      .map((a) => byDate.get(a.cycle_date))
      .filter((c): c is Cycle => !!c);
  const byMonth = useMemo(() => months.map((_, m) => cycles.filter((c) => monthIndex(c.date) === m)), [cycles]);
  const monthDates = useMemo(
    () =>
      months.map((_, m) => {
        const result: (Cycle | null)[] = [];
        const offset = (new Date(Date.UTC(year, m, 1)).getUTCDay() + 6) % 7;
        for (let i = 0; i < offset; i++) result.push(null);
        const days = new Date(Date.UTC(year, m + 1, 0)).getUTCDate();
        for (let day = 1; day <= days; day++) {
          const date = new Date(Date.UTC(year, m, day)).toISOString().slice(0, 10);
          result.push(cycles.find((c) => c.date <= date && date <= c.end) ?? null);
        }
        return result;
      }),
    [year, cycles],
  );
  const codesFor = (date: string) => holders.get(date) ?? [];
  function renderCycle(c: Cycle) {
    const free = slots(c),
      people = codesFor(c.date),
      status = cycleAvailability(c, availability, ruled);
    return (
      <button
        type="button"
        key={c.date}
        data-cycle-date={c.date}
        disabled={busy}
        onClick={() => onSelect(c)}
        aria-pressed={selected.includes(c.date)}
        aria-label={
          cycleTitle(c, ruled, availability) +
          (safe.has(c.date) ? ' · asegurado para ti' : '') +
          ownLabel(c.date) +
          (people.length ? ' · ' + people.join(', ') : '')
        }
        title={cycleTitle(c, ruled, availability)}
        className={
          'vac2-cycle ' +
          status.className +
          (blocked.has(c.date) ? ' vac2-not-for-me' : '') +
          (safe.has(c.date) ? ' vac2-secured' : '') +
          (isSummer(c) ? ' vac2-summer' : '') +
          (selected.includes(c.date) ? ' vac2-selected' : '') +
          (highlighted.includes(c.date) ? ' vac2-person' : '') +
          (owned.has(c.date) ? ' vac2-mine' : '')
        }
      >
        <span className="vac2-line">
          <b>{formatSpan(c.date, c.end)}</b>
          <b>
            {blocked.has(c.date)
              ? 'No disponible para ti'
              : ruled
                ? status.label === '?'
                  ? '? por confirmar'
                  : status.label === '1'
                    ? '1 libre'
                    : status.label + ' libres'
                : extraAvailable(c)
                  ? 'Cupo adicional posible'
                  : free + ' libres'}
          </b>
        </span>
        <span className="vac2-line vac2-cycle-sub">
          <span>{c.score} pt</span>
          <span>
            {cycleOccupancyLabel(c, availability, ruled)} ocupadas{!ruled && extraAvailable(c) ? ' · ampliable' : ''}
          </span>
        </span>
        {safe.has(c.date) && <span className="vac2-secured-badge">Asegurado para ti</span>}
        <OwnMarks owned={owned.has(c.date)} rank={rankOf(c.date)} who={ownerCode} />
        {people.length > 0 && (
          <span className="vac2-names" title={people.join(', ')}>
            {people.join(' · ')}
          </span>
        )}
      </button>
    );
  }
  function renderMonth(m: number, detail: boolean) {
    const monthCycles = byMonth[m];
    return (
      <section key={m} className="vac2-month" aria-label={months[m]} id={detail ? undefined : 'vac2-map-month-' + m}>
        <h3>{months[m]}</h3>
        {detail ? (
          <>
            <div className="vac2-weekdays">
              {'LMXJVSD'.split('').map((d, i) => (
                <span key={i}>{d}</span>
              ))}
            </div>
            <div className="vac2-days">
              {monthDates[m].map((c, i) => {
                if (!c) return <span key={'pad-' + i} />;
                const day = i - ((new Date(Date.UTC(year, m, 1)).getUTCDay() + 6) % 7) + 1;
                const first = c.date === new Date(Date.UTC(year, m, day)).toISOString().slice(0, 10);
                const status = cycleAvailability(c, availability, ruled);
                return (
                  <button
                    type="button"
                    key={i}
                    data-cycle-date={c.date}
                    disabled={busy}
                    onClick={() => onSelect(c)}
                    className={
                      'vac2-day ' +
                      status.className +
                      (blocked.has(c.date) ? ' vac2-not-for-me' : '') +
                      (isSummer(c) ? ' vac2-summer' : '') +
                      (selected.includes(c.date) ? ' vac2-selected' : '') +
                      (owned.has(c.date) ? ' vac2-mine' : '') +
                      (first ? ' vac2-cycle-start' : '')
                    }
                    aria-pressed={selected.includes(c.date)}
                    title={cycleTitle(c, ruled, availability)}
                    aria-label={day + ' ' + months[m] + ': ' + cycleTitle(c, ruled, availability) + ownLabel(c.date)}
                  >
                    {day}
                    {first && rankOf(c.date) > 0 && (
                      <small className="vac2-day-rank" aria-hidden="true">
                        P{rankOf(c.date)}
                      </small>
                    )}
                    {ruled && first && (
                      <small className="vac2-day-count" aria-hidden="true">
                        {status.label}
                      </small>
                    )}
                  </button>
                );
              })}
            </div>
            <div className="vac2-month-people">
              {cycles
                .filter(
                  (c) =>
                    c.date <= new Date(Date.UTC(year, m + 1, 0)).toISOString().slice(0, 10) &&
                    c.end >= new Date(Date.UTC(year, m, 1)).toISOString().slice(0, 10) &&
                    // Single days: only the awarded ones, or the list repeats the calendar.
                    (!daily || codesFor(c.date).length > 0 || owned.has(c.date) || rankOf(c.date) > 0),
                )
                .map((c) => (
                  <button
                    type="button"
                    className="vac2-occupants"
                    key={c.date}
                    onClick={() => onSelect(c)}
                    disabled={busy}
                  >
                    <b>{formatDate(c.date)}</b>
                    <span>{codesFor(c.date).join(' · ') || 'Sin adjudicar'}</span>
                    <OwnMarks owned={owned.has(c.date)} rank={rankOf(c.date)} who={ownerCode} />
                  </button>
                ))}
            </div>
          </>
        ) : (
          <div className="vac2-cycles">{monthCycles.map(renderCycle)}</div>
        )}
      </section>
    );
  }
  function renderMembers() {
    return (
      <div className="vac2-members-wrap">
        <div className="vac2-member-controls" role="group" aria-label="Ordenación de vacaciones por CTA">
          <label htmlFor="vac2-member-sort">
            Orden de CTA
            <select
              id="vac2-member-sort"
              value={memberOrder}
              onChange={(e) => setMemberOrder(e.target.value as MemberOrder)}
            >
              <option value="request">Orden de petición</option>
              <option value="points">Puntos acumulados ↑</option>
            </select>
          </label>
          <label htmlFor="vac2-cycle-sort">
            Orden de ciclos
            <select
              id="vac2-cycle-sort"
              value={cycleOrder}
              onChange={(e) => setCycleOrder(e.target.value as CycleOrder)}
            >
              <option value="chronological">Cronológico</option>
              <option value="request">Orden de petición</option>
            </select>
          </label>
        </div>
        <p className="muted">
          {daily
            ? 'El orden de petición de los días sigue las adjudicaciones registradas.'
            : 'Los puntos acumulados suman los ciclos adjudicados. El orden de petición de los ciclos sigue las adjudicaciones registradas.'}
        </p>
        <div className="vac2-members-desktop table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">CTA</th>
                {Array.from({ length: 6 }, (_, i) => (
                  <th scope="col" key={i}>
                    C{i + 1}
                  </th>
                ))}
                <th scope="col">Pts</th>
              </tr>
            </thead>
            <tbody>
              {displayedMembers.map((id) => {
                const entries = memberEntries(id);
                return (
                  <tr key={id} className={id === owner ? 'vac2-mine-row' : undefined}>
                    <th scope="row">{byId.get(id)}</th>
                    {Array.from({ length: 6 }, (_, i) => (
                      <td key={i}>
                        {entries[i] ? (
                          <button type="button" className="vac2-date-link" onClick={() => onSelect(entries[i])}>
                            {formatDate(entries[i].date)}
                          </button>
                        ) : (
                          '—'
                        )}
                      </td>
                    ))}
                    <td>{memberPoints.get(id) ?? 0}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {owner && ranked.length > 0 && (
            <div className="vac2-pref-row">
              <b>{ownerCode ? 'Preferencias de ' + ownerCode : 'Tus preferencias'}:</b> {prefChips()}
            </div>
          )}
        </div>
        <div className="vac2-members-mobile">
          {displayedMembers.map((id) => {
            const entries = memberEntries(id);
            return (
              <details key={id} className={'vac2-member-card' + (id === owner ? ' vac2-mine-row' : '')}>
                <summary>
                  <b>{byId.get(id)}</b>
                  <span>
                    {entries.length === 1 ? '1 ciclo' : entries.length + ' ciclos'} · {memberPoints.get(id) ?? 0} pt
                  </span>
                </summary>
                <div>
                  {entries.length ? (
                    entries.map((c) => (
                      <button type="button" className="vac2-member-cycle" key={c.date} onClick={() => onSelect(c)}>
                        {formatSpan(c.date, c.end)}
                        {c.date === c.end ? '' : ' · ' + c.score + ' pt'}
                      </button>
                    ))
                  ) : (
                    <p className="muted">Sin ciclos adjudicados</p>
                  )}
                  {id === owner && ranked.length > 0 && (
                    <div className="vac2-pref-row">
                      <b>{ownerCode ? 'Preferencias de ' + ownerCode : 'Tus preferencias'}:</b> {prefChips()}
                    </div>
                  )}
                </div>
              </details>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <section
      className={'panel vac2-panel' + (ruled ? ' vac2-ruled' : '') + (preferenceMode ? ' vac2-mode-preferences' : '')}
      aria-label={'Calendario de ' + unit + 's'}
    >
      {/* The mode is told by the frame and heading (plus the workspace notice), never by the marks. */}
      <div className="vac2-heading">
        <div>
          <h2>{preferenceMode ? 'Elige tus preferencias' : daily ? 'Disponibilidad' : 'Disponibilidad y baremo'}</h2>
          {!preferenceMode && <p className="muted">Selecciona cualquier {unit} para ver detalles y ocupantes.</p>}
        </div>
        <div className="vac2-view-switch" role="group" aria-label="Vista del calendario">
          <button
            type="button"
            className={view === 'table' ? 'active' : ''}
            aria-pressed={view === 'table'}
            onClick={() => changeView('table')}
          >
            Tabla
          </button>
          {!daily && (
            <button
              type="button"
              className={view === 'map' ? 'active' : ''}
              aria-pressed={view === 'map'}
              onClick={() => changeView('map')}
            >
              Mapa
            </button>
          )}
          <button
            type="button"
            className={view === 'calendar' ? 'active' : ''}
            aria-pressed={view === 'calendar'}
            onClick={() => changeView('calendar')}
          >
            Meses
          </button>
          <button
            type="button"
            className={view === 'members' ? 'active' : ''}
            aria-pressed={view === 'members'}
            onClick={() => changeView('members')}
          >
            Por CTA
          </button>
        </div>
      </div>
      {/* One legend for every view (#64): same colours, same words. */}
      <div className="vac2-legend" aria-label="Leyenda de plazas disponibles">
        {view === 'table' ? (
          <>
            <span>
              <i className="vac3-key vac3-key-free" />
              Plaza libre
            </span>
            <span>
              <i className="vac3-key vac3-key-occupied" />
              Ocupada (código)
            </span>
            <span>
              <i className="vac2-key vac2-free-0" />
              Sin plaza
            </span>
          </>
        ) : (
          <>
            <AvailabilityScale />
          </>
        )}
        {ruled && (
          <span>
            <i className="vac2-key vac2-unknown" />? Por confirmar
          </span>
        )}
        {safe.size > 0 && (
          <span>
            <i className="vac2-secured-key" />
            Asegurado para ti
          </span>
        )}
        {!daily && (
          <span className="vac2-legend-summer">
            <i className="vac2-summer-key" />
            Verano
          </span>
        )}
        {glossary && (
          <a
            className="vac2-glossary-link"
            href="#glosario"
            onClick={() => {
              const g = document.getElementById('glosario') as HTMLDetailsElement | null;
              if (g) g.open = true;
            }}
          >
            ⓘ Qué significa
          </a>
        )}
        {!preferenceMode && (
          <span>
            <i className="vac2-selection-key" />
            Tu selección
          </span>
        )}
        {(owned.size > 0 || ranked.length > 0) && (
          <span className="vac2-legend-own">
            {owned.size > 0 && <span className="vac2-mine-badge">✓ {ownerCode ?? 'Tuyo'}</span>}
            {ranked.length > 0 && <span className="vac2-rank-chip">P1</span>}
            {[
              owned.size > 0 && (ownerCode ? 'Adjudicado a ' + ownerCode : 'Adjudicado a ti'),
              ranked.length > 0 && (ownerCode ? 'Orden de preferencia de ' + ownerCode : 'Tu orden de preferencia'),
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        )}
      </div>
      {view === 'table' && (
        <CycleTable
          year={year}
          ruled={ruled}
          cycles={cycles}
          awards={awards}
          members={members}
          selected={selected}
          highlighted={highlighted}
          preferenceMode={preferenceMode}
          busy={busy}
          onSelect={onSelect}
          availability={availability}
          notForMe={notForMe}
          secured={secured}
          mine={mineDates}
          preferences={ranked}
          ownerCode={ownerCode}
        />
      )}
      {view === 'map' && (
        <nav className="vac2-month-jump" aria-label="Ir al mes">
          {months.map(
            (name, m) =>
              byMonth[m].length > 0 && (
                <button
                  type="button"
                  key={m}
                  onClick={() =>
                    document
                      .getElementById('vac2-map-month-' + m)
                      ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                  }
                >
                  {name.slice(0, 3)}
                </button>
              ),
          )}
        </nav>
      )}
      {view === 'map' && <div className="vac2-month-grid vac2-map">{months.map((_, m) => renderMonth(m, false))}</div>}
      {view === 'calendar' && (
        <>
          <MonthNavigation month={activeMonth} label={months[activeMonth]} onChange={setActiveMonth} />
          <div className="vac2-month-grid vac2-calendar">
            {months.map((_, m) => (
              <div className={m === activeMonth ? 'vac2-active-mobile' : 'vac2-hidden-mobile'} key={m}>
                {renderMonth(m, true)}
              </div>
            ))}
          </div>
        </>
      )}
      {view === 'members' && renderMembers()}
      <p className="vac2-footnote">
        {daily
          ? 'Las plazas libres son las de RRHH para cada día, menos las ya adjudicadas. Los nombres aparecen por orden de elección. Pulsa un día para ver el detalle.'
          : ruled
            ? 'Las plazas libres tienen en cuenta las normas del reparto: si una persona coge un ciclo, puede reducir las de otros. «?» significa que la aplicación no ha podido demostrar si esa plaza respeta las normas: puede estar libre o bloqueada, y esperar no lo resuelve. Al confirmar se vuelve a comprobar y, si sigue sin demostrarse, no se adjudica. Los nombres aparecen por orden de elección. Pulsa un ciclo para ver el detalle.'
            : 'Un ciclo completo puede admitir un cupo adicional si está autorizado; se comprueba al confirmar.'}
      </p>
    </section>
  );
}
