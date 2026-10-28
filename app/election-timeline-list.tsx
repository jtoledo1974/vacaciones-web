'use client';
import { useState, type ReactNode } from 'react';
import { Clock } from 'lucide-react';
import { formatDate } from './cycle-calendar';
import { summarizeImpact } from './cycle-availability-ui';
import { numberTimelineCycles } from '../domain/timeline-numbering';
import type { ElectionTimelineItem } from '../domain/election-timeline-types';
import { formatActive, type ElectionTiming } from '../domain/turn-timing';
import { useMinuteClock } from './waiting-since';
import { formatLogWhen, formatLogWhenFull } from '../domain/log-when';

/** A history entry as either view sends it: the public one omits impact and warnings. */
type TimelineEvent = Partial<ElectionTimelineItem> &
  Pick<ElectionTimelineItem, 'id' | 'kind' | 'round' | 'memberIds' | 'choices' | 'deferredTurns'> & {
    automatic?: true;
  };

/**
 * When an entry happened, never written as a date that could be read as a cycle:
 * recent entries show the time, older ones a clock icon that reveals the full
 * date on hover or, on phones, on tap.
 */
function LogWhen({ at, now, took }: { at: string; now: number | null; took: number | null }) {
  const [open, setOpen] = useState(false);
  const full = formatLogWhenFull(at),
    label = formatLogWhen(at, now ?? Date.parse(at)),
    duration = took !== null ? formatActive(took) : null;
  if (label !== null)
    return (
      <time dateTime={at} title={full}>
        {label}
        {duration && <> · {duration}</>}
      </time>
    );
  return (
    <span className="election-log-old">
      <button
        type="button"
        className="election-log-clock"
        title={full}
        aria-label={'Fecha: ' + full}
        aria-expanded={open}
        onClick={() => setOpen((x) => !x)}
      >
        <Clock size={13} aria-hidden="true" />
      </button>
      {duration && <span>{duration}</span>}
      {open && (
        <time dateTime={at} className="election-log-full">
          {full}
        </time>
      )}
    </span>
  );
}

