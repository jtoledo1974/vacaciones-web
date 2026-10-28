import { dayMonth, stamp, turnLine, type LiteSummary } from './lite.ts';

/**
 * The web calendar's four views (Tabla, Mapa, Meses, Por CTA), one A4 page
 * each, drawn as vector PDF with the web's colours. Minimal PDF 1.4 writer:
 * standard Helvetica (no embedded fonts), WinAnsi text, no dependencies, so a
 * Worker can answer it as an ordinary link the browser shows directly.
 */

const W = 595,
  H = 842,
  M = 28;

type RGB = [number, number, number];
const hex = (h: string): RGB => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as RGB;
const INK = hex('#1f3e36'),
  MUTED = hex('#5d6f68'),
  LINE = hex('#dbe3df'),
  OCCUPIED = hex('#e6ebe8'),
  SUMMER = hex('#e0a526');

// The palette vacaciones.css applies today (same for campaigns with and without
// an occupancy engine): dark green = many places, grey stripes = full,
// white with a dashed edge = not yet determined.
const PALETTE: Record<string, { bg: string; fg: string }> = {
  'vac2-free-4': { bg: '#0b4f40', fg: '#ffffff' },
  'vac2-free-3': { bg: '#1f7a60', fg: '#ffffff' },
  'vac2-free-2': { bg: '#9fd3bd', fg: '#0d2b23' },
  'vac2-free-1': { bg: '#dcefe6', fg: '#0d2b23' },
  'vac2-free-0': { bg: '#eceeed', fg: '#3d4744' },
  'vac2-unknown': { bg: '#ffffff', fg: '#2a3330' },
};
const STRIPE = hex('#dde1df'),
  EDGE = hex('#c9d6d0'),
  DASHED = hex('#6c7480');
const colours = (status: string) => {
  const c = PALETTE[status] ?? PALETTE['vac2-unknown'];
  return { bg: hex(c.bg), fg: hex(c.fg) };
};

// Helvetica advance widths (1/1000 em) for ASCII 32–126.
const WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556,
  556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833,
  722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556,
  556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334,
  260, 334, 584,
];
function textWidth(s: string, size: number, bold = false) {
  let w = 0;
  for (const ch of s.normalize('NFD').replace(/[̀-ͯ]/g, '')) {
    const n = ch.codePointAt(0)!;
    w += n >= 32 && n <= 126 ? WIDTHS[n - 32] : 556;
  }
  return (w * size * (bold ? 1.07 : 1)) / 1000;
}
function pdfText(s: string) {
  let out = '';
  for (const ch of s) {
    const n = ch.codePointAt(0)!;
    if (ch === '(' || ch === ')' || ch === '\\') out += '\\' + ch;
    else if (n >= 32 && n < 127) out += ch;
    else if (n >= 160 && n <= 255) out += '\\' + n.toString(8).padStart(3, '0');
    else if (ch === '·') out += '\\267';
    else if (ch === '–' || ch === '—') out += '\\226';
    else if (ch === '×') out += '\\327';
    else out += '?';
  }
  return '(' + out + ')';
}
const n = (v: number) => String(Math.round(v * 100) / 100);
const rgb = (c: RGB) => c.map(n).join(' ');

