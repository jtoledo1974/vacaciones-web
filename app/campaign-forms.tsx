'use client';
import { download } from './download';
import { officialHolidays, type CalendarHoliday } from '../domain/official-holidays';
import { useEffect, useState } from 'react';
import { CheckCheck, Plus } from 'lucide-react';

export function CampaignForm({ campaigns, busy, create }: any) {
  const max = Math.max(...campaigns.map((c: any) => c.year));
  return (
    <form
      className="entry-form"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        create({
          year: Number(f.get('year')),
          copyYear: f.get('copy') ? Number(f.get('copy')) : null,
          rosterYear:
            f.get('roster') === 'latest' ? 'latest' : f.get('roster') === 'empty' ? null : Number(f.get('roster')),
        });
      }}
    >
      <label>
        Nuevo ejercicio
        <input name="year" type="number" min="2013" max="2200" defaultValue={max + 1} required />
      </label>
      <label>
        Copiar parámetros de
        <select name="copy">
          <option value="">Reglas originales</option>
          {Array.from(new Set(campaigns.map((c: any) => c.year))).map((y: any) => (
            <option key={y}>{y}</option>
          ))}
        </select>
      </label>
      <label>
        Plantilla inicial
        <select name="roster">
          <option value="latest">Último ejercicio anterior de cada equipo</option>
          <option value="empty">Empezar sin controladores</option>
          {Array.from(new Set(campaigns.map((c: any) => c.year))).map((y: any) => (
            <option key={y} value={y}>
              Copiar plantilla de {y}
            </option>
          ))}
        </select>
      </label>
      <button className="primary" disabled={busy}>
        <Plus size={16} />
        Crear ejercicio
      </button>
    </form>
  );
}

