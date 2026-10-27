'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { formatDate } from './cycle-calendar';
import { seatsLeft, splitPreferences } from './own-cycles';
import { formatWait } from './my-election-state';

// One editor moves into a modal on small screens; its draft belongs to the workspace.
export type PreferenceUsageValue = { mode: 'immediate' | 'wait' | 'manual'; waitMinutes: number };
const MAX_WAIT_MINUTES = 24 * 60;
// The usual answers get a button; «Otro…» offers only the rest, so nothing appears twice.
const WAIT_PRESETS = [30, 60, 120, 240];
const WAIT_OTHERS = Array.from({ length: MAX_WAIT_MINUTES / 15 }, (_, i) => (i + 1) * 15).filter(
  (m) => !WAIT_PRESETS.includes(m),
);
/** «Si te toca a las 10:00, tendrías hasta las 12:00»: the delay as a concrete time. */
function waitExample(minutes: number): string {
  const end = 10 * 60 + minutes,
    day = Math.floor(end / 1440),
    clock = String(Math.floor((end % 1440) / 60)).padStart(2, '0') + ':' + String(end % 60).padStart(2, '0');
  return `Cuenta desde que te toca: si te toca a las 10:00, tendrías hasta las ${clock}${day ? ' del día siguiente' : ''}.`;
}

/** Every way of applying a list in plain words, so nobody has to guess what is about to be taken. */
function PreferenceUsage({
  usage,
  setUsage,
  busy,
}: {
  usage: PreferenceUsageValue;
  setUsage: (next: PreferenceUsageValue) => void;
  busy: boolean;
}) {
  const [custom, setCustom] = useState(() => usage.mode === 'wait' && !WAIT_PRESETS.includes(usage.waitMinutes));
  const setWait = (waitMinutes: number) => setUsage({ mode: 'wait', waitMinutes });
  const option = (mode: PreferenceUsageValue['mode'], title: string, help: ReactNode) => (
    <label className={'preference-mode-option' + (usage.mode === mode ? ' is-selected' : '')}>
      <input
        type="radio"
        name="preference-mode"
        value={mode}
        disabled={busy}
        checked={usage.mode === mode}
        onChange={() =>
          setUsage(mode === 'wait' ? { mode, waitMinutes: usage.waitMinutes || 60 } : { mode, waitMinutes: 0 })
        }
      />
      <span>
        <strong>{title}</strong>
        <small>{help}</small>
      </span>
    </label>
  );
  const invalid = usage.mode === 'wait' && usage.waitMinutes < 1;
  return (
    <fieldset className="preference-mode" disabled={busy}>
      <legend>Cuando llegue tu turno</legend>
      {option(
        'immediate',
        'Elegir por mí al momento',
        'Se adjudica enseguida la primera preferencia que siga libre, sin esperar.',
      )}
      {option(
        'wait',
        'Darme un plazo para decidir',
        <>
          Te avisamos al llegar tu turno. Mientras tanto puedes elegir tú. Si no eliges a tiempo, se adjudica la primera
          preferencia que siga libre.
        </>,
      )}
      {usage.mode === 'wait' && (
        <div className="preference-wait" role="group" aria-label="Plazo para decidir">
          {/* One tap for the usual answers; the phone's own picker for anything else. */}
          <div className="preference-wait-chips">
            {WAIT_PRESETS.map((m) => (
              <button
                key={m}
                type="button"
                className="preference-wait-chip"
                aria-pressed={!custom && usage.waitMinutes === m}
                onClick={() => {
                  setCustom(false);
                  setWait(m);
                }}
              >
                {formatWait(m)}
              </button>
            ))}
            <button
              type="button"
              className="preference-wait-chip"
              aria-pressed={custom}
              onClick={() => {
                setCustom(true);
                if (WAIT_PRESETS.includes(usage.waitMinutes)) setWait(180);
              }}
            >
              Otro…
            </button>
          </div>
          {custom && (
            <label className="preference-wait-other">
              Otro plazo
              <select value={usage.waitMinutes} onChange={(e) => setWait(Number(e.target.value))}>
                {[...new Set([...WAIT_OTHERS, usage.waitMinutes])]
                  .filter((m) => m > 0 && !WAIT_PRESETS.includes(m))
                  .sort((a, b) => a - b)
                  .map((m) => (
                    <option key={m} value={m}>
                      {formatWait(m)}
                    </option>
                  ))}
              </select>
            </label>
          )}
          <small className={invalid ? 'preference-wait-error' : ''}>
            {invalid ? 'Elige un plazo.' : waitExample(usage.waitMinutes)}
          </small>
        </div>
      )}
      {option(
        'manual',
        'Elijo yo siempre',
        'La lista es solo una nota para ti: nunca se adjudica sola y la ronda espera a que elijas.',
      )}
      <small className="preference-mode-note">
        Si cuando toque no queda libre ninguna de tus preferencias, tendrás que elegir tú.
      </small>
    </fieldset>
  );
}