/** Drawing in top-left coordinates, as the web lays it out. */
export class Page {
  constructor(
    readonly width = W,
    readonly height = H,
  ) {}
  ops = '';
  rect(x: number, y: number, w: number, h: number, fill: RGB | null, stroke: RGB | null = null, lw = 0.5) {
    if (fill) this.ops += `${rgb(fill)} rg `;
    if (stroke) this.ops += `${rgb(stroke)} RG ${n(lw)} w `;
    this.ops += `${n(x)} ${n(this.height - y - h)} ${n(w)} ${n(h)} re ${fill && stroke ? 'B' : fill ? 'f' : 'S'}\n`;
  }
  /** A cycle's availability box exactly as the web paints it; returns its text colour. */
  swatch(x: number, y: number, w: number, h: number, status: string, border = true) {
    const c = colours(status);
    this.rect(x, y, w, h, c.bg);
    if (status === 'vac2-free-0') {
      // Diagonal stripes, clipped to the box.
      this.ops += `q ${n(x)} ${n(this.height - y - h)} ${n(w)} ${n(h)} re W n ${rgb(STRIPE)} RG 1.6 w `;
      for (let d = -h; d < w; d += 5)
        this.ops += `${n(x + d)} ${n(this.height - y - h)} m ${n(x + d + h)} ${n(this.height - y)} l `;
      this.ops += 'S Q\n';
    }
    if (status === 'vac2-unknown')
      this.ops += `[2 1.5] 0 d ${rgb(DASHED)} RG 1 w ${n(x + 0.5)} ${n(this.height - y - h + 0.5)} ${n(w - 1)} ${n(h - 1)} re S [] 0 d\n`;
    else if (border) this.rect(x, y, w, h, null, EDGE, 0.5);
    return c.fg;
  }
  line(x1: number, y1: number, x2: number, y2: number, color: RGB, lw = 0.5) {
    this.ops += `${rgb(color)} RG ${n(lw)} w ${n(x1)} ${n(this.height - y1)} m ${n(x2)} ${n(this.height - y2)} l S\n`;
  }
  /** `y` is the baseline. */
  text(
    x: number,
    y: number,
    s: string,
    o: { size?: number; bold?: boolean; color?: RGB; align?: 'left' | 'right' | 'center'; max?: number } = {},
  ) {
    const size = o.size ?? 8,
      bold = !!o.bold;
    let str = s;
    if (o.max) while (str.length > 1 && textWidth(str, size, bold) > o.max) str = str.slice(0, -2) + '.';
    const w = textWidth(str, size, bold);
    const left = o.align === 'right' ? x - w : o.align === 'center' ? x - w / 2 : x;
    this.ops += `${rgb(o.color ?? INK)} rg BT /${bold ? 'F2' : 'F1'} ${n(size)} Tf 1 0 0 1 ${n(left)} ${n(this.height - y)} Tm ${pdfText(str)} Tj ET\n`;
    if (o.align === undefined || o.align === 'left') return left + w;
    return left;
  }
}

function header(p: Page, s: LiteSummary, view: string, page: number, pages: number) {
  p.text(M, M + 14, `Vacaciones · Equipo ${s.team} · ${s.year}`, { size: 15, bold: true });
  p.text(W - M, M + 14, view, { size: 13, bold: true, align: 'right', color: hex('#16844b') });
  p.text(M, M + 28, turnLine(s), { size: 8.5, bold: true });
  p.text(
    M,
    M + 39,
    (s.simulation ? 'Simulación «' + s.simulation + '» · ' : '') +
      'Situación a ' +
      stamp(s.generatedAt) +
      ' · página ' +
      page +
      ' de ' +
      pages,
    { size: 7, color: MUTED },
  );
  // Legend, as on the web.
  let x = M;
  const y = M + 52;
  x = p.text(x, y, 'Plazas libres', { size: 7, bold: true }) + 6;
  for (const [cls, label] of [
    ['vac2-free-4', '4'],
    ['vac2-free-3', '3'],
    ['vac2-free-2', '2'],
    ['vac2-free-1', '1'],
    ['vac2-free-0', '0'],
    ...(s.ruled ? [['vac2-unknown', '?']] : []),
  ]) {
    p.swatch(x, y - 7, 9, 9, cls);
    x = p.text(x + 12, y, label, { size: 7 }) + 8;
  }
  p.rect(x + 4, y - 8, 3, 10, SUMMER);
  p.text(x + 10, y, 'Verano', { size: 7 });
  p.line(M, y + 6, W - M, y + 6, LINE);
  return y + 14;
}

