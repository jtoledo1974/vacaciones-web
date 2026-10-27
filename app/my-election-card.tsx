'use client';
import { useEffect, useState } from 'react';
import { Bell } from 'lucide-react';
import { formatDate } from './cycle-calendar';
import { aheadNote, formatDeadline, formatWait, remainingText, type MyElection } from './my-election-state';
import { seatsLeft } from './own-cycles';
import type { AvailabilitySnapshot } from '../domain/occupancy';

/** Early choices are discreet (domain/early-election.ts, concealPendingEarly). */
export const EARLY_DISCRETION =
  'Es discreta: nadie, tampoco la administración, la verá hasta que llegue tu turno. Entonces aparecerá como una elección normal.';

/** How the controller's saved list will act, in one sentence. */
export function listSentence(list: MyElection['list'], turn = false): string {
  if (list.state === 'none') return 'No tienes preferencias guardadas: en tu turno tendrás que elegir tú.';
  if (list.state === 'used') return 'Tus preferencias ya se usaron: en tu próximo turno no se elegirá de ellas.';
  if (list.state === 'manual') return 'Tu lista es solo una nota: en tu turno elegirás tú.';
  if (list.state === 'paused') return 'Preferencias guardadas, pero la elección automática está detenida.';
  if (turn && list.mode === 'wait') return 'Si no eliges a tiempo, se elegirá de tus preferencias.';
  const turns = list.state === 'active-all' ? 'En cada turno' : 'En tu próximo turno';
  if (list.mode === 'wait')
    return `${turns} tendrás ${formatWait(list.waitMinutes)} para elegir; si no lo haces, se elegirá de tus preferencias.`;
  return list.state === 'active-all'
    ? 'En todos tus turnos se elegirá automáticamente de tus preferencias.'
    : 'En tu próximo turno se elegirá automáticamente de tus preferencias.';
}
export type AutoPick = { id: string; round: number; dates: { date: string; end: string }[] };
/** The server's account of what the turn holder's list will do (election.listPlan). */
export type ListPlan = {
  memberId: string;
  mode: 'immediate' | 'wait';
  waitMinutes: number;
  deadline: string | null;
  paused: boolean;
  dates: string[] | null;
};

const listShort: Record<MyElection['list']['state'], string> = {
  none: 'sin preferencias',
  'active-next': 'preferencias para tu próximo turno',
  'active-all': 'preferencias para todos tus turnos',
  used: 'preferencias ya usadas',
  paused: 'elección automática detenida',
  manual: 'lista solo como nota',
};

const ordinal = (n: number) => n + 'ª';
/** «(tu 2ª preferencia; la 1ª no está disponible)», so nobody wonders why it is not the first. */
function positionsNote(dates: string[], entries: MyElection['list']['entries']): string {
  const positions = dates
    .map((d) => entries.find((e) => e.date === d)?.position)
    .filter((p): p is number => !!p)
    .sort((a, b) => a - b);
  if (!positions.length) return '';
  if (positions.every((p, i) => p === i + 1))
    return positions.length === 1 ? ' (tu 1ª preferencia)' : ' (tus primeras preferencias)';
  if (positions.length === 1)
    return ` (tu ${ordinal(positions[0])} preferencia; ${positions[0] === 2 ? 'la 1ª no está disponible' : 'las anteriores no están disponibles'})`;
  return ` (tus preferencias ${positions.map(ordinal).join(', ')}; las demás no están disponibles)`;
}

