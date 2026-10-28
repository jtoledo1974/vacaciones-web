'use client';
import { Fragment, useEffect, useState } from 'react';
import { api } from './api-client';

type Row = {
  personId: string;
  team: string;
  code: string;
  label: string;
  hrName: string | null;
  seniority: string | null;
  controllerNumber: number | null;
  years: number | null;
  days: number;
  status: 'entitled' | 'missing_date';
  account: { provider: 'chatgpt' | 'firebase'; subject: string; version: number } | null;
};
type Census = {
  year: number | null;
  people: Row[];
  notEntitled: number;
  totalDays: number;
  quotas: { title: string; receivedAt: string; updatedAt: string; places: number; days: number } | null;
};

// Recent joiners have no date and no right yet: they are listed, not pending.
const pending = (r: Row) => r.status === 'entitled' && !r.account;
const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** One person's sign-in link, saved when leaving the field as in the team roster. */
function AccessEditor({ row, onSaved }: { row: Row; onSaved: () => Promise<void> }) {
  const [provider, setProvider] = useState(row.account?.provider ?? 'chatgpt'),
    [subject, setSubject] = useState(row.account?.subject ?? ''),
    [state, setState] = useState(''),
    [error, setError] = useState('');
  const save = async (nextProvider = provider, nextSubject = subject) => {
    if (nextProvider === (row.account?.provider ?? 'chatgpt') && nextSubject.trim() === (row.account?.subject ?? ''))
      return;
    setState('Guardando…');
    setError('');
    try {
      await api('va/account', {
        method: 'POST',
        body: {
          personId: row.personId,
          provider: nextProvider,
          subject: nextSubject,
          accountVersion: row.account?.version ?? 0,
        },
      });
      setState('Guardado');
      await onSaved();
    } catch (e) {
      setState('');
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div className="va-access">
      <div className="va-access-fields">
        <input
          aria-label={'Acceso VA de ' + row.code}
          placeholder={row.account && !row.account.subject ? 'Vínculo anterior activo' : 'correo@ejemplo.es'}
          value={subject}
          maxLength={250}
          onChange={(e) => setSubject(e.target.value)}
          onBlur={() => save()}
        />
        <select
          aria-label={'Autenticación VA de ' + row.code}
          value={provider}
          onChange={(e) => {
            const next = e.target.value as 'chatgpt' | 'firebase';
            setProvider(next);
            void save(next);
          }}
        >
          <option value="chatgpt">ChatGPT Sites</option>
          <option value="firebase">Firebase</option>
        </select>
      </div>
      {error ? (
        <div className="alert error" role="alert">
          {error}
        </div>
      ) : (
        <small className="muted" role="status">
          {state || 'Se guarda al salir del campo. Déjalo vacío para quitar el acceso.'}
        </small>
      )}
    </div>
  );
}

function PersonRow({ row, onSaved }: { row: Row; onSaved: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const tag =
    row.status === 'missing_date'
      ? ['va-tag-muted', 'Sin fecha']
      : !row.account
        ? ['va-tag-warning', 'Sin acceso']
        : ['va-tag-ok', row.days + (row.days === 1 ? ' día' : ' días')];
  return (
    <li className="va-person">
      <button type="button" className="va-person-line" aria-expanded={open} onClick={() => setOpen(!open)}>
        <b>{row.code}</b>
        <span className="va-person-name">{row.hrName ?? row.label}</span>
        <span className={'va-tag ' + tag[0]}>{tag[1]}</span>
      </button>
      {open && (
        <div className="va-person-detail">
          <p className="muted">
            Equipo {row.team}
            {row.seniority && <> · antigüedad {row.seniority.split('-').reverse().join('/')}</>}
            {row.years !== null && <> · {row.years} años</>}
            {row.controllerNumber !== null && <> · CTA {row.controllerNumber.toLocaleString('es-ES')}</>}
          </p>
          {row.status === 'missing_date' && (
            <p className="muted">La fecha se completa por CLI con la carga de antigüedad maestra.</p>
          )}
          <AccessEditor row={row} onSaved={onSaved} />
        </div>
      )}
    </li>
  );
}

/** «Censo y accesos de VA»: what is pending first, everything else folded by team. */
export default function VaCensusPanel() {
  const [census, setCensus] = useState<Census | null>(null),
    [error, setError] = useState(''),
    [query, setQuery] = useState('');
  const load = () =>
    api<Census>('va/census')
      .then(setCensus)
      .catch((e: Error) => setError(e.message));
  useEffect(() => {
    void load();
  }, []);
  if (error) return <div className="alert error">{error}</div>;
  if (!census) return <div className="panel empty">Cargando el censo de VA…</div>;
  const people = census.people,
    q = fold(query.trim());
  const matches = q ? people.filter((r) => fold(r.code + ' ' + r.label + ' ' + (r.hrName ?? '')).includes(q)) : null;
  const todo = people.filter(pending),
    teams = [...new Set(people.map((r) => r.team))];
  const entitled = people.filter((r) => r.status === 'entitled');
  return (
    <section className="panel va-census" aria-label="Censo y accesos de VA">
      <h2>Censo y accesos de VA · {census.year}</h2>
      <p className="va-quotas-line">
        {census.quotas ? (
          <>
            Cupos de RRHH: <b>{census.quotas.places} plazas</b> en {census.quotas.days} días para {census.totalDays}{' '}
            días reconocidos · {census.quotas.title}, recibido el{' '}
            {census.quotas.receivedAt.split('-').reverse().join('/')}
          </>
        ) : (
          <>
            Cupos de RRHH sin cargar. Se cargan por CLI: <code>admin-cli.mjs va-cupos importar calendario.xlsm</code>
          </>
        )}
      </p>
      <div className="va-metrics">
        <div>
          <b>{entitled.length}</b>
          <span>con derecho · {census.totalDays} días</span>
        </div>
        <div>
          <b className={entitled.some((r) => !r.account) ? 'va-warning' : ''}>
            {entitled.filter((r) => !r.account).length}
          </b>
          <span>sin acceso vinculado</span>
        </div>
        <div>
          <b>{people.filter((r) => r.status === 'missing_date').length}</b>
          <span>sin fecha (sin derecho aún)</span>
        </div>
      </div>
      <input
        type="search"
        aria-label="Buscar en el censo de VA"
        placeholder="Buscar por nick o nombre"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {matches ? (
        <>
          <h3 className="va-heading">{matches.length} resultados</h3>
          <ul className="va-list">
            {matches.map((r) => (
              <PersonRow key={r.personId} row={r} onSaved={load} />
            ))}
          </ul>
        </>
      ) : (
        <>
          <h3 className="va-heading">Pendiente antes de abrir · {todo.length}</h3>
          {todo.length ? (
            <ul className="va-list">
              {todo.map((r) => (
                <PersonRow key={r.personId} row={r} onSaved={load} />
              ))}
            </ul>
          ) : (
            <p className="muted">Todo listo: todas las personas con derecho tienen acceso.</p>
          )}
          <h3 className="va-heading">Todo el censo · por equipo</h3>
          {teams.map((team) => {
            const rows = people.filter((r) => r.team === team),
              left = rows.filter(pending).length;
            return (
              <Fragment key={team}>
                <details className="va-team">
                  <summary>
                    <span>
                      <b>Equipo {team}</b> · {rows.length} personas
                    </span>
                    <span className={'va-tag ' + (left ? 'va-tag-warning' : 'va-tag-ok')}>
                      {left ? left + ' pendientes' : 'Todo listo'}
                    </span>
                  </summary>
                  <ul className="va-list">
                    {rows.map((r) => (
                      <PersonRow key={r.personId} row={r} onSaved={load} />
                    ))}
                  </ul>
                </details>
              </Fragment>
            );
          })}
          <p className="muted">
            {census.notEntitled} personas de los equipos no alcanzan los 20 años de antigüedad en {census.year}. Quien
            no pertenece a ningún equipo se dará de alta por CLI.
          </p>
        </>
      )}
    </section>
  );
}