function tabla(p: Page, s: LiteSummary, top: number) {
  const slots = Math.max(4, ...s.cycles.map((c) => c.slots.length));
  const rowH = Math.max(9, Math.min(16, (H - M - top - 14) / (s.cycles.length + 1)));
  const size = Math.min(8.5, rowH * 0.6);
  const cols = { pts: 30, cycle: 82, free: 78 };
  const slotW = Math.min(52, (W - 2 * M - cols.pts - cols.cycle - cols.free) / slots);
  const xs = [M, M + cols.pts, M + cols.pts + cols.cycle, M + cols.pts + cols.cycle + cols.free];
  const base = (y: number) => y + rowH / 2 + size * 0.35;
  p.rect(M, top, W - 2 * M, rowH, hex('#eef3f0'));
  p.text(xs[0] + 4, base(top), 'Pts', { size, bold: true });
  p.text(xs[1] + 4, base(top), 'Ciclo', { size, bold: true });
  p.text(xs[2] + 4, base(top), 'Libres', { size, bold: true });
  for (let i = 0; i < slots; i++)
    p.text(xs[3] + i * slotW + slotW / 2, base(top), i + 1 + 'º', { size, bold: true, align: 'center' });
  s.cycles.forEach((c, r) => {
    const y = top + rowH * (r + 1);
    if (c.summer) p.rect(M, y + 1, 3, rowH - 2, SUMMER);
    p.text(xs[0] + 6, base(y), String(c.score), { size });
    p.text(xs[1] + 4, base(y), dayMonth(c.date) + ' – ' + dayMonth(c.end), { size, bold: true });
    const fg = p.swatch(xs[2] + 2, y + 1.5, cols.free - 6, rowH - 3, c.status);
    p.text(xs[2] + 5, base(y), c.freeText, { size: size * 0.92, color: fg, max: cols.free - 10 });
    for (let i = 0; i < slots; i++) {
      const x = xs[3] + i * slotW;
      // Same cells as the web table (.vac3-slot): engine-blocked places are dark with ×.
      const slot = c.slots[i] ?? { kind: 'blocked' as const };
      const cell = {
        occupied: { bg: OCCUPIED, text: slot.code ?? '', color: INK, bold: true },
        blocked: s.ruled
          ? { bg: hex('#292e33'), text: '×', color: [1, 1, 1] as RGB, bold: false }
          : { bg: hex('#f0f2f1'), text: '×', color: hex('#a3ada8'), bold: false },
        unknown: { bg: null, text: '?', color: MUTED, bold: true },
        extra: { bg: hex('#f0f2f1'), text: '+?', color: hex('#a3ada8'), bold: false },
        free: { bg: null, text: '', color: INK, bold: false },
      }[slot.kind];
      p.rect(x + 1, y + 1.5, slotW - 2, rowH - 3, cell.bg, cell.bg ? null : LINE);
      if (cell.text)
        p.text(x + slotW / 2, base(y), cell.text, {
          size,
          bold: cell.bold,
          color: cell.color,
          align: 'center',
          max: slotW - 4,
        });
    }
    p.line(M, y + rowH, W - M, y + rowH, LINE, 0.3);
  });
  p.text(
    M,
    H - M + 4,
    s.ruled
      ? '× Plaza bloqueada · ? Viabilidad indeterminada · 1º eligió antes · Libres: disponibilidad efectiva del motor de reglas'
      : '× No autorizado · +? Cupo adicional posible · 1º eligió antes',
    {
      size: 6.5,
      color: MUTED,
    },
  );
}

const MONTHS = [
  'Enero',
  'Febrero',
  'Marzo',
  'Abril',
  'Mayo',
  'Junio',
  'Julio',
  'Agosto',
  'Septiembre',
  'Octubre',
  'Noviembre',
  'Diciembre',
];
const iso = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);

/** 3 × 4 month boxes, as the web's two-column month grid but fitted to A4. */
function monthBoxes(top: number, draw: (m: number, x: number, y: number, w: number, h: number) => void) {
  const gap = 8,
    w = (W - 2 * M - 2 * gap) / 3,
    h = (H - M - top - 3 * gap) / 4;
  for (let m = 0; m < 12; m++) draw(m, M + (m % 3) * (w + gap), top + Math.floor(m / 3) * (h + gap), w, h);
}

