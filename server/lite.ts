import { orderAwardsBySelection } from '../domain/award-display-order.ts';
import { cycleAvailability, cycleOccupancyLabel } from '../domain/cycle-availability.ts';
import type { PublicCampaignView, AdminCampaignView } from './projections';

export { renderLitePdf } from './lite-pdf.ts';

/**
 * Read-only summary of a campaign for very old phones and for the PDF. It
 * carries what the web calendar's four views show (Tabla, Mapa, Meses, Por
 * CTA) and is built from the server's own projection, so the anonymous variant
 * shows exactly what public consultation shows (early choices stay concealed).
 */
export type LiteCycle = {
  date: string;
  end: string;
  score: number;
  summer: boolean;
  occupied: number;
  /** Visual slots of the Tabla view (local maximum). */
  max: number;
  /** Occupants in the order they chose (1º chose first). */
  codes: string[];
  /** Each column of the Tabla view, decided as cycle-table.tsx does (engine slots when ruled). */
  slots: { kind: 'occupied' | 'free' | 'blocked' | 'unknown' | 'extra'; code?: string }[];
  /** Effective availability from the engine, as the web shows it. */
  label: string;
  /** "2 libres", "? por confirmar"… as on the Mapa cards. */
  freeText: string;
  /** "1/3" ocupadas, as on the Mapa cards. */
  occupancy: string;
  /** Web colour class: vac2-free-0…4 or vac2-unknown. */
  status: string;
  full: boolean;
};
export type LiteSummary = {
  team: string;
  year: number;
  generatedAt: string;
  status: string;
  current: string | null;
  round: number | null;
  awarded: number;
  /** The campaign has an occupancy engine (the web's «ruled» palette and labels). */
  ruled: boolean;
  simulation: string | null;
  members: { code: string; dates: string[]; points: number }[];
  cycles: LiteCycle[];
};

export function liteSummary(view: PublicCampaignView | AdminCampaignView, now = new Date()): LiteSummary {
  const code = new Map(view.members.map((m) => [m.id, m.code]));
  const byMember = new Map<string, string[]>();
  const byCycle = new Map<string, string[]>();
  // Storage order is unspecified: show awards in the order they were chosen, as the web does.
  const awards = orderAwardsBySelection(view.awards, view.election?.timeline);
  for (const a of awards) {
    (byMember.get(a.member_id) ?? byMember.set(a.member_id, []).get(a.member_id)!).push(a.cycle_date);
    (byCycle.get(a.cycle_date) ?? byCycle.set(a.cycle_date, []).get(a.cycle_date)!).push(code.get(a.member_id) ?? '?');
  }
  const state = view.election?.state?.status;
  const turn = view.election?.turn;
  // Proof-based occupancy rules apply; never infer them from the year.
  const ruled = !!view.election?.occupancyPolicyVersion;
  const snapshot = view.election?.cycleAvailability;
  const cycles = view.result.cycles.map((c): LiteCycle => {
    const occupied = c.occupied ?? 0;
    const max = 'max' in c && typeof c.max === 'number' ? c.max : occupied;
    const cycle = { date: c.date, occupied, max };
    const availability = cycleAvailability(cycle, snapshot, ruled);
    const free = Math.max(0, max - occupied);
    const codes = byCycle.get(c.date) ?? [];
    const extra = free === 0 && 'available' in c && c.available === true;
    const columns = Math.max(4, max, occupied);
    const slots = Array.from({ length: columns }, (_, i): LiteCycle['slots'][number] => {
      if (codes[i]) return { kind: 'occupied', code: codes[i] };
      if (ruled) {
        const slot = availability.data?.slots?.[i];
        if (slot?.status === 'blocked') return { kind: 'blocked' };
        return !slot || slot.status === 'indeterminate' ? { kind: 'unknown' } : { kind: 'free' };
      }
      if (i < max) return { kind: 'free' };
      return i === max && extra ? { kind: 'extra' } : { kind: 'blocked' };
    });
    // Same wording as the Mapa cards in cycle-calendar.tsx.
    const freeText = ruled
      ? availability.label === '?'
        ? '? por confirmar'
        : availability.label === '—'
          ? 'en revisión'
          : availability.label === '1'
            ? '1 libre'
            : availability.label + ' libres'
      : extra
        ? 'Cupo adicional posible'
        : free + ' libres';
    return {
      date: c.date,
      end: 'end' in c && typeof c.end === 'string' ? c.end : c.date,
      score: 'score' in c && typeof c.score === 'number' ? c.score : 0,
      summer: 'period' in c && c.period === 1,
      occupied,
      max,
      codes,
      slots,
      label: availability.label,
      freeText,
      occupancy: cycleOccupancyLabel(cycle, snapshot, ruled),
      status: availability.className,
      full: availability.label === '0',
    };
  });
  const score = new Map(cycles.map((c) => [c.date, c.score]));
  const points = new Map<string, number>();
  for (const a of view.awards) points.set(a.member_id, (points.get(a.member_id) ?? 0) + (score.get(a.cycle_date) ?? 0));
  for (const p of view.election?.points ?? []) points.set(p.member_id, p.points);
  return {
    team: view.campaign.team_id,
    year: view.campaign.year,
    generatedAt: now.toISOString(),
    status: !state
      ? 'Elección sin iniciar'
      : state === 'active'
        ? 'Elección en curso'
        : state === 'paused'
          ? 'Elección en pausa'
          : 'Elección completada',
    current: state && state !== 'complete' && turn?.memberId ? (code.get(turn.memberId) ?? null) : null,
    round: state && state !== 'complete' ? (turn?.round ?? null) : null,
    awarded: view.awards.length,
    ruled,
    simulation:
      'scope_key' in view.campaign && view.campaign.scope_key && view.campaign.scope_key !== 'live'
        ? (view.campaign.simulation_name ?? 'Simulación')
        : null,
    members: view.members.map((m) => ({
      code: m.code,
      dates: (byMember.get(m.id) ?? []).sort(),
      points: points.get(m.id) ?? 0,
    })),
    cycles,
  };
}

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sept', 'oct', 'nov', 'dic'];
/** "5 ene", like the web's formatDate. */
export const dayMonth = (iso: string) => Number(iso.slice(8, 10)) + ' ' + MONTHS[Number(iso.slice(5, 7)) - 1];
export const stamp = (iso: string) =>
  new Date(iso).toLocaleString('es-ES', { timeZone: 'Europe/Madrid', dateStyle: 'short', timeStyle: 'short' });
