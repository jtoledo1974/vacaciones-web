'use client';
import { useEffect, useRef, useState } from 'react';
import { api } from './api-client';
import VaDayCalendar from './va-day-calendar';
import { useConfirmation } from './confirmation';
import type { vaElectionView } from '../server/va-election';
import type { VaPreference } from '../domain/va-election';

type View = Awaited<ReturnType<typeof vaElectionView>>;
const dateLabel = (date: string) =>
  new Date(date + 'T12:00:00Z').toLocaleDateString('es-ES', { day: 'numeric', month: 'long', timeZone: 'UTC' });
const statuses = {
  preparation: 'En preparación',
  running: 'En curso',
  paused: 'Pausada',
  round_complete: 'Primera ronda terminada',
  completed: 'Elección terminada',
};
const actionLabels: Record<string, string> = {
  start: 'Apertura',
  choose: 'Elección y automatismos derivados',
  skip: 'Turno saltado',
  defer: 'Aplazamiento',
  pause: 'Pausa',
  resume: 'Reanudación',
  advance: 'Preferencias automáticas',
  resume_automatic: 'Reanudación de automatismos',
  reconstruct_finish: 'Reconstrucción aplicada',
};

/** Global daily calendar, its two rounds and the owner's private ranked preferences. */
export default function VaElectionPanel({ administration = false }: { administration?: boolean }) {
  const confirm = useConfirmation();
  const [view, setView] = useState<View | null>(null),
    [year, setYear] = useState<number | null>(null),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [online, setOnline] = useState(true),
    [month, setMonth] = useState(0),
    [selection, setSelection] = useState<{ context: string; dates: string[] }>({ context: '', dates: [] }),
    [editingPreferences, setEditingPreferences] = useState(false),
    [preference, setPreference] = useState<VaPreference>({ dates: [], mode: 'manual', waitMinutes: 30 }),
    [reason, setReason] = useState(''),
    [targetId, setTargetId] = useState('');
  const calendarRef = useRef<HTMLDivElement>(null);
  const selectionContext = (next: View, campaignYear: number) =>
    `${campaignYear}:${next.state?.round}:${next.state?.turn}:${!!next.reconstructing}`;
  const context = view && year ? selectionContext(view, year) : '';
  // Never carry a draft across people, rounds or reconstruction boundaries.
  const selected = selection.context === context ? selection.dates : [];
  const setSelected = (next: string[] | ((dates: string[]) => string[])) =>
    setSelection((current) => ({
      context,
      dates: typeof next === 'function' ? next(current.context === context ? current.dates : []) : next,
    }));
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    api<{ va: { year: number | null } }>('index')
      .then(async (index) => {
        if (!index.va.year) return;
        const next = await api<View>('va/election/' + index.va.year);
        if (!cancelled) {
          setYear(index.va.year);
          setView(next);
          if (next.preference) setPreference(next.preference);
          if (next.me) {
            try {
              const draft = JSON.parse(localStorage.getItem('va-selection:' + index.va.year + ':' + next.me) ?? '[]');
              if (
                draft?.context === selectionContext(next, index.va.year) &&
                Array.isArray(draft.dates) &&
                draft.dates.every((d: unknown) => typeof d === 'string' && d.startsWith(index.va.year + '-'))
              )
                setSelection({
                  context: draft.context,
                  dates: next.state?.round === 1 ? draft.dates.slice(0, 1) : draft.dates,
                });
            } catch {
              /* A broken or unavailable local draft never prevents access. */
            }
          }
        }
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    if (!year) return;
    const timer = setInterval(() => {
      api<View>('va/election/' + year)
        .then(async (next) => {
          if (next.state?.status === 'running' && (next.me || next.admin)) {
            next = await api<View>('va/election/' + year, { body: { action: 'advance', version: next.version } });
          }
          setView((current) => (!current || next.version >= current.version ? next : current));
        })
        .catch(() => {});
    }, 15_000);
    return () => clearInterval(timer);
  }, [year]);
  useEffect(() => {
    if (!view?.me || !year) return;
    try {
      localStorage.setItem(
        'va-selection:' + year + ':' + view.me,
        JSON.stringify({ context, dates: selection.context === context ? selection.dates : [] }),
      );
    } catch {
      /* Optional draft storage. */
    }
  }, [selection, context, view?.me, year]);
  const mutate = async (body: Record<string, unknown>) => {
    if (!view || !year || busy) return false;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const next = await api<View>('va/election/' + year, { body: { ...body, version: view.version } });
      setView((current) => (!current || next.version >= current.version ? next : current));
      return true;
    } catch (e) {
      setError((e as Error).message);
      try {
        const next = await api<View>('va/election/' + year);
        setView((current) => (!current || next.version >= current.version ? next : current));
      } catch {
        // Keep the draft and original error if the refresh also fails.
      }
      return false;
    } finally {
      setBusy(false);
    }
  };
  if (!view?.state || !year)
    return (
      <section className="panel">
        <h2>Elección de días de VA</h2>
        {error ? (
          <p role="alert">{error}</p>
        ) : (
          <p>
            La administración abrirá manualmente la elección tras revisar el censo ordenado de RRHH, cargar por CLI la
            disponibilidad diaria y cerrar las vacaciones ordinarias.
          </p>
        )}
      </section>
    );
  const state = view.state,
    me = state.people.find((p) => p.id === view.me),
    turn = state.people.find((p) => p.id === state.turn),
    acting = administration && view.admin ? turn : me,
    canChoose = state.status === 'running' && acting?.id === state.turn && (!view.reconstructing || administration),
    limit = acting ? (state.round === 1 ? Math.min(1, acting.balance ?? 0) : (acting.balance ?? 0)) : 0,
    savedPreference = view.preference ?? { dates: [], mode: 'manual', waitMinutes: 0 },
    chosen = state.choices.filter((c) => c.personId === acting?.id).map((c) => c.date),
    ownOrdinary = administration ? (view.turnOrdinaryDays ?? []) : (view.ordinaryDays ?? []),
    currentDates = editingPreferences ? preference.dates : selected;
  const toggle = (date: string) => {
    setNotice('');
    if (editingPreferences)
      setPreference((p) => ({
        ...p,
        dates: p.dates.includes(date) ? p.dates.filter((d) => d !== date) : [...p.dates, date],
      }));
    else {
      setSelected((s) =>
        s.includes(date) ? s.filter((d) => d !== date) : limit === 1 ? [date] : s.length < limit ? [...s, date] : s,
      );
    }
  };
  const movePreference = (index: number, delta: number) =>
    setPreference((p) => {
      const dates = [...p.dates];
      [dates[index], dates[index + delta]] = [dates[index + delta], dates[index]];
      return { ...p, dates };
    });
  return (
    <section className="panel va-election" aria-label="Elección de días de VA">
      <div className={'election-turn my-election va-turn' + (canChoose && !administration ? ' is-my-turn' : '')}>
        <div>
          <div className="eyebrow">
            ANTIGÜEDAD · {year} · RONDA {state.round} · {statuses[state.status].toUpperCase()}
          </div>
          <h2>
            {state.status === 'completed'
              ? 'Elección terminada'
              : state.status === 'preparation'
                ? 'Elección en preparación'
                : state.status === 'paused'
                  ? 'Elección en pausa'
                  : canChoose
                    ? administration
                      ? turn?.code + ' elige ahora'
                      : 'Es tu turno'
                    : turn
                      ? turn.code + ' elige ahora'
                      : statuses[state.status]}
          </h2>
          <p className="muted">
            {canChoose
              ? `${limit === 1 ? '1 día' : limit + ' días'} por elegir${administration ? ' · Confirmación delegada' : ''}`
              : me && state.queue.includes(me.id)
                ? `Te quedan ${state.queue.indexOf(me.id)} turnos.`
                : 'Días sueltos · Una campaña para toda LECS'}
          </p>
        </div>
        {administration && view.admin && canChoose && turn && (
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => {
              calendarRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
              calendarRef.current?.focus({ preventScroll: true });
            }}
          >
            Elegir en nombre de {turn.code}
          </button>
        )}
        {!administration && me && state.status !== 'completed' && (
          <div className="election-view-switch" role="group" aria-label="Modo de vacaciones">
            <button
              type="button"
              className="election-view-option"
              aria-pressed={!editingPreferences}
              onClick={async () => {
                if (editingPreferences && JSON.stringify(preference) !== JSON.stringify(savedPreference)) {
                  if (
                    !(await confirm(
                      'Tienes cambios sin guardar en tus preferencias. ¿Descartarlos y volver al calendario?',
                      undefined,
                      { title: 'Preferencias sin guardar', confirmLabel: 'Descartar cambios' },
                    ))
                  )
                    return;
                  setPreference(savedPreference);
                }
                setEditingPreferences(false);
              }}
            >
              Calendario
            </button>
            <button
              type="button"
              className="election-view-option"
              aria-pressed={editingPreferences}
              onClick={() => {
                setEditingPreferences(true);
              }}
            >
              Mis preferencias
            </button>
          </div>
        )}
      </div>
      {view.reconstructing && (
        <p className="alert" role="status">
          {administration
            ? 'Reconstrucción en curso: los cambios no se publican hasta aplicarlos.'
            : 'La administración está reconstruyendo la elección. Las confirmaciones están detenidas.'}
        </p>
      )}
      {state.automaticPaused && !view.reconstructing && (
        <p role="status">Automatismos detenidos. La administración debe reanudarlos expresamente.</p>
      )}
      {error && (
        <p className="alert error" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {!online && (
        <p role="status">Sin conexión. Conservamos tu selección; podrás confirmar cuando vuelva la conexión.</p>
      )}
      {me && (
        <div className="va-my-election">
          <div className="va-balance">
            <span>
              Tus días: <strong>{me.days}</strong>
            </span>
            <span>
              Elegidos: <strong>{(me.days ?? 0) - (me.balance ?? 0)}</strong>
            </span>
            <span>
              Saldo: <strong>{me.balance}</strong>
            </span>
          </div>
          {state.status !== 'completed' && (
            <p className="muted">
              {state.automaticPaused
                ? 'La elección automática está detenida; tu lista se conserva.'
                : !savedPreference.dates.length
                  ? 'No tienes preferencias guardadas: en tu turno tendrás que elegir tú.'
                  : savedPreference.mode === 'manual'
                    ? 'Tu lista es solo una nota: en tu turno elegirás tú.'
                    : savedPreference.mode === 'immediate'
                      ? 'Al llegar tu turno se elegirá automáticamente de tus preferencias.'
                      : `En tu turno tendrás ${savedPreference.waitMinutes} minutos para elegir antes de aplicar tus preferencias.`}
            </p>
          )}
        </div>
      )}
      {state.status === 'preparation' && (
        <p>
          La administración debe abrir VA manualmente tras cerrar las ordinarias, revisar el censo y cargar por CLI la
          disponibilidad diaria de RRHH. El cierre de ordinarias no inicia la elección automáticamente.
        </p>
      )}
      {me && state.deferrals[me.id] && <p>Tu turno está aplazado: {state.deferrals[me.id]}</p>}
      {administration && view.admin && (
        <section className="election-history-panel" aria-label="Historial de VA">
          <div className="election-history-head">
            <h3>Historial de la elección</h3>
            <div className="election-workflow-actions" role="group" aria-label="Acciones del historial de VA">
              <button
                type="button"
                className="secondary"
                disabled={busy || !view.control?.canUndo}
                onClick={async () => {
                  if (await confirm('¿Deshacer el último cambio de VA, incluyendo ronda, turno y días adjudicados?'))
                    await mutate({ action: 'undo' });
                }}
              >
                Deshacer
              </button>
              <button
                type="button"
                className="secondary"
                disabled={busy || !view.control?.canRedo}
                onClick={async () => {
                  if (await confirm('¿Rehacer el cambio de elección de VA?')) await mutate({ action: 'redo' });
                }}
              >
                Rehacer
              </button>
            </div>
          </div>
          <p className="muted">
            Deshacer restaura la ronda, el turno y las elecciones, incluidos los automatismos derivados. No cambia las
            listas privadas actuales.
          </p>
        </section>
      )}
      {administration && view.admin && (
        <details className="va-admin-controls" open={view.reconstructing || undefined}>
          <summary>Gestionar elección · Historial y reconstrucción</summary>
          {state.status === 'running' && (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => void mutate({ action: 'advance' })}
            >
              Comprobar preferencias automáticas
            </button>
          )}
          <details>
            <summary>Últimos cambios</summary>
            <ol>
              {view.control?.history.slice(0, 15).map((h) => (
                <li key={h.id}>
                  {actionLabels[h.action] ?? 'Cambio administrativo'} · {new Date(h.at).toLocaleString('es-ES')}
                  {h.undone && ' · deshecho'}
                </li>
              ))}
            </ol>
          </details>
          {view.reconstructing ? (
            <div aria-label="Controles de reconstrucción">
              <h3>Reconstrucción · {view.control?.reconstruction?.steps ?? 0} pasos</h3>
              <p>
                Reconstruye las elecciones en orden con el calendario. El censo y los cupos siguen siendo los actuales.
              </p>
              <button
                disabled={busy || !view.control?.reconstruction?.steps}
                onClick={() => void mutate({ action: 'reconstruct_back' })}
              >
                Volver un paso
              </button>
              <button
                disabled={busy || state.status !== 'running'}
                onClick={() => void mutate({ action: 'reconstruct_auto' })}
              >
                Paso por preferencias
              </button>
              <button
                disabled={busy}
                onClick={async () => {
                  if (
                    await confirm(
                      <span>
                        La reconstrucción sustituirá todas las adjudicaciones actuales por las del borrador (
                        {state.choices.length} días adjudicados). También cambiará la ronda y la cola de turnos.
                        {state.choices.length === 0 && (
                          <strong className="confirm-warnings">
                            El borrador está vacío: se eliminarán todas las adjudicaciones actuales.
                          </strong>
                        )}
                      </span>,
                      undefined,
                      {
                        title: 'Aplicar reconstrucción de VA',
                        cancelLabel: 'Volver al borrador',
                        confirmLabel: 'Sustituir elección por el borrador',
                      },
                    )
                  )
                    await mutate({ action: 'reconstruct_finish' });
                }}
              >
                Aplicar reconstrucción
              </button>
              <button disabled={busy} onClick={() => void mutate({ action: 'reconstruct_cancel' })}>
                Cancelar reconstrucción
              </button>
            </div>
          ) : (
            <>
              {state.status !== 'preparation' && (
                <button disabled={busy} onClick={() => void mutate({ action: 'reconstruct_start' })}>
                  Reconstruir desde el principio
                </button>
              )}
              {state.automaticPaused && (
                <button
                  disabled={busy || state.status !== 'running'}
                  onClick={() => void mutate({ action: 'resume_automatic' })}
                >
                  Reanudar automatismos
                </button>
              )}
            </>
          )}
          {!view.reconstructing && state.status === 'preparation' && (
            <>
              <p>
                {view.ordinaryClosed ? 'Ordinarias cerradas.' : 'Falta cerrar las ordinarias.'} Orden del censo:{' '}
                {state.source?.title}.
              </p>
              <button disabled={busy || !view.ordinaryClosed} onClick={() => void mutate({ action: 'start' })}>
                Abrir primera ronda
              </button>
            </>
          )}
          {!view.reconstructing && state.status === 'running' && (
            <button disabled={busy} onClick={() => void mutate({ action: 'pause' })}>
              Pausar elección
            </button>
          )}
          {!view.reconstructing && state.status === 'paused' && (
            <button disabled={busy} onClick={() => void mutate({ action: 'resume' })}>
              Reanudar elección
            </button>
          )}
          {state.status === 'running' && turn && (
            <details>
              <summary>Gestionar turno de {turn.code}</summary>
              <label>
                Motivo
                <input value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
              </label>
              <button
                disabled={busy || !reason.trim()}
                onClick={() => void mutate({ action: view.reconstructing ? 'reconstruct_skip' : 'skip', reason })}
              >
                Saltar turno de {turn.code}
              </button>
              <label>
                Aplazar hasta el turno de
                <select value={targetId} onChange={(e) => setTargetId(e.target.value)}>
                  <option value="">Selecciona persona</option>
                  {state.queue.slice(1).map((id) => (
                    <option key={id} value={id}>
                      {state.people.find((p) => p.id === id)?.code}
                    </option>
                  ))}
                </select>
              </label>
              <button
                disabled={busy || view.reconstructing || !targetId || !reason.trim()}
                onClick={() => void mutate({ action: 'defer', personId: turn.id, targetId, reason })}
              >
                Aplazar turno
              </button>
              <p>
                El administrador confirma abajo los días en nombre de {turn.code}. Debe haber obtenido su
                consentimiento.
              </p>
            </details>
          )}
        </details>
      )}
      {editingPreferences && (
        <p>
          Añade días en el calendario, también si están completos ahora. El orden de la lista indica tu prioridad. Se
          aplicarán solo los que tengan hueco al llegar tu turno.
        </p>
      )}
      <div ref={calendarRef} tabIndex={-1} role="group" aria-label="Calendario de elección de VA">
        {administration && canChoose && (
          <p className="muted">Eliges en nombre de {acting?.code}. Debes haber obtenido su consentimiento.</p>
        )}
        <VaDayCalendar
          year={year}
          month={month}
          onMonth={setMonth}
          available={view.available ?? {}}
          selected={currentDates}
          preferences={editingPreferences ? preference.dates : (view.preference?.dates ?? [])}
          own={new Set(chosen)}
          ordinary={new Set(ownOrdinary)}
          preferenceMode={editingPreferences}
          canChoose={canChoose}
          limit={limit}
          busy={busy}
          onSelect={toggle}
        />
      </div>

      {editingPreferences ? (
        <div className="va-preferences">
          <h3>
            Mis preferencias · {preference.dates.length} {preference.dates.length === 1 ? 'día' : 'días'}
          </h3>
          <ol className="va-date-list">
            {preference.dates.map((date, i) => (
              <li key={date}>
                <span>
                  {dateLabel(date)}
                  {(view.available?.[date] ?? 0) <= 0 && ' · completo'}
                </span>
                <div>
                  <button
                    aria-label={'Subir ' + dateLabel(date)}
                    disabled={i === 0}
                    onClick={() => movePreference(i, -1)}
                  >
                    ↑
                  </button>
                  <button
                    aria-label={'Bajar ' + dateLabel(date)}
                    disabled={i === preference.dates.length - 1}
                    onClick={() => movePreference(i, 1)}
                  >
                    ↓
                  </button>
                  <button aria-label={'Quitar preferencia ' + dateLabel(date)} onClick={() => toggle(date)}>
                    ×
                  </button>
                </div>
              </li>
            ))}
          </ol>
          <label>
            Aplicar preferencias
            <select
              value={preference.mode}
              onChange={(e) => setPreference({ ...preference, mode: e.target.value as VaPreference['mode'] })}
            >
              <option value="manual">Nunca: elegiré manualmente</option>
              <option value="immediate">Al llegar mi turno</option>
              <option value="after_wait">Después de mi espera</option>
            </select>
          </label>
          {preference.mode === 'after_wait' && (
            <label>
              Minutos de espera
              <input
                type="number"
                min={1}
                max={1440}
                value={preference.waitMinutes}
                onChange={(e) => setPreference({ ...preference, waitMinutes: Number(e.target.value) })}
              />
            </label>
          )}
          <p>En segunda ronda, si la lista no alcanza para todo tu saldo, el turno espera tu confirmación manual.</p>
          <button
            className="primary"
            disabled={busy}
            onClick={async () => {
              if (
                canChoose &&
                preference.mode !== 'manual' &&
                !(await confirm(
                  'Es tu turno. Guardar estas preferencias puede adjudicar días automáticamente y avanzar al siguiente turno. ¿Guardar y continuar?',
                  undefined,
                  { title: 'Guardar preferencias durante tu turno', confirmLabel: 'Guardar y continuar' },
                ))
              )
                return;
              if (await mutate({ action: 'preferences', ...preference })) setNotice('Preferencias guardadas');
            }}
          >
            Guardar preferencias
          </button>
        </div>
      ) : (
        canChoose && (
          <div className={'cycle-selection va-selection' + (!selected.length ? ' is-empty' : '')}>
            <h3>
              {administration ? 'Elegir en nombre de ' + acting?.code : 'Tu selección'} · {selected.length}/{limit}
            </h3>
            <p className="muted">
              {state.round === 1
                ? 'Primera ronda: elige un solo día. Si tocas otro, sustituye al anterior.'
                : `Segunda ronda: elige los ${limit} días de tu saldo restante y confírmalos todos juntos.`}
            </p>
            <div className="va-chips">
              {selected.map((d) => (
                <span key={d}>
                  <button onClick={() => setMonth(Number(d.slice(5, 7)) - 1)}>{dateLabel(d)}</button>
                  <button aria-label={'Quitar ' + dateLabel(d)} onClick={() => toggle(d)}>
                    ×
                  </button>
                </span>
              ))}
            </div>
            <button
              className="primary"
              disabled={!online || busy || !selected.length || selected.length !== limit}
              onClick={async () => {
                // This render's mutation keeps the version reviewed in the dialog:
                // polling must never silently confirm against a newer campaign.
                if (
                  !(await confirm(
                    <span className="confirm-choice">
                      <span className="confirm-lead">
                        {administration ? 'Adjudicar a ' + acting?.code : 'Vas a coger:'}
                      </span>
                      {selected.map((date) => (
                        <span className="confirm-cycle" key={date}>
                          <b>{dateLabel(date)}</b>
                        </span>
                      ))}
                      <span>
                        El turno pasará a la siguiente persona. La segunda ronda se abre automáticamente al terminar la
                        primera.
                      </span>
                    </span>,
                    undefined,
                    {
                      title: 'Confirmar días de VA',
                      cancelLabel: 'Volver a la selección',
                      confirmLabel: 'Confirmar días de VA',
                    },
                  ))
                )
                  return;
                if (!navigator.onLine) {
                  setError('Sin conexión. Tu selección se conserva; confirma cuando vuelva la conexión.');
                  return;
                }
                if (
                  await mutate({
                    action: view.reconstructing ? 'reconstruct_step' : 'choose',
                    personId: acting?.id,
                    dates: selected,
                  })
                ) {
                  setSelected([]);
                  setNotice('Días de VA confirmados');
                }
              }}
            >
              Revisar y confirmar
            </button>
          </div>
        )
      )}
      <details>
        <summary>Cola de turnos · {state.queue.length} pendientes</summary>
        <ol>
          {state.queue.map((id) => (
            <li key={id}>
              {state.people.find((p) => p.id === id)?.code}
              {state.deferrals[id] && ' · ' + state.deferrals[id]}
            </li>
          ))}
        </ol>
      </details>
      <h3>{administration ? 'Días confirmados' : 'Mis días VA'}</h3>
      <ul>
        {state.choices
          .filter((c) => administration || c.personId === me?.id)
          .map((c) => (
            <li key={c.personId + c.date}>
              {administration && state.people.find((p) => p.id === c.personId)?.code + ' · '}
              {dateLabel(c.date)} · Ronda {c.round}
            </li>
          ))}
      </ul>
      <p className="muted">Los cambios posteriores se solicitan a RRHH antes de publicarse el cuadrante mensual.</p>
    </section>
  );
}