function mapa(p: Page, s: LiteSummary, top: number) {
  monthBoxes(top, (m, x, y, w, h) => {
    p.rect(x, y, w, h, null, LINE);
    p.text(x + 6, y + 12, MONTHS[m].toUpperCase(), { size: 7.5, bold: true });
    const cycles = s.cycles.filter((c) => Number(c.date.slice(5, 7)) - 1 === m);
    const cardH = Math.min(30, (h - 18) / Math.max(4, cycles.length) - 3);
    cycles.forEach((c, i) => {
      const cy = y + 17 + i * (cardH + 3);
      const col = { fg: p.swatch(x + 5, cy, w - 10, cardH, c.status) };
      // Summer cycles keep a golden left edge, as on the web cards.
      if (c.summer) p.rect(x + 5, cy, 4, cardH, SUMMER);
      const line = cardH / 3;
      p.text(x + 12, cy + line * 0.9, dayMonth(c.date) + ' – ' + dayMonth(c.end), {
        size: 6.5,
        bold: true,
        color: col.fg,
      });
      p.text(x + w - 8, cy + line * 0.9, c.freeText, { size: 6.5, bold: true, color: col.fg, align: 'right' });
      p.text(x + 12, cy + line * 1.95, c.score + ' pt', { size: 6, color: col.fg });
      p.text(x + w - 8, cy + line * 1.95, c.occupancy + ' ocupadas', { size: 6, color: col.fg, align: 'right' });
      if (c.codes.length)
        p.text(x + 12, cy + line * 2.85, c.codes.join(' · '), { size: 5.8, bold: true, color: col.fg, max: w - 22 });
    });
  });
}

function meses(p: Page, s: LiteSummary, top: number) {
  monthBoxes(top, (m, x, y, w, h) => {
    p.rect(x, y, w, h, null, LINE);
    p.text(x + 6, y + 12, MONTHS[m].toUpperCase(), { size: 7.5, bold: true });
    const cellW = (w - 12) / 7,
      cellH = 11.5;
    'LMXJVSD'
      .split('')
      .forEach((d, i) =>
        p.text(x + 6 + i * cellW + cellW / 2, y + 22, d, { size: 5.5, color: MUTED, align: 'center' }),
      );
    const offset = (new Date(Date.UTC(s.year, m, 1)).getUTCDay() + 6) % 7;
    const days = new Date(Date.UTC(s.year, m + 1, 0)).getUTCDate();
    for (let d = 1; d <= days; d++) {
      const slot = offset + d - 1,
        cx = x + 6 + (slot % 7) * cellW,
        cy = y + 25 + Math.floor(slot / 7) * cellH;
      const date = iso(s.year, m, d);
      const c = s.cycles.find((k) => k.date <= date && date <= k.end);
      if (!c) {
        p.text(cx + cellW / 2, cy + 8, String(d), { size: 5.5, color: MUTED, align: 'center' });
        continue;
      }
      const col = { fg: p.swatch(cx + 0.6, cy + 0.6, cellW - 1.2, cellH - 1.2, c.status, false) };
      if (c.summer) p.rect(cx + 0.6, cy + cellH - 2.6, cellW - 1.2, 2, SUMMER);
      const first = c.date === date;
      p.text(cx + cellW / 2, cy + 8, String(d), { size: 5.8, bold: first, color: col.fg, align: 'center' });
      if (first) {
        p.line(cx + cellW / 2 - 3, cy + 9.2, cx + cellW / 2 + 3, cy + 9.2, col.fg, 0.5);
        if (s.ruled) p.text(cx + cellW - 1.5, cy + 4.3, c.label, { size: 3.8, color: col.fg, align: 'right' });
      }
    }
    // Who holds each cycle that touches the month.
    const first = iso(s.year, m, 1),
      last = iso(s.year, m + 1, 0);
    let ly = y + 25 + 6 * cellH + 8;
    for (const c of s.cycles.filter((k) => k.date <= last && k.end >= first)) {
      if (ly > y + h - 3) break;
      p.text(x + 6, ly, dayMonth(c.date), { size: 5.8, bold: true });
      p.text(x + 34, ly, c.codes.join(' · ') || 'Sin adjudicar', {
        size: 5.8,
        color: c.codes.length ? INK : MUTED,
        max: w - 40,
      });
      ly += 7.5;
    }
  });
}

