'use client';
import { Fragment, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { api } from './api-client';
import { activeMs, formatActive, type ElectionTiming } from '../domain/turn-timing';
import WaitingSince, { formatWhen, useMinuteClock } from './waiting-since';

type Summary = {
  campaignId: string;
  teamId: string;
  year: number;
  status: 'active' | 'paused' | 'complete' | null;
  frozen: boolean;
  round: number | null;
  turn: { participants: string[]; needed: number } | null;
  pendingTie: boolean;
  members: { id: string; code: string }[];
  awarded: number;
  total: number;
  timing: ElectionTiming | null;
};
type Stats = { year: number | null; campaigns: Summary[] };

function statusText(c: Summary) {
  if (c.frozen) return 'Reconstrucción del historial en curso';
  if (c.status === 'active') return c.pendingTie ? 'Empate pendiente' : 'Ronda ' + c.round + ' en curso';
  if (c.status === 'paused') return 'En pausa';
  if (c.status === 'complete') return 'Completada';
  return 'Sin iniciar';
}

/** Square-root scale: a quick turn stays visible next to a very slow one; the label gives the exact time. */
const width = (ms: number, scale: number) => Math.max(1.5, 100 * Math.sqrt(Math.min(ms, scale) / scale));

function Bar({
  label,
  ms,
  scale,
  mean,
  when: at,
  note,
  current = false,
}: {
  label: string;
  ms: number | null;
  scale: number;
  mean: number | null;
  when?: string;
  note?: string;
  current?: boolean;
}) {
  const slow = ms !== null && mean !== null && ms > 2 * mean;
  return (
    <li className={'stats-bar' + (slow ? ' slow' : '') + (current ? ' current' : '')}>
      <span className="stats-bar-label">
        <strong>{label}</strong>
        {at ? <time dateTime={at}>{formatWhen(at)}</time> : current ? <span>ahora</span> : null}
      </span>
      <span className="stats-bar-track">
        {ms !== null && <span className="stats-bar-fill" style={{ width: width(ms, scale) + '%' }} />}
        {mean !== null && <span className="stats-bar-mean" style={{ left: width(mean, scale) + '%' }} />}
      </span>
      <span className="stats-bar-value">
        {ms === null ? 'sin dato' : formatActive(ms)}
        {note && <small> · {note}</small>}
      </span>
    </li>
  );
}

function WaitingBar({
  label,
  since,
  scale,
  mean,
}: {
  label: string;
  since: string;
  scale: number;
  mean: number | null;
}) {
  const now = useMinuteClock();
  const ms = now === null ? null : activeMs(Date.parse(since), now);
  return <Bar label={label} ms={ms} scale={Math.max(scale, ms ?? 0)} mean={mean} current note="esperando" />;
}

function TeamStats({ c }: { c: Summary }) {
  const code = (id: string) => c.members.find((m) => m.id === id)?.code ?? '?';
  const codes = (ids: string[]) => ids.map(code).join(' + ');
  const timed = c.timing?.turns.filter((t) => t.activeMs !== null) ?? [];
  const mean = timed.length ? timed.reduce((sum, t) => sum + t.activeMs!, 0) / timed.length : null;
  const averages = [...(c.timing?.averages ?? [])].sort((a, b) => b.meanMs - a.meanMs);
  const turns = [...(c.timing?.turns ?? [])].reverse();
  const waiting = c.timing?.waiting;
  const scale = Math.max(1, ...timed.map((t) => t.activeMs!), waiting?.activeMs ?? 0);
  return (
    <details className="panel stats-team">
      <summary>
        <span className="stats-team-head">
          <strong>Equipo {c.teamId}</strong>
          <span className="muted">{statusText(c)}</span>
        </span>
        {c.turn && (
          <span>
            Turno de <strong>{codes(c.turn.participants)}</strong>
            {waiting && <WaitingSince since={waiting.since} prefix=" · esperando " />}
          </span>
        )}
        <span className="stats-progress" aria-label={`${c.awarded} de ${c.total} ciclos adjudicados`}>
          <span style={{ width: (c.total ? Math.min(100, (100 * c.awarded) / c.total) : 0) + '%' }} />
        </span>
        <span className="muted">
          {c.awarded}/{c.total} ciclos{mean !== null && <> · media por turno {formatActive(mean)}</>}
        </span>
      </summary>
      {averages.length > 0 && (
        <section className="stats-block" aria-label="Tiempo medio por controlador">
          <h3>Tiempo medio por controlador</h3>
          <ol className="stats-bars">
            {averages.map((a) => (
              <Bar
                key={a.memberId}
                label={code(a.memberId)}
                ms={a.meanMs}
                scale={scale}
                mean={mean}
                note={a.turns === 1 ? '1 turno' : a.turns + ' turnos'}
              />
            ))}
          </ol>
        </section>
      )}
      <section className="stats-block" aria-label="Línea temporal">
        <h3>Línea temporal</h3>
        {turns.length || waiting ? (
          <ol className="stats-bars stats-timeline">
            {waiting && c.turn && (
              <WaitingBar label={codes(c.turn.participants)} since={waiting.since} scale={scale} mean={mean} />
            )}
            {turns.map((t, i) => (
              <Fragment key={t.id}>
                {t.round !== null && t.round !== turns[i - 1]?.round && (
                  <li className="stats-round">Ronda {t.round}</li>
                )}
                <Bar
                  label={codes(t.memberIds)}
                  ms={t.activeMs}
                  scale={scale}
                  mean={mean}
                  when={t.at}
                  note={t.kind === 'defer' ? 'aplazó' : undefined}
                />
              </Fragment>
            ))}
          </ol>
        ) : (
          <p className="muted">Todavía no se ha cerrado ningún turno.</p>
        )}
        {mean !== null && (
          <p className="stats-key muted">
            <span className="stats-key-mean" /> media del equipo · <span className="stats-key-slow" /> más del doble de
            la media
          </p>
        )}
      </section>
    </details>
  );
}

/** Every team's campaign at a glance, opened on demand: nothing here interrupts anybody. */
export default function CampaignStats() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let live = true;
    api<Stats>('stats').then(
      (next) => {
        if (!live) return;
        setError('');
        setStats(next);
      },
      (e) => live && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, [reload]);
  return (
    <section className="campaign-stats">
      <div className="stats-header">
        <h2>Estado de las campañas{stats?.year ? ' ' + stats.year : ''}</h2>
        <button type="button" onClick={() => setReload((n) => n + 1)} aria-label="Actualizar">
          <RefreshCw size={16} /> Actualizar
        </button>
      </div>
      <p className="muted">
        Los tiempos no cuentan la franja de 23:00 a 9:00 (hora peninsular). Las elecciones anticipadas no aparecen.
      </p>
      {error && <p className="error">{error}</p>}
      {!stats && !error && <p className="muted">Cargando…</p>}
      {stats && !stats.campaigns.length && <p className="muted">No hay campañas abiertas.</p>}
      {stats?.campaigns.map((c) => (
        <TeamStats key={c.campaignId} c={c} />
      ))}
    </section>
  );
}