/** Unique per generation, so a phone never reopens an older saved copy under the same name. */
export const pdfFilename = (s: LiteSummary) =>
  `vacaciones-equipo-${s.team}-${s.year}-${s.generatedAt.slice(0, 16).replace(/[-:]/g, '').replace('T', '-')}.pdf`;
const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function turnLine(s: LiteSummary) {
  return (
    s.status +
    (s.round ? ' · ronda ' + s.round : '') +
    (s.current ? ' · elige ahora ' + s.current : '') +
    ' · ' +
    s.awarded +
    (s.team === 'va' ? ' días adjudicados' : ' ciclos adjudicados')
  );
}

export type LiteIndex = { team: string; year: number }[];

/** Plain HTML with no JavaScript and old-browser-safe CSS. */
export function renderLiteHtml(index: LiteIndex, summary: LiteSummary | null, message = ''): string {
  const q = (t: string, y: number) => '?equipo=' + encodeURIComponent(t) + '&amp;year=' + y;
  const years = [...new Set(index.map((c) => c.year))].sort((a, b) => b - a);
  const picker = years
    .map(
      (y) =>
        '<p><b>' +
        y +
        ':</b> ' +
        index
          .filter((c) => c.year === y)
          .map((c) =>
            summary && summary.team === c.team && summary.year === y
              ? '<b>' + esc(c.team) + '</b>'
              : '<a href="/lite' + q(c.team, y) + '">' + esc(c.team) + '</a>',
          )
          .join(' · ') +
        '</p>',
    )
    .join('');
  let body = '';
  if (summary) {
    const s = summary;
    body =
      '<h2>Equipo ' +
      esc(s.team) +
      ' · ' +
      s.year +
      '</h2><p class="st">' +
      esc(turnLine(s)) +
      '</p><p class="m">Actualizado ' +
      esc(stamp(s.generatedAt)) +
      ' · <a href="/lite' +
      q(s.team, s.year) +
      '">Recargar</a> · <a href="/lite/pdf' +
      q(s.team, s.year) +
      '&amp;t=' +
      Date.parse(s.generatedAt) +
      '">Ver PDF</a></p>' +
      '<h3>Ciclos y plazas libres</h3><table><tr><th>Pts</th><th>Ciclo</th><th>Libres</th><th>Quién</th></tr>' +
      s.cycles
        .map(
          (c) =>
            '<tr' +
            (c.full ? ' class="full"' : c.summer ? ' class="summer"' : '') +
            '><td>' +
            c.score +
            '</td><td>' +
            esc(dayMonth(c.date) + ' – ' + dayMonth(c.end)) +
            '</td><td>' +
            esc(c.freeText) +
            '</td><td>' +
            esc(c.codes.join(', ')) +
            '</td></tr>',
        )
        .join('') +
      '</table><h3>Adjudicaciones por controlador</h3><table><tr><th>CTA</th><th>Ciclos</th><th>Pts</th></tr>' +
      s.members
        .map(
          (m) =>
            '<tr><td>' +
            esc(m.code) +
            '</td><td>' +
            (m.dates.length ? esc(m.dates.map(dayMonth).join(', ')) : '—') +
            '</td><td>' +
            m.points +
            '</td></tr>',
        )
        .join('') +
      '</table>';
  }
  return (
    '<!DOCTYPE html><html lang="es"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>Vacaciones · versión sencilla</title><style>' +
    'body{font-family:Arial,Helvetica,sans-serif;margin:8px;color:#111;background:#fff;font-size:15px}' +
    'h1{font-size:18px;margin:4px 0}h2{font-size:17px;margin:12px 0 4px}h3{font-size:15px;margin:14px 0 4px}' +
    'table{border-collapse:collapse;width:100%}th,td{border:1px solid #999;padding:3px 4px;text-align:left;vertical-align:top}' +
    'th{background:#ddd}tr.full td{color:#777}tr.summer td{background:#fbf3dc}.st{font-weight:bold}' +
    '.m{color:#444;font-size:13px}a{color:#0645ad}' +
    '</style></head><body><h1>Vacaciones · versión sencilla</h1>' +
    '<p class="m">Solo lectura, para móviles antiguos. Para elegir o editar usa la <a href="/">web completa</a>.</p>' +
    (message ? '<p><b>' + esc(message) + '</b></p>' : '') +
    picker +
    body +
    '</body></html>'
  );
}
