'use client';
import { useEffect, useState } from 'react';
import { api, apiFetch } from './api-client';

type HrMember = { id: string; code: string; label: string; hrName: string | null; suggested: string | null };
type HrStatus = {
  year: number;
  template: { sha256: string; uploadedAt: string } | null;
  roster: string[];
  closed: boolean;
  members: HrMember[];
};

/**
 * RRHH's Excel workbook: the superadministrator uploads it once a year; each
 * team's administrator matches people to the RRHH names and downloads the
 * workbook with only their own sheet filled in, so other teams stay untouched.
 */
/** Save the workbook the API returns; resolves to the open teams it left out, if any. */
async function downloadXlsm(path: string, fallback: string) {
  const response = await apiFetch(path);
  if (!response.ok)
    throw new Error(((await response.json()) as { error?: string } | null)?.error ?? 'No se pudo generar el Excel');
  const name = response.headers.get('Content-Disposition')?.match(/filename="([^"]+)"/)?.[1] ?? fallback;
  const url = URL.createObjectURL(await response.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return response.headers.get('X-Equipos-Abiertos') ?? '';
}

type Perform = (fn: () => Promise<unknown>, message: string, options?: { refreshIndex?: boolean }) => Promise<unknown>;

export default function HrExportPanel({
  cid,
  team,
  superuser,
  busy,
  closed,
  perform,
}: {
  cid: string;
  team: string;
  superuser: boolean;
  busy: boolean;
  closed: boolean;
  perform: Perform;
}) {
  const [status, setStatus] = useState<HrStatus | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const show = (s: HrStatus) => {
    setStatus(s);
    setNames(Object.fromEntries(s.members.map((m) => [m.id, m.hrName ?? m.suggested ?? ''])));
  };
  useEffect(() => {
    let live = true;
    api<HrStatus>('hr/' + cid)
      .then((s) => live && show(s))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [cid, closed]);

  const pending = status ? status.members.filter((m) => (names[m.id] || null) !== m.hrName) : [];
  const unmatched = status ? status.members.filter((m) => !names[m.id]) : [];

  return (
    <section className="panel hr-export">
      <h2>Excel de RRHH</h2>
      <p className="muted">
        Descarga la plantilla de RRHH con la hoja del equipo {team} rellena con las vacaciones adjudicadas. Las hojas de
        los demás equipos quedan como están.
      </p>
      {error && <p className="alert error">{error}</p>}
      {superuser && (
        <label className="hr-upload">
          {status?.template ? 'Sustituir la plantilla de RRHH' : 'Subir la plantilla de RRHH'} ({status?.year ?? '…'})
          <input
            type="file"
            accept=".xlsm"
            disabled={busy || !status}
            onChange={async (e) => {
              const file = e.currentTarget.files?.[0];
              e.currentTarget.value = '';
              if (!file || !status) return;
              const bytes = new Uint8Array(await file.arrayBuffer());
              let binary = '';
              for (let i = 0; i < bytes.length; i += 0x8000)
                binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
              await perform(
                async () => {
                  await api('hr', { body: { action: 'template', year: status.year, data: btoa(binary) } });
                  show(await api<HrStatus>('hr/' + cid));
                },
                'Plantilla de RRHH guardada',
                { refreshIndex: false },
              );
            }}
          />
        </label>
      )}
      {status && !status.template && (
        <p>
          {superuser
            ? `Sube la plantilla ${status.year} que envía RRHH para poder exportar.`
            : `Falta la plantilla de RRHH de ${status.year}: pídesela a un superadministrador.`}
        </p>
      )}
      {status?.template && (
        <>
          <details open={unmatched.length > 0}>
            <summary>
              Nombres de RRHH {unmatched.length ? `· ${unmatched.length} sin asignar` : '· todos asignados'}
            </summary>
            <p className="muted">
              Elige cómo figura cada persona en la columna J de la hoja {team}. Las propuestas automáticas aparecen ya
              seleccionadas: revísalas y guarda.
            </p>
            <div className="hr-names">
              {status.members.map((m) => (
                <label key={m.id}>
                  <span>{m.label ? `${m.label} · ${m.code}` : m.code}</span>
                  <select
                    aria-label={'Nombre de RRHH de ' + m.code}
                    value={names[m.id] ?? ''}
                    disabled={busy}
                    onChange={(e) => setNames({ ...names, [m.id]: e.target.value })}
                  >
                    <option value="">— Sin asignar —</option>
                    {status.roster.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
            <div className="button-row">
              <button
                className="secondary"
                disabled={busy || !pending.length}
                onClick={() =>
                  perform(
                    async () =>
                      show(
                        await api<HrStatus>('hr/' + cid, {
                          body: {
                            action: 'names',
                            names: Object.fromEntries(pending.map((m) => [m.id, names[m.id] || null])),
                          },
                        }),
                      ),
                    'Nombres de RRHH guardados',
                    { refreshIndex: false },
                  )
                }
              >
                Guardar nombres
              </button>
            </div>
          </details>
          {!closed && <p className="muted">Cierra el equipo {team} para poder descargar su Excel.</p>}
          <div className="button-row">
            <button
              className="primary"
              disabled={busy || !closed || pending.length > 0}
              onClick={() =>
                perform(
                  () => downloadXlsm('hr/' + cid + '/xlsm', `${status.year}_LECS_Vac_${team}.xlsm`),
                  'Excel de RRHH descargado',
                  { refreshIndex: false },
                )
              }
            >
              Descargar Excel de RRHH · equipo {team}
            </button>
          </div>
          {pending.length > 0 && <p className="muted">Guarda los nombres antes de descargar.</p>}
          {superuser && (
            <>
              <h3>Todos los turnos</h3>
              <p className="muted">
                Rellena las hojas de todos los equipos cerrados o publicados. Las de los equipos abiertos quedan vacías.
              </p>
              <div className="button-row">
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() =>
                    perform(
                      async () => {
                        setNote('');
                        const open = await downloadXlsm(
                          'hr/global/' + status.year + '/xlsm',
                          `${status.year}_LECS_Vac_global.xlsm`,
                        );
                        if (open)
                          setNote('Sin incluir, por estar abiertos: equipos ' + open.split(',').join(', ') + '.');
                      },
                      'Excel de RRHH de todos los turnos descargado',
                      { refreshIndex: false },
                    )
                  }
                >
                  Descargar Excel de RRHH · todos los turnos
                </button>
              </div>
              {note && <p className="alert warning">{note}</p>}
            </>
          )}
        </>
      )}
    </section>
  );
}
