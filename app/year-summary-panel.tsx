'use client';
import { useEffect, useState } from 'react';
import { api } from './api-client';
import { MonthDays, MonthNavigation } from './calendar-controls';
import { availabilityBand, availabilityBands } from './year-summary-bands';

type Day = { date: string; vacation: number; va: number; available: number; incomplete: boolean };
type Summary = {
  year: number | null;
  years: number[];
  staff: number;
  missingTeams: string[];
  openTeams: string[];
  vaOpen: boolean;
  days: Day[];
};

const monthNames = Array.from({ length: 12 }, (_, m) => {
  const name = new Date(Date.UTC(2027, m, 1)).toLocaleDateString('es-ES', { month: 'long', timeZone: 'UTC' });
  return name[0].toUpperCase() + name.slice(1);
});
const dayLabel = (date: string) =>
  new Date(date + 'T12:00:00Z').toLocaleDateString('es-ES', { day: 'numeric', month: 'short' }).replaceAll('.', '');
const describe = (d: Day) =>
  `${dayLabel(d.date)}: ${d.vacation} vacaciones · ${d.va} VA · ${d.available} disponibles` +
  (d.incomplete ? ' (datos incompletos)' : '');
const bandClass = (d: Day) => (d.incomplete ? 'year-incomplete' : 'year-band-' + availabilityBand(d.available));

/** Superadministrators: the whole workforce, day by day, for a year. */
export default function YearSummaryPanel() {
  const [requested, setRequested] = useState<number | null>(null),
    [summary, setSummary] = useState<Summary | null>(null),
    [error, setError] = useState(''),
    [view, setView] = useState<'calendar' | 'table'>('calendar'),
    [month, setMonth] = useState(0),
    [picked, setPicked] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    api('year-summary' + (requested ? '?year=' + requested : ''))
      .then((next: Summary) => {
        if (!current) return;
        setError('');
        setSummary(next);
        setPicked(null);
      })
      .catch((e: Error) => current && setError(e.message));
    return () => {
      current = false;
    };
  }, [requested]);
  if (error) return <div className="alert error">{error}</div>;
  if (!summary) return <div className="panel empty">Cargando el resumen anual…</div>;
  if (summary.year === null) return <div className="panel empty">Todavía no hay campañas reales.</div>;
  const year = summary.year;
  const byDate = new Map(summary.days.map((d) => [d.date, d]));
  const detail = picked ? byDate.get(picked) : undefined;
  const hasIncomplete = summary.days.some((d) => d.incomplete);
  return (
    <section className="panel year-summary" aria-label={'Resumen anual ' + year}>
      <div className="year-summary-bar">
        <label>
          Año
          <select value={year} onChange={(e) => setRequested(Number(e.target.value))}>
            {summary.years.map((y) => (
              <option key={y}>{y}</option>
            ))}
          </select>
        </label>
        <span className="muted">Plantilla: {summary.staff} controladores</span>
        <div className="vac2-view-switch" role="group" aria-label="Vista del resumen">
          {(
            [
              ['calendar', 'Meses'],
              ['table', 'Tabla'],
            ] as const
          ).map(([key, label]) => (
            <button
              type="button"
              key={key}
              className={view === key ? 'active' : ''}
              aria-pressed={view === key}
              onClick={() => setView(key)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {summary.vaOpen && (
        <div className="alert warning" role="status">
          VA en curso: solo se cuentan los días ya adjudicados.
        </div>
      )}
      {summary.openTeams.length > 0 && (
        <div className="alert warning" role="status">
          Campañas aún abiertas (se cuenta lo adjudicado): {summary.openTeams.join(', ')}.
        </div>
      )}
      {summary.missingTeams.length > 0 && (
        <div className="alert warning" role="status">
          Equipos sin campaña real este año, fuera de los totales: {summary.missingTeams.join(', ')}.
        </div>
      )}
      {hasIncomplete && (
        <div className="alert warning" role="status">
          Días con datos incompletos: pueden faltar vacaciones de ciclos que empezaron el año anterior.
        </div>
      )}
      {view === 'calendar' ? (
        <>
          <div className="vac2-legend year-legend">
            <b>Disponibles</b>
            {availabilityBands.map((band, i) => (
              <span key={band.label}>
                <i className={'vac2-key year-band-' + i} aria-hidden="true" />
                {band.label}
              </span>
            ))}
            {hasIncomplete && (
              <span>
                <i className="vac2-key year-incomplete" aria-hidden="true" />
                Incompleto
              </span>
            )}
          </div>
          <MonthNavigation month={month} label={monthNames[month]} onChange={setMonth} />
          <p className="year-detail" aria-live="polite">
            {detail ? describe(detail) : 'Pulsa un día para ver sus valores.'}
          </p>
          <div className="vac2-month-grid vac2-calendar">
            {monthNames.map((name, m) => (
              <div className={m === month ? 'vac2-active-mobile' : 'vac2-hidden-mobile'} key={m}>
                <section className="vac2-month" aria-label={name}>
                  <h3>{name}</h3>
                  <MonthDays
                    year={year}
                    month={m}
                    renderDay={(day, date) => {
                      const d = byDate.get(date)!;
                      return (
                        <button
                          type="button"
                          key={date}
                          className={'vac2-day year-day ' + bandClass(d)}
                          aria-pressed={picked === date}
                          title={describe(d)}
                          aria-label={describe(d)}
                          onClick={() => setPicked(date)}
                        >
                          {day}
                        </button>
                      );
                    }}
                  />
                </section>
              </div>
            ))}
          </div>
        </>
      ) : (
        <div className="table-wrap year-table">
          <table>
            <thead>
              <tr>
                <th scope="col">Fecha</th>
                <th scope="col">Vacaciones</th>
                <th scope="col">VA</th>
                <th scope="col">Disponibles</th>
              </tr>
            </thead>
            <tbody>
              {summary.days.map((d) => (
                <tr key={d.date}>
                  <th scope="row">{dayLabel(d.date)}</th>
                  <td>{d.vacation}</td>
                  <td>{d.va}</td>
                  <td>
                    <span className={'year-chip ' + bandClass(d)}>{d.available}</span>
                    {d.incomplete && ' incompleto'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
