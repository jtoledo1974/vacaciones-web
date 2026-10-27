'use client';
import { formatDate } from './cycle-calendar';
import { formatDeadline, formatWait } from './my-election-state';

type QueueEntry = {
  memberId: string;
  mode: 'immediate' | 'wait' | 'manual' | 'none';
  waitMinutes: number;
  current: boolean;
};
type Chain = {
  applied: { memberId: string; dates: string[] }[];
  stop: { memberId: string | null; reason: string; waitMinutes?: number };
};

const modeLabel = (e: QueueEntry) =>
  e.mode === 'immediate'
    ? 'Automático'
    : e.mode === 'wait'
      ? 'Espera ' + formatWait(e.waitMinutes)
      : e.mode === 'manual'
        ? 'Elige a mano · lista como nota'
        : 'Elige a mano · sin lista';

function stopSentence(stop: Chain['stop'], code: (id: string) => string): string {
  const who = stop.memberId ? code(stop.memberId) : '';
  switch (stop.reason) {
    case 'wait':
      return `Se parará en ${who}: tendrá ${formatWait(stop.waitMinutes ?? 0)} para elegir antes de que se apliquen sus preferencias.`;
    case 'manual':
      return `Se parará en ${who}, que elige a mano.`;
    case 'no-option':
      return `Se parará en ${who}: ninguna de sus preferencias sigue libre y tendrá que elegir a mano.`;
    case 'joint':
      return `Se parará en el turno conjunto de ${who}.`;
    case 'tie':
      return 'Se parará en un empate pendiente de sorteo.';
    case 'complete':
      return 'Con esto se completaría la elección.';
    default:
      return 'Después podrían aplicarse más preferencias.';
  }
}

/**
 * For managers: who is still to choose in this round and how each saved list will act,
 * plus what resuming would award right now. Useful above all while the election is
 * paused and run in parallel by the traditional method.
 */
export default function RoundQueuePanel({ data }: { data: any }) {
  const election = data.election,
    queue: QueueEntry[] | null = election.queue,
    chain: Chain | null = election.chain;
  if (!queue?.length) return null;
  const state = election.state,
    paused = state?.status === 'paused' || !!state?.automaticPaused;
  const code = (id: string) => data.members.find((m: any) => m.id === id)?.code ?? '?';
  const end = (date: string) => data.result.cycles.find((c: any) => c.date === date)?.end ?? date;
  const plan = election.listPlan;
  const automatic = queue.filter((e) => e.mode === 'immediate' || e.mode === 'wait').length;
  return (
    <details className="panel round-queue" aria-label="Quién falta en esta ronda" open={paused}>
      <summary>
        <span className="eyebrow">QUIÉN FALTA EN ESTA RONDA</span>
        <span className="round-queue-summary">
          {queue.length === 1 ? '1 persona' : queue.length + ' personas'} ·{' '}
          {automatic === 0
            ? 'nadie tiene preferencias que se apliquen solas'
            : automatic === 1
              ? '1 con preferencias que se aplican solas'
              : automatic + ' con preferencias que se aplican solas'}
        </span>
      </summary>
      {chain && (
        <div className={'round-queue-chain' + (paused ? ' is-paused' : '')} role="status">
          <strong>{paused ? 'Si reanudas ahora:' : 'Próximos pasos automáticos:'}</strong>
          {chain.applied.length > 0 ? (
            <ol>
              {chain.applied.map((a) => (
                <li key={a.memberId}>
                  <span className="round-queue-code">{code(a.memberId)}</span> →{' '}
                  {a.dates.map((d) => formatDate(d) + ' – ' + formatDate(end(d))).join(' + ')}
                </li>
              ))}
            </ol>
          ) : (
            <p>No se adjudicará nada automáticamente.</p>
          )}
          <p>{stopSentence(chain.stop, code)}</p>
        </div>
      )}
      <ol className="round-queue-list">
        {queue.map((e) => (
          <li key={e.memberId} className={e.current ? 'is-current' : ''}>
            <span className="round-queue-code">{code(e.memberId)}</span>
            {e.current && <span className="round-queue-now">{paused ? 'Siguiente' : 'Elige ahora'}</span>}
            <span className={'round-queue-mode is-' + e.mode}>{modeLabel(e)}</span>
            {e.current && !paused && plan?.memberId === e.memberId && plan.mode === 'wait' && plan.deadline && (
              <small className="round-queue-deadline">Plazo hasta las {formatDeadline(plan.deadline)}</small>
            )}
          </li>
        ))}
      </ol>
      <p className="muted round-queue-note">
        Solo ves cómo actuará cada lista, no los ciclos que contiene. Al reanudar, quien tenga un plazo empieza a
        contarlo desde ese momento.
      </p>
    </details>
  );
}
