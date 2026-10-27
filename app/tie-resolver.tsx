'use client';
import { useEffect, useState } from 'react';
import { useConfirmation } from './confirmation';

export function TieResolver({ group, data, busy, act, manage, open, early = false }: any) {
  const confirm = useConfirmation(),
    [order, setOrder] = useState<string[]>([]);
  const code = (id: string) => data.members.find((m: any) => m.id === id)?.code ?? id;
  return (
    <section className="panel" aria-label="Resolver empate">
      <h2>Empate pendiente de sorteo</h2>
      <p>
        {group.map(code).join(', ')}.{' '}
        {early
          ? 'Puedes resolver este empate antes de que llegue su turno.'
          : 'La elección y los automatismos esperan hasta que se guarde el orden del sorteo.'}{' '}
        En las siguientes rondas se rotará este orden.
      </p>
      {manage && open ? (
        <>
          <button
            className="primary"
            disabled={busy}
            onClick={async () => {
              if (
                await confirm(
                  '¿Sortear y guardar el orden de este grupo? El resultado quedará registrado y no se podrá repetir.',
                )
              )
                act(
                  { action: 'resolve_tie', method: 'random', ...(early ? { groupMemberIds: group } : {}) },
                  'Sorteo guardado',
                );
            }}
          >
            Sortear y guardar orden
          </button>
          <h3>Registrar un sorteo realizado fuera de la app</h3>
          <p>
            Pulsa los nombres en el orden obtenido: primero quien elige antes, después el siguiente, hasta completar el
            grupo.
          </p>
          <div className="button-row">
            {group.map((id: string) => (
              <button
                type="button"
                className="secondary"
                key={id}
                aria-label={'Añadir al sorteo ' + code(id)}
                disabled={busy || order.includes(id)}
                onClick={() => setOrder([...order, id])}
              >
                {code(id)}
              </button>
            ))}
          </div>
          <ol aria-label="Orden del sorteo externo">
            {order.map((id) => (
              <li key={id}>{code(id)}</li>
            ))}
          </ol>
          <div className="button-row">
            <button className="secondary" disabled={busy || !order.length} onClick={() => setOrder(order.slice(0, -1))}>
              Quitar último
            </button>
            <button
              className="primary"
              disabled={busy || order.length !== group.length}
              onClick={async () => {
                if (await confirm('¿Guardar este orden del sorteo externo: ' + order.map(code).join(' → ') + '?'))
                  act(
                    { action: 'resolve_tie', method: 'external', order, ...(early ? { groupMemberIds: group } : {}) },
                    'Orden del sorteo externo guardado',
                  );
              }}
            >
              Guardar orden externo
            </button>
          </div>
        </>
      ) : (
        <p>El responsable del equipo debe registrar el resultado antes de continuar.</p>
      )}
    </section>
  );
}

export function PendingTieDialog({ data, busy, act, onClose }: any) {
  const pending: string[][] = data.election.state?.pendingTieGroups ?? [];
  const resolved = data.election.state?.tieResolutions ?? [];
  const [selected, setSelected] = useState('');
  const group = pending.find((g) => g.includes(selected)) ?? pending[0];
  const code = (id: string) => data.members.find((m: any) => m.id === id)?.code ?? id;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  useEffect(() => {
    if (!pending.length) onClose();
  }, [pending.length, onClose]);
  return (
    <div
      className="tie-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className="tie-dialog" role="dialog" aria-modal="true" aria-labelledby="pending-ties-title">
        <header className="tie-dialog-head">
          <div>
            <span className="eyebrow">ADMINISTRACIÓN DE LA ELECCIÓN</span>
            <h2 id="pending-ties-title">Resolver empates pendientes</h2>
            <p className="muted">Puedes resolverlos sin esperar al turno de sus participantes.</p>
          </div>
          <button type="button" className="secondary" onClick={onClose} aria-label="Cerrar resolución de empates">
            ✕
          </button>
        </header>
        <div className="tie-dialog-content">
          <aside className="tie-dialog-groups">
            <strong>Pendientes · {pending.length}</strong>
            {pending.map((g) => (
              <button
                type="button"
                key={g.join('|')}
                className={'tie-dialog-group' + (g === group ? ' selected' : '')}
                aria-pressed={g === group}
                onClick={() => setSelected(g[0])}
              >
                <b>{g.map(code).join(' · ')}</b>
                <small>
                  {data.config?.previousScores?.[code(g[0])] ?? '—'} puntos · {g.length} controladores
                </small>
              </button>
            ))}
            {!!resolved.length && (
              <div className="tie-dialog-resolved">
                <strong>Resueltos · {resolved.length}</strong>
                {resolved.map((r: any, i: number) => (
                  <p key={i}>
                    ✓ {r.order.map(code).join(' → ')}
                    {r.anticipated ? ' · Anticipado' : ''}
                  </p>
                ))}
              </div>
            )}
          </aside>
          <div className="tie-dialog-editor">
            {group ? (
              <TieResolver key={group.join('|')} group={group} data={data} busy={busy} act={act} manage open early />
            ) : (
              <p>Todos los empates están resueltos.</p>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
