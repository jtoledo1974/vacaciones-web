'use client';
import { useEffect, useRef, useState } from 'react';
import CycleCalendar, { formatDate } from './cycle-calendar';
import { ownCycles } from './own-cycles';
import { orderAwardsBySelection } from '../domain/award-display-order';
import { api } from './api-client';

import type { PolicyPresentation } from '../domain/occupancy';

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const call = (cid: string, body?: any) =>
  api('personal-simulation/' + cid, body === undefined ? {} : { body }, 'No se pudo actualizar la simulación');

/** Plain-language counter: how many permits every legal completion already needs. */
function permitLine(p: any, presentation: PolicyPresentation | null) {
  const label = presentation?.permits[p.kind],
    name = label?.name ?? p.kind;
  if (p.used === null) return { name, text: 'sin calcular', left: null };
  return { name, text: p.used + ' de ' + p.limit + (label?.suffix ?? ''), left: p.limit - p.used };
}

/**
 * The controller's private simulator. One tap per cycle: the turn is recorded
 * as soon as it has all its cycles, with the real rules, and «Deshacer» removes
 * the last simulated turn. Nothing here reaches the real election.
 */
export default function PersonalSimulator({ data, onExit }: { data: any; onExit: () => void }) {
  const cid = data.campaign.id,
    presentation: PolicyPresentation | null = data.election?.policyPresentation ?? null;
  const [sim, setSim] = useState<any>(null),
    [picked, setPicked] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const lock = useRef(false);
  const code = (id: string | null | undefined) => data.members.find((m: any) => m.id === id)?.code ?? '?';
  function apply(next: any) {
    setSim(next);
    setPicked([]);
    if (next.notice) setNotice(next.notice);
    else if (next.replaced)
      setNotice(
        next.replaced === 1
          ? 'Una elección real ha sustituido a tu primer turno simulado.'
          : next.replaced + ' elecciones reales han sustituido a tus primeros turnos simulados.',
      );
  }
  async function run(body?: any) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      apply(await call(cid, body));
    } catch (e: any) {
      setError(e.message);
      setPicked([]);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  // Reload when the real election moves: real decisions replace simulated ones.
  useEffect(() => {
    void run();
  }, [cid, data.campaign.version]);

  const turn = sim?.turn;
  function clickCycle(c: any) {
    if (busy || !turn?.memberId) return;
    setError('');
    const next = picked.includes(c.date) ? picked.filter((d) => d !== c.date) : [...picked, c.date];
    if (next.length < turn.needed) {
      setPicked(next);
      return;
    }
    setPicked(next);
    // A joint turn takes its cycles in the participants' order.
    let at = 0;
    const entries = turn.participants.map((id: string) => {
      const n = turn.requiredByMember[id] ?? 1;
      const dates = next.slice(at, at + n);
      at += n;
      return { member_id: id, dates };
    });
    void run({ action: 'add', entries });
  }

  if (!sim)
    return (
      <section className="panel personal-sim" aria-label="Simulador personal">
        <p role="status">{error || 'Cargando tu simulación…'}</p>
        <button type="button" className="secondary" onClick={onExit}>
          Volver al calendario
        </button>
      </section>
    );
  if (!sim.available)
    return (
      <section className="panel personal-sim" aria-label="Simulador personal">
        <h2>Simulador personal</h2>
        <p>El simulador está disponible mientras la elección está en curso.</p>
        <button type="button" className="secondary" onClick={onExit}>
          Volver al calendario
        </button>
      </section>
    );

  const allAwards = sim.awards as { member_id: string; cycle_date: string; simulated: boolean }[];
  // Preserve actual choice order for the real awards; append private simulated choices in step order.
  const simAwards = [
    ...orderAwardsBySelection(
      allAwards.filter((a) => !a.simulated),
      data.election?.timeline,
    ),
    ...allAwards.filter((a) => a.simulated),
  ];
  const cycles = data.result.cycles.map((c: any) => ({
    ...c,
    occupied: simAwards.filter((a) => a.cycle_date === c.date).length,
  }));
  const steps = sim.steps as { entries: { member_id: string; dates: string[] }[] }[];
  const stepLabel = (i: number) =>
    'Turno simulado ' +
    (i + 1) +
    ': ' +
    steps[i].entries.map((e) => code(e.member_id) + ' · ' + e.dates.map(formatDate).join(' + ')).join(' | ');
  const mine = turn?.participants?.includes(sim.memberId);
  const who =
    turn?.participants?.length > 1 ? turn.participants.map(code).join(' + ') : mine ? 'Tú' : code(turn?.memberId);
  const blocked = (sim.blocked as any[]).filter((b) => b.status === 'blocked');
  const unsure = (sim.blocked as any[]).filter((b) => b.status === 'indeterminate');
  const caused = blocked.filter((b) => b.causedBy !== null),
    already = blocked.filter((b) => b.causedBy === null);
  const permitsByPeriod = [0, 1, 2].map((period) => (sim.permits as any[]).filter((p) => p.period === period));

  return (
    <>
      <div className="personal-sim-banner" role="note">
        <strong>Simulación personal</strong>
        <span>Solo la ves tú. No cambia nada del reparto real ni usa las preferencias de nadie.</span>
      </div>
      {notice && (
        <div className="alert warning personal-sim-notice" role="status">
          <span>{notice}</span>
          <button type="button" className="secondary" onClick={() => setNotice('')}>
            Entendido
          </button>
        </div>
      )}
      <section className="panel personal-sim personal-sim-turn" aria-label="Turno simulado">
        <span className="eyebrow">
          {turn?.complete
            ? 'REPARTO COMPLETO'
            : turn?.pendingTie
              ? 'EMPATE PENDIENTE'
              : 'RONDA ' + turn?.round + ' · SIMULADA'}
        </span>
        <h2>
          {turn?.complete
            ? 'Has simulado el reparto completo'
            : turn?.pendingTie
              ? 'Hay un empate pendiente de sorteo: no se puede simular más allá'
              : `${who} ${mine && turn.participants.length === 1 ? 'eliges' : 'elige'} ${turn.needed === 1 ? '1 ciclo' : turn.needed + ' ciclos'}`}
        </h2>
        {turn?.memberId && (
          <p className="muted">
            Pulsa {turn.needed === 1 ? 'el ciclo que crees que elegirá' : 'los ciclos que crees que elegirá'}. Se
            registra al instante con las normas reales.
            {picked.length > 0 && turn.needed > 1
              ? ` Llevas ${picked.length}/${turn.needed}: ${picked.map(formatDate).join(' + ')}.`
              : ''}
          </p>
        )}
        {error && (
          <p className="alert warning" role="alert">
            {error}
          </p>
        )}
        {busy && (
          <p className="election-thinking-inline" role="status">
            <span className="election-thinking-spinner" aria-hidden="true" />
            Aplicando las normas…
          </p>
        )}
        <div className="button-row">
          <button
            type="button"
            className="secondary"
            disabled={busy || !steps.length}
            onClick={() => void run({ action: 'undo' })}
          >
            ↶ Deshacer
          </button>
          <button
            type="button"
            className="secondary"
            disabled={busy || !steps.length}
            onClick={() => void run({ action: 'clear' })}
          >
            Borrar simulación
          </button>
          <button type="button" className="secondary" onClick={onExit}>
            Salir
          </button>
        </div>
      </section>
      <div className="election-layout">
        <div className="election-calendar-wrap">
          <CycleCalendar
            year={data.campaign.year}
            ruled
            cycles={cycles}
            selected={picked}
            onSelect={clickCycle}
            busy={busy}
            awards={simAwards as any}
            members={data.members}
            order={[]}
            availability={sim.availability}
            glossary
            highlighted={simAwards.filter((a) => a.simulated).map((a) => a.cycle_date)}
            notForMe={blocked.map((b) => b.cycle)}
            {...ownCycles(sim.memberId, simAwards, data.election?.preferences)}
          />
        </div>
        <aside className="election-side">
          <section className="panel personal-sim" aria-label="Ciclos bloqueados para mí">
            <h3>Ciclos bloqueados para ti</h3>
            {sim.remaining === 0 ? (
              <p>Con esta simulación ya tendrías todos tus ciclos.</p>
            ) : !blocked.length ? (
              <p>Ningún ciclo queda bloqueado para ti.</p>
            ) : (
              <>
                {caused.length > 0 && (
                  <ul className="personal-sim-list">
                    {caused.map((b) => (
                      <li key={b.cycle}>
                        <strong>{formatDate(b.cycle)}</strong> · {b.reasons[0]?.message ?? 'Bloqueado'}
                        <small>
                          Lo bloquea el turno simulado {b.causedBy + 1} (
                          {steps[b.causedBy]?.entries.map((e) => code(e.member_id)).join(' + ')}).
                        </small>
                      </li>
                    ))}
                  </ul>
                )}
                {already.length > 0 && (
                  <details>
                    <summary>Ya bloqueados en el reparto real · {already.length}</summary>
                    <ul className="personal-sim-list">
                      {already.map((b) => (
                        <li key={b.cycle}>
                          <strong>{formatDate(b.cycle)}</strong> · {b.reasons[0]?.message ?? 'Bloqueado'}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </>
            )}
            {unsure.length > 0 && (
              <p className="muted">
                {unsure.length === 1 ? '1 ciclo' : unsure.length + ' ciclos'} sin confirmar: el motor no ha terminado de
                comprobarlos.
              </p>
            )}
          </section>
          <section className="panel personal-sim" aria-label="Extracupos">
            <h3>Extracupos</h3>
            <p className="muted">
              Los que el reparto ya necesita como mínimo, sea cual sea el orden en que se elija. Una ampliación a cuatro
              puede usarse como ampliación a tres.
            </p>
            <dl className="personal-sim-permits">
              {permitsByPeriod.map((list, period) => (
                <div key={period}>
                  <dt>{capitalize(presentation?.periodNames[period] ?? 'Periodo')}</dt>
                  {list.map((p) => {
                    const l = permitLine(p, presentation);
                    return (
                      <dd key={p.kind} className={l.left === 0 ? 'is-exhausted' : ''}>
                        <span>{l.name}</span>
                        <b>{l.text}</b>
                      </dd>
                    );
                  })}
                </div>
              ))}
            </dl>
          </section>
          {steps.length > 0 && (
            <section className="panel personal-sim" aria-label="Turnos simulados">
              <h3>Tus turnos simulados · {steps.length}</h3>
              <ol className="personal-sim-steps">
                {steps.map((_, i) => (
                  <li key={i}>{stepLabel(i).replace(/^Turno simulado \d+: /, '')}</li>
                ))}
              </ol>
              <p className="muted">
                Cuando avance la elección real, cada elección sustituye por orden a la simulada. Si deja de encajar, la
                simulación se borra.
              </p>
            </section>
          )}
        </aside>
      </div>
    </>
  );
}
