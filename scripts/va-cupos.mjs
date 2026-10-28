// «va-cupos»: RRHH's daily VA places, loaded and corrected only from here.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { readVaCalendarWorkbook } from '../lib/va-calendar.mjs';

const today = () => new Date().toISOString().slice(0, 10);

function calendarDays(file) {
  const bytes = readFileSync(file);
  if (/\.json$/i.test(file)) {
    const parsed = JSON.parse(bytes.toString('utf8'));
    return { bytes, days: parsed.days ?? parsed };
  }
  return { bytes, days: readVaCalendarWorkbook(bytes) };
}

function yearOf(days, flagYear, fail) {
  const years = [...new Set(Object.keys(days).map((d) => Number(d.slice(0, 4))))];
  const year = flagYear !== undefined ? Number(flagYear) : years.length === 1 ? years[0] : NaN;
  if (!Number.isInteger(year)) fail('El calendario mezcla años (' + years.join(', ') + '): indica --year AAAA');
  if (years.some((y) => y !== year)) fail('El calendario tiene días de ' + years.join(', ') + ', no solo de ' + year);
  return year;
}

/**
 * The request for a «va-cupos» order. `prepare` runs after signing in, for the orders
 * that start from the calendar already loaded.
 */
export function vaQuotaPlan(rest, flags, fail) {
  const [sub, ...args] = rest;
  if (sub === 'ver') {
    if (!flags.year) fail('Indica --year AAAA. Ayuda: admin-cli.mjs help va-cupos');
    return { method: 'GET', route: 'va/quotas?year=' + encodeURIComponent(flags.year) };
  }
  if (sub === 'importar' || sub === 'aplicar') {
    const file = args[0];
    if (!file) fail('Indica el calendario de RRHH (.xlsm, .xlsx o .json). Ayuda: admin-cli.mjs help va-cupos');
    if (sub === 'aplicar' && !flags['review-token'])
      fail('aplicar necesita --review-token con el token de la vista previa de «va-cupos importar»');
    const { bytes, days } = calendarDays(file);
    const year = yearOf(days, flags.year, fail);
    return {
      method: 'POST',
      route: 'va/quotas',
      body: {
        action: sub === 'importar' ? 'preview' : 'apply',
        year,
        source: {
          title: flags.title ?? path.basename(file),
          sha256: createHash('sha256').update(bytes).digest('hex'),
          receivedAt: flags.received ?? today(),
        },
        days,
        ...(sub === 'aplicar' ? { reviewToken: flags['review-token'] } : {}),
      },
    };
  }
  if (sub === 'cambiar') {
    const [date, raw] = args,
      places = Number(raw);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '') || !Number.isInteger(places) || places < 0)
      fail('Uso: va-cupos cambiar AAAA-MM-DD PLAZAS [--review-token T]. Ayuda: admin-cli.mjs help va-cupos');
    return {
      method: 'POST',
      route: 'va/quotas',
      body: null,
      // Same full-calendar review as an import, so one rule guards every change.
      prepare: async (client) => {
        const year = Number(date.slice(0, 4));
        const now = await client.request('GET', 'va/quotas?year=' + year);
        if (!now.ok)
          fail('No se pudo leer el calendario de ' + year + ' (' + now.status + '): ' + (now.data?.error ?? ''));
        if (!now.data.source) fail('No hay calendario cargado para ' + year + ': usa primero «va-cupos importar»');
        return {
          action: flags['review-token'] ? 'apply' : 'preview',
          year,
          source: {
            title: now.data.source.title.replace(/ · corregido$/, '').slice(0, 148) + ' · corregido',
            sha256: now.data.source.sha256,
            receivedAt: today(),
          },
          days: { ...now.data.days, [date]: places },
          ...(flags['review-token'] ? { reviewToken: flags['review-token'] } : {}),
        };
      },
    };
  }
  fail('Orden de va-cupos desconocida: ' + (sub ?? '(ninguna)') + '. Ayuda: admin-cli.mjs help va-cupos');
}

/** One line for whoever reads stderr; the JSON on stdout stays complete. */
export function vaQuotaSummary(data, order) {
  const lines = [
    `${data.year}: ${data.daysWithPlaces} días con plazas, ${data.totalPlaces} plazas, ${data.daysWithoutPlaces} días sin plazas.`,
  ];
  if (data.entitledDays !== null && data.entitledDays !== undefined)
    lines.push(`Días VA reconocidos en el censo: ${data.entitledDays}.`);
  if (data.changedDays !== undefined) lines.push(`Días que cambian respecto a lo cargado: ${data.changedDays}.`);
  if (data.reviewToken)
    lines.push(
      'Vista previa: no se ha escrito nada. Para aplicarla repite la misma orden con «' +
        (order === 'cambiar' ? 'cambiar' : 'aplicar') +
        '» y --review-token ' +
        data.reviewToken,
    );
  if (data.applied) lines.push('Calendario aplicado.');
  return lines.join('\n');
}
