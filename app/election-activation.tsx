'use client';
import { useEffect, useRef, useState } from 'react';

export function ActivationPanel({ data, busy, act, onActivated, onResolveScores, onResolveCycles, onSaveSource }: any) {
  const scores = data.config?.previousScores ?? {},
    source = typeof data.config?.previousScoresSource === 'string' ? data.config.previousScoresSource : '';
  // VA: the order is HR's census, in the roster; there are no scores nor cycles per person.
  const byRoster = data.election.rosterOrder === true;
  const missing = byRoster ? [] : data.members.filter((m: any) => !Number.isFinite(scores[m.code]));
  const hasMembers = data.members.length > 0,
    hasScores = hasMembers && missing.length === 0;
  const cyclesValid =
    byRoster ||
    (Number.isInteger(data.config?.cyclesPerPerson) &&
      data.config.cyclesPerPerson >= 1 &&
      data.config.cyclesPerPerson <= 6);
  const sourceValid = byRoster || source.trim().length >= 10,
    open = data.campaign.status === 'open',
    frozen = !!data.election.reconstruction?.active;
  const complete = hasScores && sourceValid && cyclesValid && open && !frozen;
  const rulesName = data.election.activationRulesName ?? 'las normas vigentes del ejercicio';
  const ranked =
    hasScores && !byRoster ? [...data.members].sort((a: any, b: any) => scores[a.code] - scores[b.code]) : [];
  const tieCounts = new Map<number, number>();
  if (hasScores) for (const m of ranked) tieCounts.set(scores[m.code], (tieCounts.get(scores[m.code]) ?? 0) + 1);
  const ties = [...tieCounts.values()].filter((n) => n > 1);
  const [confirmed, setConfirmed] = useState(false),
    [deferral, setDeferral] = useState(true);
  const [sourceOpen, setSourceOpen] = useState(false),
    [sourceDraft, setSourceDraft] = useState(''),
    [sourceError, setSourceError] = useState('');
  const sourceInputRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (sourceOpen) sourceInputRef.current?.focus();
  }, [sourceOpen]);
  if (data.election.state) return null;
  const editSource = () => {
    setSourceDraft(source);
    setSourceError('');
    setSourceOpen(true);
  };
  const saveSource = async () => {
    const text = sourceDraft.trim();
    if (text.length < 10) {
      setSourceError('Describe la procedencia con al menos 10 caracteres.');
      return;
    }
    const result = await onSaveSource(text);
    if (result?.campaign) setSourceOpen(false);
  };
  return (
    <details id="activation-panel" className="panel">
      <summary>Activar elección</summary>
      <p>
        {byRoster
          ? 'El orden es el del censo de RRHH. Revisa estos pasos y activa la elección.'
          : 'El orden se calcula a partir de las puntuaciones anteriores. Completa estos pasos y activa la elección.'}
      </p>
      {/* A checklist instead of a sentence (#65): each step says whether it is done. */}
      <ol className="activation-steps" aria-label="Pasos para activar la elección">
        <li className={hasMembers ? 'done' : 'todo'}>
          <strong>{byRoster ? 'Censo' : 'Plantilla'}</strong>
          <span>{hasMembers ? data.members.length + ' controladores' : 'Sin controladores'}</span>
        </li>
        {!byRoster && (
          <>
            <li className={hasScores ? 'done' : 'todo'}>
              <strong>Puntuaciones del año anterior</strong>
              <span>
                {hasMembers ? data.members.length - missing.length : 0} de {data.members.length}
              </span>
            </li>
            <li className={sourceValid ? 'done' : 'todo'}>
              <strong>Procedencia de las puntuaciones</strong>
              <span>{sourceValid ? source : 'Pendiente'}</span>
            </li>
            <li className={cyclesValid ? 'done' : 'todo'}>
              <strong>Ciclos por persona</strong>
              <span>{data.config?.cyclesPerPerson ?? '—'}</span>
            </li>
          </>
        )}
        <li className={open && !frozen ? 'done' : 'todo'}>
          <strong>Campaña abierta</strong>
          <span>{!open ? 'Cerrada' : frozen ? 'Reconstrucción en curso' : 'Sí'}</span>
        </li>
        <li className={confirmed ? 'done' : 'todo'}>
          <strong>Reglas confirmadas</strong>
          <span>{confirmed ? 'Sí' : 'Marca la casilla de abajo'}</span>
        </li>
        {!byRoster && (
          <li className="info">
            <strong>Empates</strong>
            <span>
              {hasScores
                ? ties.length
                  ? ties.length + ' grupos; se sortean antes de su turno'
                  : 'Ninguno'
                : 'Se calculan con las puntuaciones'}
            </span>
          </li>
        )}
      </ol>
      {!hasMembers && (
        <div role="alert" className="alert warning">
          <p>La plantilla está vacía. Añade al menos un controlador para iniciar la elección.</p>
          <button type="button" className="secondary" onClick={() => onResolveScores([])}>
            Ir a Plantilla del equipo
          </button>
        </div>
      )}
      {hasMembers && missing.length > 0 && (
        <div role="alert" className="alert warning">
          <p>
            Falta la puntuación anterior de {missing.length} controlador(es):{' '}
            {missing
              .slice(0, 8)
              .map((m: any) => m.code)
              .join(', ')}
            {missing.length > 8 ? ` y ${missing.length - 8} más` : ''}.
          </p>
          <button type="button" className="secondary" onClick={() => onResolveScores(missing.map((m: any) => m.code))}>
            Completar puntuaciones en la plantilla
          </button>
        </div>
      )}
      {!sourceValid && (
        <div role="alert" className="alert warning">
          <p>
            Falta documentar de dónde proceden las puntuaciones del ejercicio anterior. Se registra una sola descripción
            para todo el equipo, no una por controlador.
          </p>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => (sourceOpen ? setSourceOpen(false) : editSource())}
          >
            {sourceOpen ? 'Cerrar formulario' : 'Documentar procedencia'}
          </button>
        </div>
      )}
      {sourceValid && !byRoster && (
        <p className="muted">
          ¿Necesitas corregir la procedencia?{' '}
          <button
            type="button"
            className="secondary"
            onClick={() => (sourceOpen ? setSourceOpen(false) : editSource())}
            disabled={busy}
          >
            {sourceOpen ? 'Cerrar formulario' : 'Editar procedencia'}
          </button>
        </p>
      )}
      {sourceOpen && (
        <section
          id="election-score-source-editor"
          role="group"
          aria-label="Documentar origen de las puntuaciones"
          className="election-score-source-editor"
        >
          <h3>Documentar origen de las puntuaciones</h3>
          <p className="muted">
            Indica de dónde proceden las puntuaciones del ejercicio {data.campaign.year - 1}: por ejemplo, la
            clasificación comunicada por el responsable, su fecha y el documento utilizado. Esta descripción queda
            guardada para todo el equipo en este ejercicio y permite revisar posteriormente el origen del orden de
            elección. No modifica ninguna puntuación.
          </p>
          <label htmlFor="election-score-source">
            Procedencia del equipo {data.campaign.team_id}
            <textarea
              ref={sourceInputRef}
              id="election-score-source"
              aria-label="Procedencia de las puntuaciones"
              rows={4}
              maxLength={500}
              value={sourceDraft}
              onChange={(e) => {
                setSourceDraft(e.target.value);
                setSourceError('');
              }}
              placeholder="Ej.: puntuaciones facilitadas por el responsable el 22/10/2026, según clasificación anual"
              disabled={busy}
            />
          </label>
          {sourceError && (
            <p className="alert error" role="alert">
              {sourceError}
            </p>
          )}
          <div className="button-row">
            <button type="button" className="secondary" disabled={busy} onClick={() => setSourceOpen(false)}>
              Cancelar
            </button>
            <button
              type="button"
              className="primary"
              disabled={busy || sourceDraft.trim().length < 10}
              onClick={saveSource}
            >
              Guardar procedencia
            </button>
          </div>
        </section>
      )}
      {!cyclesValid && (
        <div role="alert" className="alert warning">
          <p>La elección requiere entre uno y seis ciclos por persona. Revisa el parámetro «Ciclos por persona».</p>
          <button type="button" className="secondary" onClick={onResolveCycles}>
            Revisar parámetros del ejercicio
          </button>
        </div>
      )}
      {!open && (
        <p role="alert" className="alert warning">
          La campaña está cerrada. Reábrela desde «Estado de la campaña» antes de iniciar la elección.
        </p>
      )}
      {frozen && (
        <p role="alert" className="alert warning">
          Hay una reconstrucción en curso. Finalízala antes de activar la elección.
        </p>
      )}
      {hasScores && !byRoster && (
        <details>
          <summary>Ver orden calculado (solo lectura)</summary>
          <ol>
            {ranked.map((m: any) => (
              <li key={m.id}>
                {m.code}: {scores[m.code]} puntos
              </li>
            ))}
          </ol>
        </details>
      )}
      <div className="team-checkboxes">
        <label>
          <input type="checkbox" checked={deferral} onChange={(e) => setDeferral(e.target.checked)} /> Permitir uno o
          dos aplazamientos
        </label>
        <label>
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} /> Confirmo{' '}
          {rulesName}
          {byRoster ? ' y el orden del censo' : ' y las puntuaciones'}
        </label>
      </div>
      <button
        type="button"
        className="primary"
        disabled={busy || !complete || !confirmed}
        onClick={async () => {
          const result = await act(
            {
              action: 'start',
              rulesConfirmed: true,
              allowDeferral: deferral,
              ...(byRoster ? { source: 'Orden del censo de RRHH' } : {}),
            },
            byRoster ? 'Elección activada en el orden del censo' : 'Puntuaciones confirmadas y elección activada',
          );
          if (result?.campaign) onActivated?.();
        }}
      >
        Activar elección
      </button>
    </details>
  );
}