/** «Si no haces nada…»: what the waiting list will take and when, recalculated as cycles fill. */
function WaitingPlan({
  plan,
  list,
  cycles,
}: {
  plan: ListPlan;
  list: MyElection['list'];
  cycles: { date: string; end: string }[];
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  if (plan.paused)
    return (
      <p className="my-election-plan">
        La elección automática está detenida: tus preferencias no se aplicarán solas. Elige tú.
      </p>
    );
  if (!plan.dates)
    return (
      <p className="my-election-plan is-empty">
        <strong>Ninguna de tus preferencias sigue libre.</strong> Tienes que elegir tú; la ronda espera.
      </p>
    );
  const what = plan.dates
    .map((d) => {
      const c = cycles.find((x) => x.date === d),
        label = list.entries.find((e) => e.date === d)?.label;
      return (label ? label + ' · ' : '') + formatDate(d) + ' – ' + formatDate(c?.end ?? d);
    })
    .join(' + ');
  if (!plan.deadline)
    return (
      <p className="my-election-plan">
        Tienes {formatWait(plan.waitMinutes)} para elegir. Si no lo haces, se te adjudicará <strong>{what}</strong>
        {positionsNote(plan.dates, list.entries)}.
      </p>
    );
  const left = remainingText(plan.deadline, now);
  return (
    <div className="my-election-plan" role="status">
      <p>
        Si no haces nada, a las <strong>{formatDeadline(plan.deadline, now)}</strong> se te adjudicará{' '}
        <strong>{what}</strong>
        {positionsNote(plan.dates, list.entries)}.
      </p>
      <span className="my-election-countdown">{left ?? 'Plazo cumplido: aplicando tus preferencias…'}</span>
    </div>
  );
}

/** On one's turn: every listed cycle, by name, with whether it can be chosen right now
 * (the same check as the calendar), so a list kept as a note is usable at a glance. */
function ListNow({
  entries,
  available,
  seats,
  onPick,
}: {
  entries: MyElection['list']['entries'];
  available: string[];
  /** Seats left per cycle, as the calendar counts them. */
  seats: (date: string) => string;
  onPick?: (date: string) => void;
}) {
  const can = entries.filter((e) => !e.mine && available.includes(e.date)).length;
  return (
    <div className="my-election-now">
      <strong>
        Tu lista ahora · {can === 0 ? 'ninguna disponible' : can === 1 ? '1 disponible' : can + ' disponibles'} de{' '}
        {entries.length}
      </strong>
      <ol>
        {entries.map((e) => {
          const state = e.mine ? 'mine' : available.includes(e.date) ? 'ok' : 'gone';
          return (
            <li key={e.date} className={'is-' + state}>
              <span className="my-election-now-mark" aria-hidden="true">
                {state === 'ok' ? '✓' : state === 'mine' ? '●' : '✕'}
              </span>
              <span className="my-election-now-text">
                {e.label && <span className="preference-name">{e.label}</span>}
                {formatDate(e.date)} – {formatDate(e.end)}
                <small>
                  {e.score} pt ·{' '}
                  {state === 'ok'
                    ? 'Disponible · ' + seats(e.date)
                    : state === 'mine'
                      ? 'Ya es tuyo'
                      : 'Ya no disponible'}
                </small>
              </span>
              {state === 'ok' && onPick && (
                <button
                  type="button"
                  className="secondary"
                  onClick={() => onPick(e.date)}
                  aria-label={'Elegir ' + (e.label || formatDate(e.date))}
                >
                  Elegir
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export type EarlyElection = {
  guaranteed: string[];
  indeterminate: boolean;
  choices: { awardId: string; date: string; cancellable: boolean }[];
};

/** The controller's own situation, first on the page: turn, cycles and list.
 * compact: a one-line summary that unfolds, for managers running the table while it is not their turn. */
export default function MyElectionCard({
  me,
  autoPick,
  plan,
  cycles = [],
  availability,
  ruled = false,
  available,
  onPick,
  onChoose,
  onList,
  onSimulate,
  early,
  onEarly,
  onCancelEarly,
  compact = false,
}: {
  me: MyElection;
  autoPick?: AutoPick | null;
  plan?: ListPlan | null;
  cycles?: { date: string; end: string; occupied: number; max: number }[];
  /** Occupancy engine output, for seats left; `ruled` when the campaign has one. */
  availability?: AvailabilitySnapshot | null;
  ruled?: boolean;
  available?: string[];
  onPick?: (date: string) => void;
  onChoose: () => void;
  onList: () => void;
  onSimulate?: () => void;
  /** Early election: cycles secured for the viewer now, and early choices already made. */
  early?: EarlyElection | null;
  onEarly?: () => void;
  onCancelEarly?: (awardId: string, date: string) => void;
  compact?: boolean;
}) {
  // An automatic pick stays visible until dismissed on this device: it may have happened while away.
  const [dismissed, setDismissed] = useState(true);
  useEffect(() => {
    try {
      setDismissed(!autoPick || localStorage.getItem('vacaciones_auto_seen') === autoPick.id);
    } catch {
      setDismissed(!autoPick);
    }
  }, [autoPick?.id]);
  function dismiss() {
    setDismissed(true);
    try {
      if (autoPick) localStorage.setItem('vacaciones_auto_seen', autoPick.id);
    } catch {
      /* Solo en esta sesión. */
    }
  }
  const turn = me.phase === 'my-turn';
  const headline = turn
    ? 'Es tu turno'
    : me.phase === 'waiting' /* turnsAhead includes whoever is choosing right now. */
      ? me.turnsAhead !== null && me.turnsAhead <= 1
        ? 'Eres el siguiente'
        : me.turnsAhead !== null
          ? `Faltan ${me.turnsAhead} turnos para el tuyo`
          : 'Esperando tu turno'
      : me.phase === 'paused'
        ? 'La elección está en pausa'
        : me.phase === 'not-started'
          ? 'La elección aún no ha empezado'
          : 'Ya tienes todas tus vacaciones';
  const sub = turn
    ? `Elige ${me.needed === 1 ? '1 ciclo' : me.needed + ' ciclos'} en el calendario.`
    : me.phase === 'waiting' && me.turnsAhead !== null
      ? 'Estimación: los turnos conjuntos y aplazamientos pueden cambiarla.'
      : '';
  const note = aheadNote(me);
  const lost = me.list.unavailable;
  const body = (
    <>
      <div className="my-election-head">
        <div>
          <span className="my-election-kicker">MI ELECCIÓN{me.round ? ` · RONDA ${me.round}` : ''}</span>
          <h2>{headline}</h2>
          {sub && <p>{sub}</p>}
        </div>
        {turn && (
          <button type="button" className="primary my-election-cta" onClick={onChoose}>
            Elegir ahora
          </button>
        )}
      </div>
      {note && <p className="my-election-soon">{note}</p>}
      {!turn && early && early.guaranteed.length > 0 && (
        <div className="my-election-early" role="status">
          <div>
            <strong>Algunos ciclos de vacaciones ya están disponibles para ti</strong>
            <span>
              Aunque todavía no sea tu turno, puedes solicitar alguno de los ciclos disponibles.{' '}
              {early.guaranteed.length === 1
                ? 'Hay 1 ciclo asegurado, marcado en el calendario.'
                : `Hay ${early.guaranteed.length} ciclos asegurados, marcados en el calendario.`}
            </span>
            <span className="my-election-early-discreet">{EARLY_DISCRETION}</span>
          </div>
          {onEarly && (
            <button type="button" className="primary" onClick={onEarly}>
              Elegir por adelantado
            </button>
          )}
        </div>
      )}
      {early && early.choices.length > 0 && (
        <div className="my-election-row my-election-early-done">
          <strong>Elegido por adelantado</strong>
          <span className="my-election-early-discreet">{EARLY_DISCRETION}</span>
          <div className="my-election-chips">
            {early.choices.map((choice) => (
              <span key={choice.awardId}>
                {formatDate(choice.date)} – {formatDate(cycles.find((c) => c.date === choice.date)?.end ?? choice.date)}
                {choice.cancellable && onCancelEarly && (
                  <button
                    type="button"
                    className="my-election-early-undo"
                    onClick={() => onCancelEarly(choice.awardId, choice.date)}
                  >
                    Anular
                  </button>
                )}
              </span>
            ))}
          </div>
        </div>
      )}
      {turn && plan?.mode === 'wait' && <WaitingPlan plan={plan} list={me.list} cycles={cycles} />}
      {turn && available && me.list.entries.length > 0 && (
        <ListNow
          entries={me.list.entries}
          available={available}
          seats={(date) => {
            const c = cycles.find((x) => x.date === date);
            return c ? seatsLeft(c, availability, ruled) : '';
          }}
          onPick={onPick}
        />
      )}
      {autoPick && !dismissed && (
        <div className="my-election-auto" role="status">
          <span>
            <strong>Se ha elegido por ti de tus preferencias:</strong>{' '}
            {autoPick.dates.map((d) => formatDate(d.date) + ' – ' + formatDate(d.end)).join(' + ')} · ronda{' '}
            {autoPick.round}.
          </span>
          <button type="button" className="secondary" onClick={dismiss}>
            Entendido
          </button>
        </div>
      )}
      <div className="my-election-row">
        <strong>
          Mis vacaciones · {me.cycles.length}/{me.entitlement}
        </strong>
        {me.cycles.length ? (
          <div className="my-election-chips">
            {me.cycles.map((c) => (
              <span key={c.date}>
                {formatDate(c.date)} – {formatDate(c.end)}
              </span>
            ))}
          </div>
        ) : (
          <span className="my-election-quiet">Todavía ninguna.</span>
        )}
      </div>
      <div className={'my-election-row my-election-list is-' + me.list.state}>
        <div>
          <strong>{listSentence(me.list, turn)}</strong>
          {me.list.entries.length > 0 && (
            <span className="my-election-quiet">
              {me.list.entries.length === 1 ? '1 opción' : me.list.entries.length + ' opciones'}
              {lost ? ` · ${lost} sin plazas` : ''}
              {me.list.firstViable ? ` · primera disponible: ${formatDate(me.list.firstViable)}` : ''}
            </span>
          )}
        </div>
        <button type="button" className="secondary" onClick={onList}>
          {me.list.state === 'none'
            ? 'Preparar mis preferencias'
            : me.list.state === 'used'
              ? 'Reactivar mis preferencias'
              : 'Revisar mis preferencias'}
        </button>
      </div>
      <a className="my-election-notify" href="/notificaciones">
        <Bell size={16} aria-hidden="true" />
        Avísame cuando me toque
      </a>
      {onSimulate && me.phase === 'waiting' && (
        <button type="button" className="secondary my-election-sim" onClick={onSimulate}>
          ¿Qué se me bloquea? Simular
        </button>
      )}
    </>
  );
  if (compact)
    return (
      <details
        className="panel my-election my-election-compact"
        aria-label="Mi elección"
        open={(!!autoPick && !dismissed) || (!!onEarly && !turn && (early?.guaranteed.length ?? 0) > 0)}
      >
        <summary>
          <span className="my-election-kicker">Tu elección</span>
          <span>
            {headline} · {me.cycles.length}/{me.entitlement} · {listShort[me.list.state]}
          </span>
        </summary>
        {body}
      </details>
    );
  return (
    <section className={'panel my-election' + (turn ? ' is-my-turn' : '')} aria-label="Mi elección">
      {body}
    </section>
  );
}
