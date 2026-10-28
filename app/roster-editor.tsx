'use client';
import type { ImportReview } from '../domain/import-review-types';

import { useEffect, useRef, useState } from 'react';
import { Ellipsis } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  DropdownMenuPortal,
} from '../components/ui/dropdown-menu';
import { useConfirmation } from './confirmation';
import { reconcileRosterRows, withoutBlankNewRosterRows } from './roster-rows';

type Provider = '' | 'chatgpt' | 'firebase';
type Row = {
  memberId?: string;
  code: string;
  label: string;
  seniority: string;
  previousScore: string;
  provider: Provider;
  subject: string;
  accountVersion: number;
  legacyKey?: string;
};
type AccountChange = Pick<Row, 'memberId' | 'code' | 'provider' | 'subject' | 'accountVersion'>;

function accountKey(row: Pick<Row, 'provider' | 'subject' | 'legacyKey'>): string {
  const subject = row.subject.trim();
  if (!subject) return row.provider === 'chatgpt' ? (row.legacyKey ?? '') : '';
  return row.provider === 'chatgpt'
    ? 'chatgpt-email:' + subject.toLowerCase()
    : row.provider === 'firebase'
      ? 'firebase:' + subject
      : '';
}
function initialRows(data: any): Row[] {
  return data.members.map((m: any) => {
    const account = data.election.accounts.find((a: any) => a.member_id === m.id);
    const key = String(account?.principal_key ?? '');
    const provider: Provider = key.startsWith('firebase:')
      ? 'firebase'
      : key.startsWith('chatgpt-email:') || key.startsWith('chatgpt:')
        ? 'chatgpt'
        : '';
    const legacyKey = key.startsWith('chatgpt:') ? key : undefined;
    return {
      memberId: m.id,
      code: m.code,
      label: m.label ?? '',
      seniority: m.seniority ?? '',
      previousScore:
        data.config?.previousScores?.[m.code] === undefined ? '' : String(data.config.previousScores[m.code]),
      provider,
      subject: key.startsWith('chatgpt-email:')
        ? key.slice('chatgpt-email:'.length)
        : provider === 'firebase'
          ? key.slice('firebase:'.length)
          : '',
      accountVersion: account?.version ?? 0,
      legacyKey,
    };
  });
}
const emptyRow = (): Row => ({
  code: '',
  label: '',
  seniority: '',
  previousScore: '',
  provider: '',
  subject: '',
  accountVersion: 0,
});