export default function PreferencesEditor({
  data,
  memberId,
  dates,
  setDates,
  persistent,
  setPersistent,
  usage,
  setUsage,
  labels = {},
  setLabels = () => {},
  dirty,
  busy,
  save,
  cancel,
  message,
  readOnly = false,
}: any) {
  const [mobile, setMobile] = useState(false),
    [expanded, setExpanded] = useState(false);
  const panel = useRef<HTMLElement>(null),
    review = useRef<HTMLButtonElement>(null);
  const member = data.members.find((m: any) => m.id === memberId);
  const existing = data.election.preferences.find((p: any) => p.member_id === memberId);
  // Owned and full cycles stay in place (a seat may free up) but read as skipped, not as live options.
  const ruled = !!data.election.occupancyPolicyVersion;
  // Same availability as the calendar: owned and full cycles step aside (a seat may free up) and keep their slot.
  const split = splitPreferences(
    dates,
    data.awards
      .filter((a: { member_id: string }) => a.member_id === memberId)
      .map((a: { cycle_date: string }) => a.cycle_date),
    data.result.cycles,
    data.election.cycleAvailability,
    ruled,
  );
  const ownedDates = split.owned,
    unavailableDates = split.full;
  // Only usable preferences are ranked and reordered; skipped ones keep their slot in the saved list.
  const active = split.active,
    skipped = dates.filter((date: string) => ownedDates.has(date) || unavailableDates.has(date));
  const usable = active.length;
  const cycleOf = (date: string) => data.result.cycles.find((c: { date: string }) => c.date === date);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 900px)');
    const update = () => {
      setMobile(query.matches);
      setExpanded(false);
    };
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    if (!mobile || !expanded) return;
    const app = document.querySelector<HTMLElement>('.app'),
      overflow = document.body.style.overflow;
    if (app) app.inert = true;
    document.body.style.overflow = 'hidden';
    panel.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => {
      if (app) app.inert = false;
      document.body.style.overflow = overflow;
      review.current?.focus();
    };
  }, [mobile, expanded]);
  useEffect(() => {
    if (mobile) return;
    const fit = () => {
      const element = panel.current;
      if (!element) return;
      const top = Math.max(16, element.getBoundingClientRect().top);
      element.style.maxHeight = Math.max(220, window.innerHeight - top - 16) + 'px';
    };
    fit();
    window.addEventListener('scroll', fit, { passive: true });
    window.addEventListener('resize', fit);
    return () => {
      window.removeEventListener('scroll', fit);
      window.removeEventListener('resize', fit);
      panel.current?.style.removeProperty('max-height');
    };
  }, [mobile, message, data.campaign.version]);
  // "Guardadas" must not hide that a saved list was already consumed by a turn.
  const used = !dirty && existing?.active === false;
  const status = dirty
    ? 'Cambios sin guardar'
    : used
      ? 'Preferencias ya usadas'
      : existing
        ? 'Preferencias guardadas'
        : 'Sin preferencias guardadas';
  const stateClass = 'preference-state ' + (dirty ? 'pending' : used ? 'used' : 'saved');
  // A native picker on the position number: jumping 12 → 2 is one tap on a phone, not ten.
  // Indices are positions among the usable preferences; skipped ones stay where they were.
  function reorder(next: string[]) {
    let k = 0;
    setDates(dates.map((date: string) => (skipped.includes(date) ? date : next[k++])));
  }
  function moveTo(index: number, target: number) {
    if (target === index || target < 0 || target >= active.length) return;
    const next = [...active],
      [moved] = next.splice(index, 1);
    next.splice(target, 0, moved);
    reorder(next);
  }
  function swap(index: number, direction: -1 | 1) {
    const other = index + direction;
    if (other < 0 || other >= active.length) return;
    const next = [...active];
    [next[index], next[other]] = [next[other], next[index]];
    reorder(next);
  }
  const editor = (
    <section
      ref={panel}
      className={'panel preferences-panel' + (mobile ? ' preference-sheet' : '')}
      role={mobile ? 'dialog' : undefined}
      aria-modal={mobile ? true : undefined}
      aria-labelledby="preferences-title"
      onKeyDown={(event) => {
        if (!mobile) return;
        if (event.key === 'Escape') {
          event.preventDefault();
          setExpanded(false);
        }
        if (event.key === 'Tab') {
          const controls = Array.from(
            event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)'),
          );
          const first = controls[0],
            last = controls[controls.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }
      }}
    >
      <header className="preference-editor-head">
        <div>
          <span className="eyebrow">TU LISTA ORDENADA</span>
          <h2 id="preferences-title">Preferencias de {member?.code}</h2>
        </div>
        {mobile && (
          <button
            type="button"
            className="secondary"
            onClick={() => setExpanded(false)}
            aria-label="Cerrar revisión de preferencias"
          >
            Cerrar
          </button>
        )}
      </header>
      <div className="preference-editor-body">
        {readOnly && (
          <p className="muted">
            Puedes añadir, quitar y reordenar ciclos para probar la interfaz. La campaña real no se modificará.
          </p>
        )}
        <p>La posición 1 es tu primera opción. Abajo decides qué hacer con la lista cuando llegue tu turno.</p>
        {!dates.length && (
          <div className="preference-empty">
            <strong>Empieza por tu ciclo favorito</strong>
            <p>Añade alternativas desde el calendario. Después revisa el orden y guarda tu lista.</p>
          </div>
        )}
        {existing?.active === false && dates.length > 0 && (
          <p className="preference-used-note">
            Estas preferencias ya se usaron en un turno anterior. Guárdalas de nuevo si quieres que se usen en tu
            próximo turno.
          </p>
        )}
        {!!active.length && (
          <ol className="preference-list" aria-label="Preferencias en orden de prioridad">
            {active.map((date: string, i: number) => {
              const cycle = cycleOf(date),
                position = i + 1;
              return (
                <li key={date} value={position}>
                  <select
                    className="preference-position"
                    aria-label={'Posición de ' + formatDate(date)}
                    value={position}
                    disabled={busy}
                    onChange={(e) => moveTo(i, Number(e.target.value) - 1)}
                  >
                    {active.map((_: string, k: number) => (
                      <option key={k} value={k + 1}>
                        {k + 1}
                      </option>
                    ))}
                  </select>
                  <div className="preference-date">
                    <strong>
                      {formatDate(date)} – {formatDate(cycle?.end ?? date)}
                    </strong>
                    <small>
                      {cycle?.score} puntos
                      {cycle ? ' · ' + seatsLeft(cycle, data.election.cycleAvailability, ruled) : ''}
                    </small>
                  </div>
                  <div className="preference-row-actions">
                    <button
                      type="button"
                      className="secondary"
                      aria-label={`Subir preferencia ${position}`}
                      disabled={i === 0 || busy}
                      onClick={() => swap(i, -1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      aria-label={`Bajar preferencia ${position}`}
                      disabled={i === active.length - 1 || busy}
                      onClick={() => swap(i, 1)}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      aria-label={`Quitar preferencia ${position}`}
                      disabled={busy}
                      onClick={() => setDates(dates.filter((d: string) => d !== date))}
                      title="Quitar"
                    >
                      ✕
                    </button>
                  </div>
                  <input
                    className="preference-label"
                    type="text"
                    maxLength={40}
                    disabled={busy}
                    aria-label={'Nombre de ' + formatDate(date)}
                    placeholder="Nombre opcional: Navidad, Semana Santa…"
                    value={labels[date] ?? ''}
                    onChange={(e) => setLabels({ ...labels, [date]: e.target.value })}
                  />
                </li>
              );
            })}
          </ol>
        )}
        {skipped.length > 0 && (
          <section className="preference-skipped" aria-label="Preferencias que se saltarán">
            <h3>
              Se saltarán ({skipped.length}) · {usable === 1 ? '1 utilizable' : usable + ' utilizables'}
            </h3>
            <ul>
              {skipped.map((date: string) => (
                <li key={date} className={ownedDates.has(date) ? 'is-owned' : 'is-full'}>
                  <span className="preference-skipped-date">
                    {formatDate(date)} – {formatDate(cycleOf(date)?.end ?? date)}
                  </span>
                  <span className="preference-skip-tag">{ownedDates.has(date) ? '✓ Ya adjudicado' : 'Sin cupo'}</span>
                  <button
                    type="button"
                    className="preference-skipped-remove"
                    aria-label={'Quitar ' + formatDate(date)}
                    title="Quitar"
                    disabled={busy}
                    onClick={() => setDates(dates.filter((d: string) => d !== date))}
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
            {unavailableDates.size > 0 && (
              <p className="preference-hidden">
                {unavailableDates.size === 1 ? '1 ciclo sin cupo' : unavailableDates.size + ' ciclos sin cupo'}{' '}
                actualmente: se conservan y volverán a tu lista en su posición si se libera una plaza.
              </p>
            )}
          </section>
        )}
        <PreferenceUsage usage={usage} setUsage={setUsage} busy={busy} />
      </div>
      <footer className="preference-editor-footer">
        <span className={stateClass}>{status}</span>
        <div className="preference-usage">
          <label className="preference-consent">
            <input
              type="checkbox"
              disabled={busy}
              checked={persistent}
              onChange={(e) => setPersistent(e.target.checked)}
            />{' '}
            Mantener esta lista en todas las rondas restantes
          </label>
          <small>
            {data.election.state?.automaticPaused && usage.mode !== 'manual'
              ? 'La elección automática está detenida. Guardar conserva la lista sin adjudicar hasta que el responsable la reanude.'
              : persistent
                ? 'Servirá para todos tus turnos.'
                : 'Servirá solo para tu próximo turno.'}
          </small>
        </div>
        <div className="preference-feedback" role="status" aria-live="polite" aria-atomic="true">
          {message}
        </div>
        <div className="preference-footer-actions">
          <button type="button" className="secondary" disabled={busy} onClick={cancel}>
            Cancelar
          </button>
          <button
            type="button"
            className="primary"
            disabled={
              busy ||
              readOnly ||
              (!dirty && existing?.active !== false) ||
              (usage.mode === 'wait' && usage.waitMinutes < 1)
            }
            onClick={save}
          >
            {readOnly ? 'Guardado desactivado' : busy ? 'Guardando…' : 'Guardar preferencias'}
          </button>
        </div>
      </footer>
    </section>
  );
  return (
    <>
      {mobile ? (
        <>
          <div className="preference-dock">
            <div className="preference-dock-status">
              <strong>
                {dates.length} {dates.length === 1 ? 'preferencia' : 'preferencias'}
                {usable < dates.length ? ` (${usable} utilizables)` : ''}
              </strong>
              <span className={dirty ? 'pending' : used ? 'used' : 'saved'}>{status}</span>
            </div>
            <div className="preference-dock-actions">
              <button type="button" className="secondary" disabled={busy} onClick={cancel}>
                Cancelar
              </button>
              <button
                ref={review}
                type="button"
                className="primary"
                aria-haspopup="dialog"
                aria-expanded={expanded}
                onClick={() => setExpanded(true)}
              >
                Revisar y guardar
              </button>
            </div>
            {!expanded && message && (
              <div className="preference-feedback" role="status" aria-live="polite" aria-atomic="true">
                {message}
              </div>
            )}
          </div>
          {expanded &&
            createPortal(
              <div
                className="preference-sheet-backdrop"
                onClick={(e) => {
                  if (e.target === e.currentTarget) setExpanded(false);
                }}
              >
                {editor}
              </div>,
              document.body,
            )}
        </>
      ) : (
        editor
      )}
    </>
  );
}