/** The election history, newest first, 40 entries at a time. `rowAction` adds a control to an entry. */
export default function ElectionTimelineList({
  timeline,
  members,
  cycles,
  previousScores,
  policyPresentation,
  rowAction,
  timing,
}: {
  timeline: TimelineEvent[];
  members: { id: string; code: string }[];
  cycles: { date: string; score?: number }[];
  previousScores?: Record<string, number>;
  policyPresentation: Parameters<typeof summarizeImpact>[1];
  rowAction?: (event: TimelineEvent) => ReactNode;
  /** Turn durations (election.timing): a hairline under each turn and its time. */
  timing?: ElectionTiming | null;
}) {
  const timed = new Map((timing?.turns ?? []).map((t) => [t.id, t]));
  const scale = Math.max(1, ...[...timed.values()].map((t) => t.activeMs ?? 0));
  const [historyLimit, setHistoryLimit] = useState(40);
  // Relative wording needs the clock; until it mounts render the time alone (no hydration mismatch).
  const now = useMinuteClock();
  const cycleNumbers = numberTimelineCycles(timeline as ElectionTimelineItem[]);
  return (
    <>
      <ol className="election-log">
        {timeline.slice(0, historyLimit).map((event) => {
          const code = (id: string) => members.find((m) => m.id === id)?.code ?? '?';
          const title =
            event.kind === 'tie'
              ? 'Sorteo de empate'
              : event.kind === 'joint'
                ? event.jointAction === 'register_joint'
                  ? 'Acuerdo de turno conjunto'
                  : 'Anulación de turno conjunto'
                : event.kind === 'defer'
                  ? code(event.memberIds[0]) + ' — Aplazamiento'
                  : event.memberIds.map(code).join(' + ');
          const turn = timed.get(event.id),
            at = turn?.at ?? (event.createdAt || null),
            // Under a minute says nothing: no duration and no bar.
            took = turn?.activeMs != null && turn.activeMs >= 60_000 ? turn.activeMs : null;
          return (
            <li key={event.id}>
              <div className="election-log-entry">
                <div className="election-log-title">
                  <b>{title}</b>
                  {event.round && <span>Ronda {event.round}</span>}
                  {at && (
                    <span className="election-log-when">
                      <LogWhen at={at} now={now} took={took} />
                      {took !== null && (
                        <span
                          className="election-log-duration"
                          title={'Tardó ' + formatActive(took) + ' (sin contar de 23:00 a 9:00)'}
                          style={{ width: (0.3 + 5.7 * Math.sqrt(took / scale)).toFixed(2) + 'em' }}
                        />
                      )}
                    </span>
                  )}
                </div>
                {event.kind === 'tie' && (
                  <p className="election-log-note">
                    {event.method === 'random' ? 'Sorteo realizado en la aplicación' : 'Sorteo externo registrado'}
                    {event.anticipated ? ' · Resuelto anticipadamente' : ''} · Orden inicial:{' '}
                    {(event.order ?? []).map(code).join(' → ')}
                  </p>
                )}
                {event.kind === 'defer' && (
                  <p className="election-log-note">
                    Turno aplazado, sin adjudicación. Acumula un ciclo para la siguiente ronda.
                  </p>
                )}
                {event.kind === 'joint' && (
                  <p className="election-log-note">
                    {event.memberIds.map(code).join(' + ')} ·{' '}
                    {event.jointAction === 'register_joint'
                      ? 'Elegirán cuando llegue el último participante de la ronda'
                      : 'Acuerdo anulado antes de consumir turnos'}
                    .
                  </p>
                )}
                {(event.kind === 'choice' || event.kind === 'legacy') && (
                  <>
                    {event.choices.map((choice, index) => {
                      const cycle = cycles.find((c) => c.date === choice.cycle_date);
                      return (
                        <div className="election-log-cycle" key={choice.member_id + '|' + choice.cycle_date}>
                          {cycleNumbers.get(event.id) && (
                            <strong className="election-cycle-number">
                              R{event.round} · {cycleNumbers.get(event.id)![index]} —{' '}
                            </strong>
                          )}
                          {event.memberIds.length > 1 ? code(choice.member_id) + ' · ' : ''}
                          {formatDate(choice.cycle_date)} · {cycle?.score ?? '—'} puntos
                        </div>
                      );
                    })}
                    {event.kind === 'legacy' && (
                      <p className="election-log-note">
                        {event.round != null
                          ? 'Adjudicación importada con ronda y orden explícitos.'
                          : 'Adjudicación importada o anterior al registro de turnos.'}
                      </p>
                    )}
                    {event.automatic && (
                      <p className="election-log-note election-log-automatic">
                        Elegido automáticamente por su lista de preferencias.
                      </p>
                    )}
                    {event.kind === 'choice' && event.memberIds.length > 1 && (
                      <p className="election-log-note">Turno conjunto de {event.memberIds.length} controladores.</p>
                    )}
                    {event.kind === 'choice' && event.deferredTurns > 0 && (
                      <p className="election-log-note">
                        Turno {event.deferredTurns === 1 ? 'doble' : 'triple'}: recupera {event.deferredTurns}{' '}
                        aplazamiento(s) anterior(es).
                      </p>
                    )}
                    {(event.warnings ?? []).map((w, i) => (
                      <p key={w.code + '-' + i} role="status" className="alert warning election-log-warning">
                        <strong>Aviso normativo:</strong> {w.message}
                      </p>
                    ))}
                    {event.impact &&
                      (() => {
                        const { highlights, details } = summarizeImpact(
                          event.impact as unknown as Parameters<typeof summarizeImpact>[0],
                          policyPresentation,
                        );
                        return (
                          <>
                            {highlights.map((line, i) => (
                              <p key={i} role="status" className="alert election-log-highlight">
                                {line}
                              </p>
                            ))}
                            {details.length > 0 && (
                              <details className="election-log-impact">
                                <summary>Otros ciclos afectados · {details.length}</summary>
                                <ul>
                                  {details.map((line, i) => (
                                    <li key={i}>{line}</li>
                                  ))}
                                </ul>
                              </details>
                            )}
                          </>
                        );
                      })()}
                    {(event.ties ?? []).map((tie) => {
                      const memberCode = code(tie.memberId),
                        previous = previousScores?.[memberCode];
                      return (
                        <p className="election-log-note election-log-tie" key={tie.memberId}>
                          Empate{previous !== undefined ? ' a ' + previous + ' puntos' : ''} · {memberCode}:{' '}
                          {tie.position}.º de {tie.total} · Orden de esta ronda: {tie.order.map(code).join(' → ')}
                        </p>
                      );
                    })}
                  </>
                )}
                {rowAction?.(event)}
              </div>
            </li>
          );
        })}
      </ol>
      {timeline.length > historyLimit && (
        <button type="button" className="secondary election-show-more" onClick={() => setHistoryLimit((n) => n + 40)}>
          Mostrar anteriores ({Math.min(40, timeline.length - historyLimit)})
        </button>
      )}
      {historyLimit > 40 && (
        <button type="button" className="secondary election-show-more" onClick={() => setHistoryLimit(40)}>
          Mostrar menos
        </button>
      )}
      {historyLimit >= timeline.length && <p className="muted">Inicio del historial · No hay eventos anteriores.</p>}
    </>
  );
}