function porCta(p: Page, s: LiteSummary, top: number) {
  const byDate = new Map(s.cycles.map((c) => [c.date, c]));
  const rowH = Math.max(10, Math.min(20, (H - M - top - 20) / (s.members.length + 1)));
  const size = Math.min(9, rowH * 0.5);
  const ctaW = 60,
    ptsW = 44,
    cW = (W - 2 * M - ctaW - ptsW) / 6;
  const base = (y: number) => y + rowH / 2 + size * 0.35;
  p.rect(M, top, W - 2 * M, rowH, hex('#eef3f0'));
  p.text(M + 5, base(top), 'CTA', { size, bold: true });
  for (let i = 0; i < 6; i++) p.text(M + ctaW + i * cW + 5, base(top), 'C' + (i + 1), { size, bold: true });
  p.text(W - M - 5, base(top), 'Pts', { size, bold: true, align: 'right' });
  s.members.forEach((member, r) => {
    const y = top + rowH * (r + 1);
    p.rect(M, y, ctaW, rowH, hex('#f6f8f5'));
    p.text(M + 5, base(y), member.code, { size, bold: true });
    for (let i = 0; i < 6; i++) {
      const c = byDate.get(member.dates[i]);
      const x = M + ctaW + i * cW;
      if (!c) {
        p.text(x + 5, base(y), '—', { size, color: MUTED });
        continue;
      }
      if (c.summer) p.rect(x + 1, y + 2, 2, rowH - 4, SUMMER);
      p.text(x + 5, base(y), dayMonth(c.date), { size, bold: true });
      p.text(x + cW - 4, base(y), c.score + ' pt', { size: size * 0.8, color: MUTED, align: 'right' });
    }
    p.text(W - M - 5, base(y), String(member.points), { size, bold: true, align: 'right' });
    p.line(M, y + rowH, W - M, y + rowH, LINE, 0.3);
  });
  p.text(
    M,
    top + rowH * (s.members.length + 1) + 12,
    'Ciclos en orden cronológico. Los puntos acumulados suman los ciclos adjudicados.',
    { size: 6.5, color: MUTED },
  );
}

export function renderLitePdf(s: LiteSummary): string {
  const views: [string, (p: Page, s: LiteSummary, top: number) => void][] = [
    ['Tabla', tabla],
    ['Mapa', mapa],
    ['Meses', meses],
    ['Por CTA', porCta],
  ];
  const pages = views.map(([title, draw], i) => {
    const p = new Page();
    draw(p, s, header(p, s, title, i + 1, views.length));
    return p;
  });
  return writePdf(pages);
}

/** Shared no-dependency PDF encoder used by both the team and individual reports. */
export function writePdf(pages: Page[]): string {
  if (!pages.length) throw new Error('El PDF debe contener al menos una página');
  const objects: string[] = [];
  const pageIds = pages.map((_, i) => 5 + i * 2);
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => id + ' 0 R').join(' ')}] /Count ${pages.length} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objects[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
  pages.forEach((page, i) => {
    const stream = page.ops;
    objects[pageIds[i]] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${page.width} ${page.height}] ` +
      `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${pageIds[i] + 1} 0 R >>`;
    objects[pageIds[i] + 1] = `<< /Length ${stream.length} >>\nstream\n${stream}endstream`;
  });
  // Every byte is ASCII (non-ASCII text is octal-escaped), so string length = byte offsets.
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = pdf.length;
    pdf += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) pdf += String(offsets[id]).padStart(10, '0') + ' 00000 n \n';
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return pdf;
}