export default function RosterEditor({
  data,
  busy,
  save,
  importRoster,
  previewImportRoster,
  retire,
  transfer,
  teams,
  readOnly = false,
  manageAccounts = false,
}: any) {
  const confirm = useConfirmation();
  const live = data.campaign.scope_key === 'live';
  const [rows, setRows] = useState<Row[]>(() => initialRows(data));
  const [pasted, setPasted] = useState('');
  const [pastedScores, setPastedScores] = useState('');
  const [scoreSource, setScoreSource] = useState<string>(data.config?.previousScoresSource ?? '');
  const [error, setError] = useState('');
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [retryTick, setRetryTick] = useState(0);
  const savingRef = useRef(false);
  const attemptedRef = useRef('');
  const submittedRef = useRef<{ rows: Row[]; source: string } | null>(null);
  const serverRef = useRef({
    version: data.campaign.version,
    rows: initialRows(data),
    source: data.config?.previousScoresSource ?? '',
  });
  // Campaign revisions refresh the canonical data. Rebase newer local keystrokes
  // on each response, rather than destroying and remounting this editor.
  useEffect(() => {
    if (serverRef.current.version === data.campaign.version) return;
    const previous = serverRef.current,
      received = initialRows(data),
      source = data.config?.previousScoresSource ?? '';
    setRows((current) => reconcileRosterRows(previous.rows, received, current, submittedRef.current?.rows ?? null));
    setScoreSource((current) => (current === (submittedRef.current?.source ?? previous.source) ? source : current));
    serverRef.current = { version: data.campaign.version, rows: received, source };
    submittedRef.current = null;
  }, [data.campaign.version]);

  const original = initialRows(data);
  const savedRows = withoutBlankNewRosterRows(rows);
  const byId = new Map(original.map((row) => [row.memberId, row]));
  const rosterDirty =
    savedRows.length !== original.length ||
    savedRows.some((r, i) => {
      const m = original[i];
      return !m || r.memberId !== m.memberId || r.code !== m.code || r.label !== m.label || r.seniority !== m.seniority;
    });
  const changedAccounts: AccountChange[] =
    live && manageAccounts
      ? savedRows
          .filter((r) => {
            const previous = r.memberId ? byId.get(r.memberId) : undefined;
            return accountKey(r) !== accountKey(previous ?? { provider: '', subject: '' });
          })
          .map(({ memberId, code, provider, subject, accountVersion }) => ({
            memberId,
            code,
            provider,
            subject,
            accountVersion,
          }))
      : [];
  // A nick change alone needs no score save: the server moves its score along.
  const scoresDirty =
    savedRows.length !== original.length ||
    savedRows.some(
      (r, i) => r.previousScore !== original[i]?.previousScore || (!r.memberId && r.code !== original[i]?.code),
    ) ||
    scoreSource !== (data.config?.previousScoresSource ?? '');
  const dirty = rosterDirty || scoresDirty || changedAccounts.length > 0;
  const fingerprint = JSON.stringify({ rows: savedRows, scoreSource });
  const targetTeams = (teams ?? []).filter(
    (t: any) => t.team_id !== data.campaign.team_id && t.status === 'open' && t.year === data.campaign.year,
  );
  const locked = readOnly;

  function change(i: number, k: keyof Row, v: string) {
    setError('');
    setSaveStatus('idle');
    setRows((current) => current.map((r, n) => (n === i ? { ...r, [k]: v } : r)));
  }
  function paste() {
    const lines = pasted.trim().split(/\r?\n/).filter(Boolean);
    if (!lines.length) return;
    setRows(
      lines.map((line) => {
        const columns = line.split('\t'),
          [code, label = ''] = columns;
        const existing = rows.find((r) => r.code.toUpperCase() === code.trim().toUpperCase());
        return {
          ...(existing ?? emptyRow()),
          code: code.trim(),
          label: label.trim(),
          previousScore: columns.length > 2 ? columns[2].trim() : (existing?.previousScore ?? ''),
        };
      }),
    );
    setPasted('');
  }
  function pasteScores() {
    const entries = pastedScores
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => line.split(/[\t;]/).map((value) => value.trim()));
    if (!entries.length) return;
    const updated = new Map<string, string>();
    for (const [code, value] of entries) {
      if (/^(nick|identificador|code)$/i.test(code) && /^(puntos|score)/i.test(value ?? '')) continue;
      const score = Number((value ?? '').replace(',', '.'));
      if (!code || !value || !Number.isFinite(score) || score < 0 || score > 10000) {
        setError('Formato de puntuación no válido para ' + code);
        return;
      }
      const normalized = code.toUpperCase();
      if (updated.has(normalized) || !rows.some((row) => row.code.trim().toUpperCase() === normalized)) {
        setError('Identificador duplicado o desconocido: ' + code);
        return;
      }
      updated.set(normalized, value.replace(',', '.'));
    }
    if (!updated.size) {
      setError('No se han encontrado puntuaciones en el texto.');
      return;
    }
    setRows((current) =>
      current.map((row) =>
        updated.has(row.code.trim().toUpperCase())
          ? { ...row, previousScore: updated.get(row.code.trim().toUpperCase())! }
          : row,
      ),
    );
    setPastedScores('');
    setError('');
  }
  async function persistChanges() {
    if (savingRef.current || busy || readOnly || !dirty || attemptedRef.current === fingerprint) return;
    attemptedRef.current = fingerprint;
    const codes = new Set<string>();
    for (const r of savedRows) {
      const code = r.code.trim().toUpperCase();
      if (!/^[\p{L}\p{N} _.-]{1,24}$/u.test(code)) {
        setError('Identificador no válido: revisa las filas incompletas.');
        setSaveStatus('error');
        return;
      }
      if (codes.has(code)) {
        setError('Identificador repetido: ' + code);
        setSaveStatus('error');
        return;
      }
      codes.add(code);
      if (r.subject.trim() && !r.provider) {
        setError('Selecciona un sistema de autenticación para ' + r.code);
        setSaveStatus('error');
        return;
      }
      if (
        r.subject.trim() &&
        r.provider === 'chatgpt' &&
        (!/^[^\s@:\x00-\x1f]+@[^\s@:\x00-\x1f]+\.[^\s@:\x00-\x1f]+$/.test(r.subject.trim()) ||
          r.subject.trim().length > 250)
      ) {
        setError('Introduce un correo electrónico válido para ' + r.code + '.');
        setSaveStatus('error');
        return;
      }
      if (
        r.subject.trim() &&
        r.provider === 'firebase' &&
        (/[\s\r\n:]/.test(r.subject.trim()) || r.subject.trim().length > 250)
      ) {
        setError('El UID de Firebase de ' + r.code + ' no es válido.');
        setSaveStatus('error');
        return;
      }
    }
    const previousScores: Record<string, number> = {};
    for (const row of savedRows) {
      if (!row.previousScore.trim()) continue;
      const score = Number(row.previousScore.trim().replace(',', '.'));
      if (!Number.isFinite(score) || score < 0 || score > 10000) {
        setError('Puntuación anterior no válida para ' + row.code);
        setSaveStatus('error');
        return;
      }
      previousScores[row.code.trim().toUpperCase()] = score;
    }
    savingRef.current = true;
    submittedRef.current = { rows: savedRows.map((row) => ({ ...row })), source: scoreSource };
    setSaveStatus('saving');
    setError('');
    try {
      await save(
        savedRows.map(({ memberId, code, label, seniority }) => ({ memberId, code, label, seniority })),
        changedAccounts,
        rosterDirty,
        scoresDirty,
        previousScores,
        scoreSource.trim(),
      );
      setSaveStatus('saved');
    } catch (err: any) {
      setError(err instanceof Error ? err.message : 'No se han podido guardar los cambios.');
      setSaveStatus('error');
    } finally {
      savingRef.current = false;
      setRetryTick((current) => current + 1);
    }
  }
  // Serialised saves, 800 ms after typing stops; the newest draft is queued
  // automatically if edits arrive while the previous request is in flight.
  const persistRef = useRef(persistChanges);
  persistRef.current = persistChanges;
  useEffect(() => {
    if (readOnly || busy || savingRef.current || !dirty || attemptedRef.current === fingerprint) return;
    const timer = setTimeout(() => void persistRef.current(), 800);
    return () => clearTimeout(timer);
  }, [fingerprint, dirty, readOnly, busy, data.campaign.version, retryTick]);
  function flushOnBlur() {
    if (dirty && !savingRef.current) void persistRef.current();
  }
  async function removeMember(r: Row) {
    if (
      await confirm(
        '¿Dar de baja a ' +
          r.code +
          ' del equipo ' +
          data.campaign.team_id +
          ', ejercicio ' +
          data.campaign.year +
          '? Los demás ejercicios se conservan.',
      )
    ) {
      retire(r.memberId);
    }
  }
  async function moveMember(r: Row, t: any) {
    if (
      await confirm(
        '¿Trasladar a ' + r.code + ' al equipo ' + t.team_id + ' en ' + t.year + '? Los otros años no cambian.',
      )
    ) {
      transfer(r.memberId, t.team_id, t.version);
    }
  }

  return (
    <section id="roster-panel" className="panel roster-panel">
      <div className="section-head roster-heading">
        <div>
          <h2>Plantilla del equipo {data.campaign.team_id}</h2>
          <p>
            {data.campaign.year} · Un registro por controlador. Los cambios de plantilla se aplican solo a este
            ejercicio. Las modificaciones se guardan automáticamente. Las filas nuevas vacías no se guardan.
          </p>
        </div>
        <span className="tag">{savedRows.length} controladores</span>
      </div>
      {error && (
        <div className="alert error" role="alert">
          {error}
        </div>
      )}
      {changedAccounts.length > 0 && (
        <div className="alert warning" role="status">
          {changedAccounts.length} {changedAccounts.length === 1 ? 'acceso pendiente' : 'accesos pendientes'} de
          sincronizar. La vinculación será efectiva cuando aparezca «Todos los cambios guardados».
        </div>
      )}
      <div className="table-wrap roster-table-wrap" onBlur={flushOnBlur}>
        <table className="roster-table">
          <thead>
            <tr>
              <th>Nick</th>
              <th>Nombre</th>
              <th>Puntos {data.campaign.year - 1}</th>
              {live && manageAccounts && (
                <>
                  <th>Correo de acceso / UID</th>
                  <th>Autenticación</th>
                </>
              )}
              <th>
                <span className="sr-only">Acciones</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.memberId ?? 'new-' + i}>
                <td data-label="Nick">
                  <input
                    className="roster-code"
                    aria-label={'Identificador fila ' + (i + 1)}
                    value={r.code}
                    maxLength={24}
                    disabled={locked}
                    onChange={(e) => change(i, 'code', e.target.value)}
                  />
                </td>
                <td data-label="Nombre">
                  <input
                    className="roster-name"
                    aria-label={'Nombre fila ' + (i + 1)}
                    value={r.label}
                    maxLength={120}
                    disabled={locked}
                    onChange={(e) => change(i, 'label', e.target.value)}
                  />
                </td>
                <td data-label={'Puntos ' + (data.campaign.year - 1)}>
                  <input
                    className="roster-date"
                    aria-label={'Puntuación anterior de ' + r.code}
                    type="number"
                    min="0"
                    max="10000"
                    step="any"
                    value={r.previousScore}
                    placeholder="Pendiente"
                    disabled={locked}
                    onChange={(e) => change(i, 'previousScore', e.target.value)}
                  />
                </td>
                {live && manageAccounts && (
                  <>
                    <td data-label="Correo de acceso" className="roster-access">
                      <input
                        className="roster-subject"
                        aria-label={'Correo de acceso o UID de ' + r.code}
                        value={r.subject}
                        maxLength={250}
                        placeholder={
                          r.legacyKey
                            ? 'Vínculo anterior activo'
                            : r.provider === 'firebase'
                              ? 'UID Firebase'
                              : 'correo@ejemplo.es'
                        }
                        disabled={locked}
                        autoComplete="off"
                        onChange={(e) => {
                          setError('');
                          setSaveStatus('idle');
                          setRows((current) =>
                            current.map((row, n) =>
                              n === i
                                ? {
                                    ...row,
                                    subject: e.target.value,
                                    legacyKey: undefined,
                                    provider: e.target.value && !row.provider ? 'chatgpt' : row.provider,
                                  }
                                : row,
                            ),
                          );
                        }}
                      />
                    </td>
                    <td data-label="Autenticación">
                      <select
                        className="roster-provider"
                        aria-label={'Autenticación de ' + r.code}
                        value={r.provider}
                        disabled={locked}
                        onChange={(e) => {
                          setError('');
                          setSaveStatus('idle');
                          setRows((current) =>
                            current.map((row, n) =>
                              n === i
                                ? {
                                    ...row,
                                    provider: e.target.value as Provider,
                                    subject: e.target.value ? row.subject : '',
                                    legacyKey: e.target.value === 'chatgpt' ? row.legacyKey : undefined,
                                  }
                                : row,
                            ),
                          );
                        }}
                      >
                        <option value="">Sin vincular</option>
                        <option value="chatgpt">ChatGPT Sites</option>
                        <option value="firebase">Firebase</option>
                      </select>
                    </td>
                  </>
                )}
                <td className="roster-menu-cell">
                  {!readOnly && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          className="roster-more"
                          disabled={busy || (dirty && !!r.memberId)}
                          aria-label={'Acciones de ' + r.code}
                          title={
                            dirty
                              ? 'Se están guardando modificaciones; espera antes de dar de baja o trasladar'
                              : 'Acciones del controlador'
                          }
                        >
                          <Ellipsis size={17} />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="roster-dropdown-menu">
                        {r.memberId ? (
                          <>
                            <DropdownMenuItem onSelect={() => void removeMember(r)} className="roster-danger">
                              Dar de baja de este ejercicio
                            </DropdownMenuItem>
                            <DropdownMenuSub>
                              <DropdownMenuSubTrigger disabled={!live || !targetTeams.length}>
                                Cambiar de turno / trasladar
                              </DropdownMenuSubTrigger>
                              <DropdownMenuPortal>
                                <DropdownMenuSubContent className="roster-dropdown-menu">
                                  {targetTeams.map((t: any) => (
                                    <DropdownMenuItem key={t.id} onSelect={() => void moveMember(r, t)}>
                                      Equipo {t.team_id}
                                    </DropdownMenuItem>
                                  ))}
                                </DropdownMenuSubContent>
                              </DropdownMenuPortal>
                            </DropdownMenuSub>
                          </>
                        ) : (
                          <DropdownMenuItem onSelect={() => setRows((current) => current.filter((_, n) => n !== i))}>
                            Quitar fila nueva
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!readOnly && (
        <>
          <label>
            Origen de las puntuaciones de {data.campaign.year - 1} (puede completarse al activar)
            <input
              type="text"
              maxLength={500}
              value={scoreSource}
              onBlur={flushOnBlur}
              onChange={(e) => {
                setScoreSource(e.target.value);
                setError('');
                setSaveStatus('idle');
              }}
              placeholder="Responsable, fecha y procedencia"
              disabled={locked}
            />
          </label>
          <p className="muted">
            {savedRows.filter((r) => r.previousScore.trim()).length}/{savedRows.length} puntuaciones registradas. No se
            puede activar la elección mientras falte alguna.
          </p>
          <div className="button-row roster-toolbar">
            <button
              className="secondary"
              disabled={busy}
              onClick={() => setRows((current) => [...current, emptyRow()])}
            >
              Añadir fila
            </button>
            <label className="secondary file-label">
              Importar plantilla del Excel
              <input
                type="file"
                accept=".json"
                disabled={busy || dirty}
                onChange={async (e) => {
                  const input = e.currentTarget,
                    f = input.files?.[0];
                  if (!f) return;
                  try {
                    const source = JSON.parse(await f.text());
                    if (source.format !== 'vacaciones-roster-v1')
                      throw new Error('Usa el archivo de plantilla exportado del Excel');
                    if (source.team !== data.campaign.team_id || source.year !== data.campaign.year)
                      throw new Error('El archivo corresponde a otro equipo o ejercicio');
                    const review: ImportReview = await previewImportRoster(source);
                    if (review.blockingIssues.length) throw new Error(review.blockingIssues.join('; '));
                    const details = review.findings.length
                      ? '\nIncidencias detectadas (puedes cancelar):\n' +
                        review.findings
                          .map(
                            (f) =>
                              `Paso ${f.step}, ronda ${f.round}, ${f.code}, ${f.deferred ? 'aplaza' : f.date}: ${f.message}`,
                          )
                          .join('\n')
                      : '\nLa comprobación paso a paso no ha detectado incidencias.';
                    const sequence =
                      '\nOrden que se registrará:\n' +
                      review.sequence
                        .map((s, i) => `${i + 1}. R${s.round} ${s.code}: ${s.deferred ? 'aplaza' : s.date}`)
                        .join('\n');
                    if (
                      !(await confirm(
                        <span
                          style={{ display: 'block', maxHeight: '50vh', overflowY: 'auto', whiteSpace: 'pre-wrap' }}
                        >
                          {'¿Importar ' +
                            source.rows.length +
                            ' controladores del equipo ' +
                            source.team +
                            ' con sus selecciones originales? Sustituirá la plantilla y el borrador de esta campaña. Los históricos publicados se conservan.' +
                            details +
                            sequence}
                        </span>,
                        review.findings.length ? `${source.team}-${source.year}` : undefined,
                        {
                          title: 'Revisar importación',
                          confirmLabel: review.findings.length ? 'Aceptar incidencias e importar' : 'Importar',
                        },
                      ))
                    )
                      return;
                    await importRoster(source, review);
                    setError('');
                  } catch (err: any) {
                    setError(err.message);
                  } finally {
                    input.value = '';
                  }
                }}
              />
            </label>
            <span className="roster-unsaved" role="status" aria-live="polite">
              {saveStatus === 'error' && dirty
                ? 'Guardado fallido'
                : (busy && dirty) || saveStatus === 'saving'
                  ? 'Guardando…'
                  : dirty
                    ? 'Guardado automático pendiente'
                    : 'Todos los cambios guardados'}
            </span>
            {saveStatus === 'error' && dirty && (
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  attemptedRef.current = '';
                  setRetryTick((n) => n + 1);
                }}
              >
                Reintentar guardado
              </button>
            )}
          </div>
          <details className="roster-import">
            <summary>Pegar controladores desde Excel</summary>
            <p className="muted">
              Copia las columnas nick, nombre y, opcionalmente, puntos del año anterior. Los accesos ya vinculados se
              conservan para los nicks existentes. Esta opción sustituye las filas visibles.
            </p>
            <textarea
              aria-label="Pegar plantilla"
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
              rows={5}
              placeholder={'NICK\tNombre\tPUNTOS_ANTERIORES'}
            />
            <button className="secondary" disabled={busy} onClick={paste}>
              Llevar a la tabla
            </button>
          </details>
          <details className="roster-import">
            <summary>Pegar puntuaciones desde Excel</summary>
            <p className="muted">
              Copia las columnas identificador y puntos del ejercicio anterior. Los nombres y accesos no se modificarán;
              las puntuaciones que no aparezcan conservarán su valor.
            </p>
            <textarea
              aria-label="Pegar puntuaciones anteriores"
              rows={5}
              value={pastedScores}
              onChange={(e) => setPastedScores(e.target.value)}
              placeholder={'NICK\tPUNTOS\nAA\t150\nBB\t172'}
            />
            <button type="button" className="secondary" disabled={busy || !pastedScores.trim()} onClick={pasteScores}>
              Aplicar puntuaciones a la tabla
            </button>
          </details>
        </>
      )}
      {live && manageAccounts && (
        <p className="roster-footnote">
          Para ChatGPT Sites basta con el correo electrónico de acceso; debe coincidir con la cuenta autenticada.
          Firebase sigue usando UID. «Sin vincular» elimina la asociación. Los vínculos antiguos siguen funcionando
          hasta que se sustituyan por correo. Los accesos se comparten entre ejercicios de la misma persona.
        </p>
      )}
    </section>
  );
}
