'use client';
import { useEffect, useState } from 'react';
import { useConfirmation } from './confirmation';

function label(action: string) {
  return (
    (
      {
        choose: 'Elección individual',
        choose_joint: 'Elección conjunta',
        advance: 'Adjudicación automática',
        defer: 'Aplazamiento',
        resolve_tie: 'Resolución de empate',
        reconstruction_step: 'Elección reconstruida',
      } as Record<string, string>
    )[action] ?? action
  );
}
const dateText = (date: string) =>
  date
    ? new Date(date + 'T12:00:00').toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' })
    : '—';
export default function ReconstructionPanel({ data, busy, act }: any) {
  const confirm = useConfirmation(),
    r = data.election.reconstruction;
  const code = (id: string) => data.members.find((m: any) => m.id === id)?.code ?? '?';
  const [mode, setMode] = useState('preference'),
    [manualKind, setManualKind] = useState('choose');
  const [selected, setSelected] = useState<string[]>([]),
    [entries, setEntries] = useState<Record<string, string[]>>({}),
    [order, setOrder] = useState<string[]>([]);
  const choice = r?.current,
    stepKey = (r?.progress ?? 0) + '|' + (choice?.round ?? '') + '|' + (choice?.memberId ?? '');
  useEffect(() => {
    setMode(choice?.historicalPreference ? 'preference' : choice?.originalPossible ? 'original' : 'manual');
    setManualKind(
      choice?.pendingTie ? 'resolve_tie' : (choice?.participants?.length ?? 0) > 1 ? 'choose_joint' : 'choose',
    );
    setSelected([]);
    setEntries({});
    setOrder([]);
  }, [stepKey]);
  // The history launches reconstruction; this editor only exists during a session.
  if (!r?.active) return null;
  const available = choice?.available ?? [];
  const originalKind =
    choice?.originalAction === 'defer'
      ? 'defer'
      : choice?.originalAction === 'resolve_tie'
        ? 'resolve_tie'
        : (choice?.participants?.length ?? 0) > 1
          ? 'choose_joint'
          : 'choose';
  const canSend =
    mode === 'preference'
      ? !!choice?.historicalPreference
      : mode === 'original'
        ? !!choice?.originalPossible
        : manualKind === 'defer'
          ? !!choice?.memberId && choice?.participants?.length === 1
          : manualKind === 'resolve_tie'
            ? !!choice?.pendingTie && order.length === choice.pendingTie.length
            : manualKind === 'choose_joint'
              ? choice?.participants?.length > 1 &&
                choice.participants.every((id: string) => (entries[id] ?? []).length === choice.requiredByMember[id])
              : selected.length === choice?.needed;
  async function commit() {
    const kind = mode === 'original' ? originalKind : mode === 'preference' ? 'choose' : manualKind;
    await act(
      {
        action: 'reconstruction_step',
        kind,
        mode,
        ...(mode === 'manual'
          ? {
              dates: selected,
              entries: (choice?.participants ?? []).map((id: string) => ({ member_id: id, dates: entries[id] ?? [] })),
              order,
            }
          : {}),
      },
      'Decisión reconstruida',
    );
  }
  const impact = (r?.impact ?? []) as any[];
  const originalText =
    choice?.originalChoice
      ?.flatMap((entry: any) => entry.dates.map((date: string) => code(entry.member_id) + ' ' + dateText(date)))
      .join(' · ') || label(choice?.originalAction ?? 'Sin elección histórica');
  return (
    <section className="panel reconstruction-panel" aria-label="Reconstrucción guiada">
      <header className="reconstruction-heading">
        <span className="eyebrow">
          EQUIPO {data.campaign.team_id} · {choice?.round ? 'RONDA ' + choice.round : 'REVISIÓN FINAL'}
        </span>
        <p>
          {r.progress} decisiones reconstruidas · {r.total} anteriores como referencia
        </p>
        <progress
          aria-label="Decisiones reconstruidas"
          max={Math.max(1, r.total)}
          value={Math.min(r.progress, r.total)}
        />
      </header>
      <div className="reconstruction-body">
        {choice && r.status === 'active' && (
          <div className="reconstruction-step">
            <h2>
              {choice.pendingTie
                ? 'Empate pendiente'
                : choice.participants?.map(code).join(' + ') + ' · Elegir ' + choice.needed + ' ciclo(s)'}
            </h2>
            <p className="muted reconstruction-consult">Consulta al controlador antes de registrar su decisión.</p>
            <fieldset className="reconstruction-decisions">
              <legend>Decisión del administrador</legend>
              {!!choice.historicalPreference && (
                <label>
                  <input
                    type="radio"
                    name="reconstruction-decision"
                    checked={mode === 'preference'}
                    onChange={() => setMode('preference')}
                  />
                  <span>
                    Aplicar preferencia histórica válida
                    <small>
                      <strong>Mejor preferencia histórica:</strong>{' '}
                      {choice.historicalPreference.map(dateText).join(' + ')}
                    </small>
                  </span>
                </label>
              )}
              {choice.originalPossible && (
                <label>
                  <input
                    type="radio"
                    name="reconstruction-decision"
                    checked={mode === 'original'}
                    onChange={() => setMode('original')}
                  />
                  <span>
                    Recuperar elección anterior<small>{originalText} · Sigue siendo posible</small>
                  </span>
                </label>
              )}
              <label>
                <input
                  type="radio"
                  name="reconstruction-decision"
                  checked={mode === 'manual'}
                  onChange={() => setMode('manual')}
                />{' '}
                Registrar otra decisión
              </label>
            </fieldset>
            {mode === 'manual' && (
              <div className="reconstruction-manual">
                {choice.pendingTie ? (
                  <>
                    <p>Registra el resultado del sorteo, en el orden de prioridad.</p>
                    <div className="button-row">
                      {choice.pendingTie
                        .filter((id: string) => !order.includes(id))
                        .map((id: string) => (
                          <button
                            className="secondary"
                            key={id}
                            disabled={busy}
                            onClick={() => setOrder([...order, id])}
                          >
                            {code(id)}
                          </button>
                        ))}
                      <button className="secondary" onClick={() => setOrder(order.slice(0, -1))}>
                        Quitar último
                      </button>
                    </div>
                    <p>{order.map(code).join(' → ') || 'Sin orden seleccionado'}</p>
                  </>
                ) : (
                  <>
                    {choice.participants?.length === 1 && choice.originalAction === 'defer' && (
                      <label>
                        <input
                          type="checkbox"
                          checked={manualKind === 'defer'}
                          onChange={(e) => setManualKind(e.target.checked ? 'defer' : 'choose')}
                        />{' '}
                        Aplazar este turno
                      </label>
                    )}
                    {choice.participants?.length === 1 && manualKind !== 'defer' && (
                      <div className="reconstruction-choice-block">
                        <p className="reconstruction-selection-count" aria-live="polite">
                          {selected.length}/{choice.needed} ciclos seleccionados
                        </p>
                        {selected.length > 0 && (
                          <ul className="reconstruction-selection-list" aria-label="Ciclos seleccionados">
                            {selected.map((date: string, index: number) => (
                              <li className="reconstruction-selection-item" key={date}>
                                <span>
                                  <strong>{dateText(date)}</strong>
                                  <small>Pendiente de registrar</small>
                                </span>
                                <button
                                  className="secondary"
                                  type="button"
                                  disabled={busy}
                                  aria-label={'Cambiar ciclo ' + (index + 1)}
                                  onClick={() => setSelected(selected.filter((_: string, i: number) => i !== index))}
                                >
                                  Cambiar
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}
                        {selected.length < choice.needed && (
                          <label>
                            {selected.length ? 'Selecciona otro ciclo' : 'Selecciona un ciclo'}
                            <select
                              aria-label="Ciclo alternativo"
                              value=""
                              disabled={busy}
                              onChange={(e) => {
                                const date = e.target.value;
                                if (date && !selected.includes(date)) setSelected([...selected, date]);
                              }}
                            >
                              <option value="">Selecciona un ciclo</option>
                              {available
                                .filter((date: string) => !selected.includes(date))
                                .map((date: string) => (
                                  <option key={date} value={date}>
                                    {dateText(date)}
                                  </option>
                                ))}
                            </select>
                          </label>
                        )}
                      </div>
                    )}
                    {choice.participants?.length > 1 &&
                      choice.participants.map((id: string) => {
                        const memberDates = entries[id] ?? [],
                          required = choice.requiredByMember[id];
                        return (
                          <div className="reconstruction-choice-block" key={id}>
                            <p className="reconstruction-selection-count">
                              <strong>{code(id)}</strong> · {memberDates.length}/{required} ciclos seleccionados
                            </p>
                            {memberDates.length > 0 && (
                              <ul
                                className="reconstruction-selection-list"
                                aria-label={'Ciclos seleccionados de ' + code(id)}
                              >
                                {memberDates.map((date: string, index: number) => (
                                  <li className="reconstruction-selection-item" key={date}>
                                    <span>
                                      <strong>{dateText(date)}</strong>
                                      <small>Pendiente de registrar</small>
                                    </span>
                                    <button
                                      className="secondary"
                                      type="button"
                                      disabled={busy}
                                      aria-label={'Cambiar ciclo ' + (index + 1) + ' de ' + code(id)}
                                      onClick={() =>
                                        setEntries({
                                          ...entries,
                                          [id]: memberDates.filter((_: string, i: number) => i !== index),
                                        })
                                      }
                                    >
                                      Cambiar
                                    </button>
                                  </li>
                                ))}
                              </ul>
                            )}
                            {memberDates.length < required && (
                              <label>
                                {memberDates.length ? 'Selecciona otro ciclo' : 'Selecciona un ciclo'}
                                <select
                                  aria-label={'Ciclo de ' + code(id)}
                                  value=""
                                  disabled={busy}
                                  onChange={(e) => {
                                    const date = e.target.value;
                                    if (date && !memberDates.includes(date))
                                      setEntries({ ...entries, [id]: [...memberDates, date] });
                                  }}
                                >
                                  <option value="">Selecciona un ciclo</option>
                                  {data.result.cycles
                                    .filter((c: any) => !memberDates.includes(c.date))
                                    .map((c: any) => (
                                      <option key={c.date} value={c.date}>
                                        {dateText(c.date)}
                                      </option>
                                    ))}
                                </select>
                              </label>
                            )}
                          </div>
                        );
                      })}
                  </>
                )}
              </div>
            )}
            <details className="reconstruction-reference">
              <summary>Consultar referencia histórica</summary>
              <p>
                <strong>Elección anterior:</strong> {originalText} ·{' '}
                {choice.originalPossible ? 'Sigue siendo posible' : 'No disponible o incompatible'}
              </p>
              {!choice.historicalPreference && (
                <p>No hay combinación válida registrada en las preferencias históricas.</p>
              )}
              {choice.preferences?.map((p: any) => (
                <p key={p.member_id}>
                  {code(p.member_id)}: {p.dates.map(dateText).join(' → ')}
                </p>
              ))}
            </details>
          </div>
        )}
        {r.status === 'review' && (
          <>
            <h3>Turnos reconstruidos</h3>
            <p>
              Se ha alcanzado el punto hasta el que había avanzado la elección. Revisa los cambios y finaliza; los
              automatismos permanecerán detenidos.
            </p>
            <p>
              CTA potencialmente afectados por cambios de disponibilidad: <strong>{impact.length}</strong>
            </p>
          </>
        )}
        {impact.length > 0 && (
          <details>
            <summary>Examinar CTA afectados ({impact.length})</summary>
            <ul>
              {impact.map((a: any) => (
                <li key={a.memberId}>
                  <strong>{code(a.memberId)}</strong> · Primera preferencia válida: {dateText(a.previousFirst)} →{' '}
                  {dateText(a.currentFirst)}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
      <footer className="reconstruction-footer">
        {choice && r.status === 'active' && (
          <button className="primary" disabled={busy || !canSend} onClick={commit}>
            Registrar decisión y continuar
          </button>
        )}
        {r.status === 'review' && (
          <button
            className="primary"
            disabled={busy}
            onClick={async () => {
              if (
                await confirm(
                  '¿Finalizar la reconstrucción? Los automatismos NO se reanudarán hasta que el responsable lo autorice expresamente.',
                )
              )
                await act({ action: 'reconstruction_finish' }, 'Reconstrucción finalizada, automatismos detenidos');
            }}
          >
            Finalizar reconstrucción
          </button>
        )}
        <div className="button-row">
          <button
            className="secondary"
            disabled={busy || !r.canBack}
            onClick={() => act({ action: 'reconstruction_back' }, 'Última decisión reconstruida deshecha')}
          >
            ↶ Deshacer paso
          </button>
          <button
            className="secondary"
            disabled={busy || !r.canForward}
            onClick={() => act({ action: 'reconstruction_forward' }, 'Paso reconstruido nuevamente')}
          >
            ↷ Rehacer paso
          </button>
        </div>
        <button
          className="reconstruction-cancel"
          disabled={busy}
          onClick={async () => {
            if (
              await confirm('¿Cancelar toda la reconstrucción y restaurar el estado exactamente anterior a iniciarla?')
            )
              await act(
                { action: 'reconstruction_cancel' },
                'Reconstrucción cancelada y situación anterior recuperada',
              );
          }}
        >
          Cancelar y restaurar estado original
        </button>
      </footer>
    </section>
  );
}