const configDraft = (config: any) => ({
  ...config,
  relation: config.relation ?? { minimum: 1, base: 2, maximum: 3, graceJanuary: 0, graceOctober: 0 },
});
/** Follows remote changes while the draft is clean; a dirty draft is kept and flagged. */
export function ConfigForm({ config, year, disabled, busy, save }: any) {
  const [c, setC] = useState(() => configDraft(config));
  const [base, setBase] = useState(() => configDraft(config));
  const dirty = JSON.stringify(c) !== JSON.stringify(base);
  const remote = configDraft(config);
  const remoteChanged = JSON.stringify(remote) !== JSON.stringify(base);
  const savedRemote = JSON.stringify(remote) === JSON.stringify(c);
  useEffect(() => {
    if (remoteChanged && (!dirty || savedRemote)) {
      setC(remote);
      setBase(remote);
    }
  }, [remoteChanged, dirty, savedRemote]);
  const change = (k: string, v: any) => setC({ ...c, [k]: v });
  const arr = (key: string, i: number, v: number) => {
    const a = [...c[key]];
    a[i] = v;
    change(key, a);
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save(c);
      }}
    >
      {dirty && remoteChanged && !savedRemote && (
        <div role="status" className="alert">
          Los parámetros han cambiado en el servidor mientras editabas. Tus cambios se conservan; al guardar sustituirán
          a los actuales.{' '}
          <button
            type="button"
            className="secondary"
            onClick={() => {
              setC(remote);
              setBase(remote);
            }}
          >
            Descartar mis cambios
          </button>
        </div>
      )}
      <section className="panel">
        <div className="section-head">
          <div>
            <h2>Calendario y ciclos</h2>
            <p>Parámetros exclusivos de {year}; los otros ejercicios no cambian.</p>
          </div>
          <span className="tag">{disabled ? 'Consulta' : 'Editable'}</span>
        </div>
        <div className="form-grid">
          {[
            ['cyclesPerPerson', 'Ciclos por persona'],
            ['summerPerPerson', 'Ciclos de verano'],
            ['cycleLength', 'Duración del ciclo'],
          ].map(([k, l]) => (
            <label key={k}>
              {l}
              <input
                type="number"
                min={0}
                max={100}
                disabled={disabled || k === 'cycleLength'}
                value={c[k]}
                onChange={(e) => change(k, Number(e.target.value))}
              />
            </label>
          ))}
          {[
            ['summerStart', 'Primer ciclo de verano'],
            ['summerEnd', 'Último ciclo de verano'],
            ['correturnos', 'Día correturnos'],
          ].map(([k, l]) => (
            <label key={k}>
              {l}
              <input type="date" disabled={disabled} value={c[k]} onChange={(e) => change(k, e.target.value)} />
            </label>
          ))}
        </div>
        <div className="team-checkboxes">
          {[
            ['excludeLast', 'Excluir último ciclo'],
            ['excludePenultimate', 'Excluir penúltimo ciclo'],
            ['commonGrace', 'Graciables comunes no verano'],
            ['commonConvention', 'Convenio común no verano'],
          ].map(([k, l]) => (
            <label key={k}>
              <input
                type="checkbox"
                disabled={disabled}
                checked={c[k]}
                onChange={(e) => {
                  const next = { ...c, [k]: e.target.checked };
                  if (k === 'excludePenultimate') next.excludeLast = true;
                  if (k === 'excludeLast' && e.target.checked) next.excludePenultimate = false;
                  setC(next);
                }}
              />
              {l}
            </label>
          ))}
        </div>
        <label>
          Reparto de convenio enero–mayo
          <input
            type="number"
            min={0}
            disabled={disabled || c.commonConvention}
            value={c.conventionJanuary}
            onChange={(e) => change('conventionJanuary', Number(e.target.value))}
          />
        </label>
      </section>
      <section className="panel">
        <h2>Cupos por período</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Período</th>
                <th>Mínimo</th>
                <th>Base</th>
                <th>Graciables</th>
              </tr>
            </thead>
            <tbody>
              {['Enero – mayo', 'Verano', 'Octubre – diciembre'].map((p, i) => (
                <tr key={p}>
                  <td>{p}</td>
                  {['min', 'base', 'grace'].map((k) => (
                    <td key={k}>
                      <input
                        aria-label={k + ' ' + p}
                        type="number"
                        min={0}
                        max={100}
                        value={c[k][i]}
                        disabled={disabled}
                        onChange={(e) => arr(k, i, Number(e.target.value))}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="panel">
        <h2>Cupos de la relación de vacaciones</h2>
        <p className="muted">Controles independientes de los cupos de planificación, como en el original.</p>
        <div className="form-grid">
          {[
            ['minimum', 'Mínimo'],
            ['base', 'Base'],
            ['maximum', 'Máximo'],
            ['graceJanuary', 'Extra enero–mayo'],
            ['graceOctober', 'Extra octubre–diciembre'],
          ].map(([k, l]) => (
            <label key={k}>
              {l}
              <input
                type="number"
                min={0}
                max={100}
                disabled={disabled}
                value={c.relation[k]}
                onChange={(e) => change('relation', { ...c.relation, [k]: Number(e.target.value) })}
              />
            </label>
          ))}
        </div>
      </section>
      <section className="panel">
        <h2>Ponderación del baremo</h2>
        <div className="form-grid">
          {c.weights.map((n: number, i: number) => (
            <label key={i}>
              Columna {i + 1}
              <input
                type="number"
                min={0}
                value={n}
                disabled={disabled}
                onChange={(e) => arr('weights', i, Number(e.target.value))}
              />
            </label>
          ))}
        </div>
        <details>
          <summary>Baremo diario por tramos</summary>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Mes / día</th>
                  <th>Ejercicio</th>
                  <th>Puntuación</th>
                </tr>
              </thead>
              <tbody>
                {c.baseScores.map((s: any, i: number) => (
                  <tr key={i}>
                    <td>
                      {s.day}/{s.month}
                    </td>
                    <td>{s.nextYear ? 'Siguiente' : 'Actual'}</td>
                    <td>
                      <input
                        type="number"
                        min={0}
                        disabled={disabled}
                        value={s.score}
                        onChange={(e) => {
                          const a = structuredClone(c.baseScores);
                          a[i].score = Number(e.target.value);
                          change('baseScores', a);
                        }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </section>
      <section className="panel">
        <h2>Festivos laborales de Sevilla · {year}</h2>
        <p className="muted">
          Festivos nacionales, autonómicos y dos locales. Se usan exclusivamente para mostrar el calendario individual,
          no para modificar el baremo de vacaciones. Las fechas se fijan por ejercicio y no se copian a otros años.
        </p>
        {(c.calendarHolidays ?? officialHolidays(year)).length === 0 && (
          <p className="alert warning" role="status">
            Este ejercicio no tiene festivos laborales configurados. Comprueba las publicaciones oficiales antes de
            distribuir calendarios individuales.
          </p>
        )}
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Festividad</th>
                <th>Local</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {(c.calendarHolidays ?? officialHolidays(year)).map((holiday: CalendarHoliday, i: number) => (
                <tr key={i}>
                  <td>
                    <input
                      aria-label={'Fecha del festivo ' + (i + 1)}
                      type="date"
                      value={holiday.date}
                      disabled={disabled}
                      onChange={(e) => {
                        const items = structuredClone(c.calendarHolidays ?? officialHolidays(year));
                        items[i].date = e.target.value;
                        change('calendarHolidays', items);
                      }}
                    />
                  </td>
                  <td>
                    <input
                      aria-label={'Nombre del festivo ' + (i + 1)}
                      value={holiday.label}
                      disabled={disabled}
                      onChange={(e) => {
                        const items = structuredClone(c.calendarHolidays ?? officialHolidays(year));
                        items[i].label = e.target.value;
                        change('calendarHolidays', items);
                      }}
                    />
                  </td>
                  <td>
                    <input
                      aria-label={'Festivo local ' + (i + 1)}
                      type="checkbox"
                      checked={!!holiday.local}
                      disabled={disabled}
                      onChange={(e) => {
                        const items = structuredClone(c.calendarHolidays ?? officialHolidays(year));
                        items[i].local = e.target.checked;
                        change('calendarHolidays', items);
                      }}
                    />
                  </td>
                  <td>
                    <button
                      type="button"
                      className="secondary"
                      disabled={disabled}
                      onClick={() =>
                        change(
                          'calendarHolidays',
                          (c.calendarHolidays ?? officialHolidays(year)).filter(
                            (_: CalendarHoliday, index: number) => index !== i,
                          ),
                        )
                      }
                    >
                      Quitar
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!disabled && (
          <button
            type="button"
            className="secondary"
            onClick={() => {
              const items: CalendarHoliday[] = c.calendarHolidays ?? officialHolidays(year);
              // First free day of the year, so repeated clicks never create duplicate dates.
              const used = new Set(items.map((h) => h.date));
              const day = new Date(Date.UTC(year, 0, 2));
              while (used.has(day.toISOString().slice(0, 10))) day.setUTCDate(day.getUTCDate() + 1);
              change('calendarHolidays', [
                ...items,
                { date: day.toISOString().slice(0, 10), label: 'Nuevo festivo', local: false },
              ]);
            }}
          >
            Añadir festivo
          </button>
        )}
      </section>
      <section className="panel">
        <h2>Festivos y períodos especiales</h2>
        <p className="muted">
          Se conservan las fechas y desplazamientos del original. Miércoles de Feria utiliza +18 días respecto a Pascua.
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Festivo</th>
                <th>Regla de fecha</th>
                <th>Puntuación</th>
              </tr>
            </thead>
            <tbody>
              {c.holidays.map((h: any, i: number) => (
                <tr key={i}>
                  <td>{h.label}</td>
                  <td>
                    {h.offset !== undefined
                      ? 'Pascua ' + (h.offset >= 0 ? '+' : '') + h.offset
                      : `${h.day}/${h.month}${h.nextYear ? ' siguiente' : ''}`}
                  </td>
                  <td>
                    <input
                      type="number"
                      min={0}
                      disabled={disabled}
                      value={h.score}
                      onChange={(e) => {
                        const a = structuredClone(c.holidays);
                        a[i].score = Number(e.target.value);
                        change('holidays', a);
                      }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <details>
          <summary>Configuración avanzada: fechas, rotación y baremos</summary>
          <p className="muted">
            Exporta y conserva los parámetros antes de cambiar las reglas. La validación del servidor revisa el
            contenido.
          </p>
          <button
            type="button"
            className="secondary"
            onClick={() => download(`parametros-${year}.json`, JSON.stringify(c, null, 2))}
          >
            Exportar parámetros
          </button>
          {/* Remount whenever the draft changes elsewhere (other fields, remote updates),
              so blurring this box never writes back a stale copy. */}
          <textarea
            key={JSON.stringify(c)}
            aria-label="Parámetros completos"
            rows={16}
            disabled={disabled}
            defaultValue={JSON.stringify(c, null, 2)}
            onBlur={(e) => {
              try {
                setC(JSON.parse(e.target.value));
              } catch {
                e.target.setCustomValidity('JSON no válido');
              }
            }}
            onChange={(e) => e.target.setCustomValidity('')}
          />
        </details>
      </section>
      {!disabled && (
        <div className="save-bar">
          <span>Guardar afectará únicamente a la campaña seleccionada.</span>
          <button className="primary" disabled={busy}>
            Guardar parámetros <CheckCheck size={16} />
          </button>
        </div>
      )}
    </form>
  );
}
