'use client';
import { useState } from 'react';
import { AvailabilityScale, MonthNavigation } from './calendar-controls';

const monthName = (year: number, month: number) =>
  new Date(Date.UTC(year, month, 1)).toLocaleDateString('es-ES', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const dateLabel = (date: string) =>
  new Date(date + 'T12:00:00Z').toLocaleDateString('es-ES', { day: 'numeric', month: 'long', timeZone: 'UTC' });

type Props = {
  year: number;
  month: number;
  onMonth: (month: number) => void;
  available: Record<string, number>;
  selected: string[];
  preferences: string[];
  own: Set<string>;
  ordinary: Set<string>;
  preferenceMode: boolean;
  canChoose: boolean;
  limit: number;
  busy: boolean;
  onSelect: (date: string) => void;
};

/** Daily VA rules, presented with the ordinary calendar's visual language. */
export default function VaDayCalendar({
  year,
  month,
  onMonth,
  available,
  selected,
  preferences,
  own,
  ordinary,
  preferenceMode,
  canChoose,
  limit,
  busy,
  onSelect,
}: Props) {
  const [display, setDisplay] = useState<'calendar' | 'map'>('calendar');
  const days = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const offset = (new Date(Date.UTC(year, month, 1)).getUTCDay() + 6) % 7;
  return (
    <div className="vac2-panel vac2-ruled va-calendar">
      <div className="vac2-toolbar">
        <h3>{preferenceMode ? 'Prepara tu lista de días' : 'Calendario de días'}</h3>
        <div className="vac2-view-switch" role="group" aria-label="Vista del calendario VA">
          <button
            type="button"
            className={display === 'map' ? 'active' : ''}
            aria-pressed={display === 'map'}
            onClick={() => setDisplay('map')}
          >
            Mapa anual
          </button>
          <button
            type="button"
            className={display === 'calendar' ? 'active' : ''}
            aria-pressed={display === 'calendar'}
            onClick={() => setDisplay('calendar')}
          >
            Meses
          </button>
        </div>
      </div>
      <div className="vac2-legend" aria-label="Leyenda de plazas disponibles">
        <AvailabilityScale maximum={3} />
        <span>
          <i className="vac2-selection-key" aria-hidden="true" />
          Tu selección
        </span>
        <span>
          <i className="va-ordinary-key" aria-hidden="true" />
          Ordinarias
        </span>
        <span>
          <span className="vac2-mine-badge">✓ Tuyo</span>VA confirmadas
        </span>
        {preferences.length > 0 && (
          <span>
            <span className="vac2-rank-chip">P1</span>Tu orden de preferencia
          </span>
        )}
      </div>
      {display === 'map' ? (
        <div className="va-year-map" aria-label="Mapa anual de VA">
          {Array.from({ length: 12 }, (_, m) => {
            const count = new Date(Date.UTC(year, m + 1, 0)).getUTCDate();
            const start = (new Date(Date.UTC(year, m, 1)).getUTCDay() + 6) % 7;
            return (
              <button
                type="button"
                key={m}
                className="va-map-month"
                aria-label={'Ver ' + monthName(year, m)}
                onClick={() => {
                  onMonth(m);
                  setDisplay('calendar');
                }}
              >
                <strong>{monthName(year, m)}</strong>
                <span className="va-map-days" aria-hidden="true">
                  {Array.from({ length: start }, (_, i) => (
                    <i key={'blank' + i} />
                  ))}
                  {Array.from({ length: count }, (_, i) => {
                    const date = `${year}-${String(m + 1).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`;
                    return (
                      <i
                        key={date}
                        className={
                          'vac2-key vac2-free-' +
                          Math.min(3, Math.max(0, available[date] ?? 0)) +
                          (selected.includes(date) ? ' vac2-selected' : '') +
                          (own.has(date) ? ' va-map-own' : '') +
                          (ordinary.has(date) ? ' va-map-ordinary' : '')
                        }
                      >
                        {i + 1}
                      </i>
                    );
                  })}
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <>
          <MonthNavigation
            month={month}
            label={monthName(year, month)}
            onChange={onMonth}
            className="va-month-nav"
            previousLabel="Mes anterior"
            nextLabel="Mes siguiente"
          />
          <div className="vac2-month va-month">
            <div className="vac2-weekdays" aria-hidden="true">
              {['L', 'M', 'X', 'J', 'V', 'S', 'D'].map((d, i) => (
                <span key={i}>{d}</span>
              ))}
            </div>
            <div className="vac2-days va-day-grid" role="group" aria-label={'Calendario de ' + monthName(year, month)}>
              {Array.from({ length: offset }, (_, i) => (
                <span key={'blank' + i} />
              ))}
              {Array.from({ length: days }, (_, i) => {
                const date = `${year}-${String(month + 1).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`;
                const free = Math.max(0, available[date] ?? 0),
                  mine = own.has(date),
                  blocked = ordinary.has(date);
                const rank = preferences.indexOf(date) + 1;
                const disabled =
                  busy ||
                  mine ||
                  blocked ||
                  (!preferenceMode &&
                    (!canChoose || free <= 0 || (limit > 1 && selected.length >= limit && !selected.includes(date))));
                return (
                  <button
                    type="button"
                    key={date}
                    aria-pressed={selected.includes(date)}
                    aria-label={`${dateLabel(date)}: ${mine ? 'VA elegida' : blocked ? 'vacaciones ordinarias' : free > 0 ? free + ' plazas libres' : 'completo'}`}
                    title={`${dateLabel(date)} · ${free} plazas libres${rank ? ' · preferencia ' + rank : ''}`}
                    disabled={disabled}
                    onClick={() => onSelect(date)}
                    className={
                      'vac2-day vac2-free-' +
                      Math.min(3, free) +
                      (selected.includes(date) ? ' vac2-selected' : '') +
                      (mine ? ' va-own' : '') +
                      (blocked ? ' va-ordinary' : '')
                    }
                  >
                    <span>{i + 1}</span>
                    {mine && (
                      <small className="va-day-mark" aria-hidden="true">
                        ✓
                      </small>
                    )}
                    {!mine && rank > 0 && (
                      <small className="vac2-rank-chip" aria-hidden="true">
                        P{rank}
                      </small>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        </>
      )}
      <p className="muted va-calendar-help">
        {preferenceMode
          ? 'Toca los días para añadirlos a tu lista. El orden de la lista marca tu prioridad; no reserva plazas.'
          : canChoose
            ? 'Toca un día para seleccionarlo. Revisa tu selección antes de confirmar.'
            : 'Consulta la disponibilidad. Podrás elegir cuando llegue tu turno.'}
      </p>
    </div>
  );
}
