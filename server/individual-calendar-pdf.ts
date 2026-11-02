import { rotationCode, serial, type Config } from '../domain/calendar.ts';
import { calendarHolidaysForYear } from '../domain/official-holidays.ts';
import { Page, writePdf } from './lite-pdf.ts';
import type { LiteSummary } from './lite.ts';
import { VA_TEAM } from '../domain/policy-va.ts';

/**
 * One-page A4 landscape calendar for one controller, using the same vector
 * layout engine and PDF encoder as the team report (Cloudflare-compatible).
 * Shows only visible awarded cycles, never hidden/early choices.
 */
const colour = (hex: string): [number, number, number] =>
  [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
const NAVY = colour('#203b5b');
const INK = colour('#203047');
const MUTED = colour('#546474');
const WORK = colour('#d6dadd');
const VACATION = colour('#68b9e8');
const LOCAL = colour('#e79b44');
const WHITE = colour('#ffffff');
const GRID = colour('#e2e7ec');
const MONTHS = [
  'ENERO',
  'FEBRERO',
  'MARZO',
  'ABRIL',
  'MAYO',
  'JUNIO',
  'JULIO',
  'AGOSTO',
  'SEPTIEMBRE',
  'OCTUBRE',
  'NOVIEMBRE',
  'DICIEMBRE',
];
const WEEKDAYS = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];

type Range = { date: string; end: string };

export function individualCalendarRanges(summary: LiteSummary, code: string): Range[] {
  const member = summary.members.find((m) => m.code === code);
  if (!member) throw new Error('El controlador no pertenece a esta campaña');
  const cycles = new Map(summary.cycles.map((c) => [c.date, c]));
  return member.dates
    .map((date) => {
      const c = cycles.get(date);
      if (!c) throw new Error('El ciclo adjudicado no está en el calendario de la campaña');
      return { date, end: c.end };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function renderIndividualCalendarPdf(summary: LiteSummary, code: string, config: Config): string {
  const year = summary.year;
  const ranges = individualCalendarRanges(summary, code);
  const holidays = calendarHolidaysForYear(year, config);
  const byDay = new Map(holidays.map((h) => [h.date, h]));
  const page = new Page(842, 595);
  // VA has no shift rotation of its own: only the awarded days are drawn.
  const va = summary.team === VA_TEAM;

  page.text(
    16,
    25,
    va ? `VACACIONES DE ANTIGÜEDAD · ${code} · ${year}` : `EQUIPO ${summary.team} · ${code} · ${year}`,
    { size: 17, bold: true, color: INK },
  );
  page.text(
    16,
    40,
    va
      ? 'Azul: días de VA adjudicados'
      : 'Gris: turno de trabajo (5 días)   Blanco: descanso (3 días)   Azul: vacaciones adjudicadas',
    {
      size: 8,
      color: MUTED,
    },
  );
  page.rect(16, 47, 8, 8, LOCAL);
  page.text(28, 54, 'Marca naranja: fiesta local de Sevilla', { size: 7, color: MUTED });
  page.text(
    826,
    54,
    'Actualizado ' + new Date(summary.generatedAt).toLocaleDateString('es-ES', { timeZone: 'Europe/Madrid' }),
    {
      size: 7,
      color: MUTED,
      align: 'right',
    },
  );

  // The in-cell names are tiny and truncated, so the full list is also printed legibly in the header.
  const fmtDay = (iso: string) => iso.slice(8, 10) + '/' + iso.slice(5, 7);
  const legend: string[] = [];
  let line = '';
  for (const h of [...holidays].sort((a, b) => a.date.localeCompare(b.date))) {
    const item = fmtDay(h.date) + ' ' + h.label + (h.local ? ' (local)' : '');
    if (line && (line + '  ·  ' + item).length > 105) {
      legend.push(line);
      line = item;
    } else line = line ? line + '  ·  ' + item : item;
  }
  if (line) legend.push(line);
  legend.slice(0, 4).forEach((l, i) => page.text(826, 17 + i * 8.5, l, { size: 6.2, color: MUTED, align: 'right' }));

  const tileW = 195,
    tileH = 154,
    xGap = 9,
    yGap = 5;
  for (let month = 0; month < 12; month++) {
    const col = month % 4;
    const row = Math.floor(month / 4);
    const x = 16 + col * (tileW + xGap);
    const y = 67 + row * (tileH + yGap);
    page.rect(x, y, tileW, 20, NAVY);
    page.text(x + tileW / 2, y + 14, MONTHS[month], {
      size: 9.5,
      bold: true,
      color: WHITE,
      align: 'center',
    });
    const cellW = (tileW - 8) / 7,
      cellH = 18.7;
    WEEKDAYS.forEach((weekday, i) =>
      page.text(x + 4 + (i + 0.5) * cellW, y + 31, weekday, {
        size: 7,
        align: 'center',
        color: MUTED,
      }),
    );
    const firstWeekday = (new Date(Date.UTC(year, month, 1)).getUTCDay() + 6) % 7;
    const days = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    for (let day = 1; day <= days; day++) {
      const iso = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const slot = firstWeekday + day - 1;
      const cx = x + 4 + (slot % 7) * cellW;
      const cy = y + 36 + Math.floor(slot / 7) * cellH;
      const awarded = ranges.some((r) => r.date <= iso && iso <= r.end);
      const working = !va && rotationCode(serial(iso), year, summary.team, config) !== ' ';
      if (awarded || working) page.rect(cx + 0.6, cy + 0.5, cellW - 1.2, cellH - 1.1, awarded ? VACATION : WORK);
      else page.rect(cx + 0.6, cy + 0.5, cellW - 1.2, cellH - 1.1, WHITE, GRID, 0.25);
      page.text(cx + cellW / 2, cy + 9.8, String(day), {
        size: 8.2,
        bold: awarded,
        align: 'center',
        color: INK,
      });
      const holiday = byDay.get(iso);
      if (holiday) {
        if (holiday.local) page.rect(cx + 1.5, cy + 1.3, 4.2, 4.2, LOCAL);
        page.text(cx + cellW / 2, cy + 16.2, holiday.label, {
          size: 4.1,
          align: 'center',
          max: cellW - 2,
          color: INK,
        });
      }
    }
  }

  page.text(
    16,
    550,
    holidays.length
      ? 'Festivos nacionales, autonómicos y locales: reglas del ejercicio ' + year
      : 'ATENCIÓN: festivos laborales pendientes de configurar en las reglas del ejercicio ' + year,
    { size: 7.2, color: MUTED },
  );
  const fmt = (iso: string) => iso.slice(8, 10) + '/' + iso.slice(5, 7);
  const periods = ranges.map((r) => (r.date === r.end ? fmt(r.date) : fmt(r.date) + '-' + fmt(r.end)));
  page.text(
    16,
    565,
    (va ? 'Días adjudicados: ' : 'Periodos adjudicados: ') + (periods.slice(0, 4).join('  |  ') || 'Ninguno'),
    {
      size: 7.6,
      color: INK,
      max: 805,
    },
  );
  if (periods.length > 4) page.text(16, 579, periods.slice(4).join('  |  '), { size: 7.6, color: INK, max: 805 });
  else
    page.text(16, 579, 'Fechas inclusivas. Las vacaciones reflejan únicamente las adjudicaciones visibles.', {
      size: 7.1,
      color: MUTED,
    });
  return writePdf([page]);
}
