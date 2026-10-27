/**
 * Read and patch RRHH's macro workbook (.xlsm) in place.
 *
 * The workbook is never regenerated: a library rewrite would drop the VBA
 * project, form controls and dynamic-array metadata. Unchanged zip entries are
 * copied byte for byte; only the edited team sheets and workbook.xml (forced
 * recalculation on open) are recompressed.
 */
import { iso } from '../domain/calendar.ts';
import type { HrCell, HrSheet } from '../domain/hr-export.ts';
import { HrExportError } from '../domain/hr-export.ts';

export const XLSM_TYPE = 'application/vnd.ms-excel.sheet.macroEnabled.12';
const TEAMS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
const FIRST_ROW = 8;

type Entry = { name: string; central: Uint8Array; local: Uint8Array; method: number; dataStart: number; size: number };

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const put16 = (b: Uint8Array, o: number, v: number) => ((b[o] = v & 255), (b[o + 1] = (v >>> 8) & 255));
const put32 = (b: Uint8Array, o: number, v: number) => (put16(b, o, v & 0xffff), put16(b, o + 2, v >>> 16));

function entries(zip: Uint8Array): Entry[] {
  let eocd = zip.length - 22;
  while (eocd >= 0 && u32(zip, eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new HrExportError('El fichero no es un libro de Excel');
  const count = u16(zip, eocd + 10);
  let p = u32(zip, eocd + 16);
  const list: Omit<Entry, 'local'>[] = [];
  const offsets: number[] = [];
  for (let i = 0; i < count; i++) {
    if (u32(zip, p) !== 0x02014b50) throw new HrExportError('Libro de Excel dañado');
    const len = 46 + u16(zip, p + 28) + u16(zip, p + 30) + u16(zip, p + 32);
    const offset = u32(zip, p + 42);
    const name = new TextDecoder().decode(zip.subarray(p + 46, p + 46 + u16(zip, p + 28)));
    list.push({
      name,
      central: zip.slice(p, p + len),
      method: u16(zip, p + 10),
      size: u32(zip, p + 20),
      dataStart: offset + 30 + u16(zip, offset + 26) + u16(zip, offset + 28),
    });
    offsets.push(offset);
    p += len;
  }
  const centralStart = u32(zip, eocd + 16);
  const sorted = [...offsets].sort((a, b) => a - b);
  return list.map((e, i) => {
    const next = sorted.find((o) => o > offsets[i]) ?? centralStart;
    return { ...e, local: zip.subarray(offsets[i], next) };
  });
}

async function pipe(data: Uint8Array, stream: CompressionStream | DecompressionStream) {
  return new Uint8Array(await new Response(new Blob([data as BlobPart]).stream().pipeThrough(stream)).arrayBuffer());
}
async function read(zip: Uint8Array, e: Entry): Promise<string> {
  const raw = zip.subarray(e.dataStart, e.dataStart + e.size);
  return new TextDecoder().decode(e.method === 0 ? raw : await pipe(raw, new DecompressionStream('deflate-raw')));
}

const CRC = Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc32(b: Uint8Array) {
  let c = 0xffffffff;
  for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** The workbook with the given entries replaced, everything else copied verbatim. */
async function rewrite(list: Entry[], changed: Map<string, string | Uint8Array>): Promise<Uint8Array<ArrayBuffer>> {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const e of list) {
    const c = e.central.slice();
    put32(c, 42, offset);
    let local = e.local;
    const text = changed.get(e.name);
    if (text !== undefined) {
      const plain = typeof text === 'string' ? new TextEncoder().encode(text) : text;
      const data = await pipe(plain, new CompressionStream('deflate-raw'));
      const crc = crc32(plain);
      const nameLen = u16(e.local, 26);
      local = new Uint8Array(30 + nameLen + data.length);
      local.set(e.local.subarray(0, 30 + nameLen));
      put16(local, 6, u16(local, 6) & ~8); // no data descriptor
      put16(local, 8, 8);
      put16(local, 28, 0);
      put32(local, 14, crc);
      put32(local, 18, data.length);
      put32(local, 22, plain.length);
      local.set(data, 30 + nameLen);
      put16(c, 8, u16(c, 8) & ~8);
      put16(c, 10, 8);
      put32(c, 16, crc);
      put32(c, 20, data.length);
      put32(c, 24, plain.length);
    }
    parts.push(local);
    central.push(c);
    offset += local.length;
  }
  const size = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  put32(end, 0, 0x06054b50);
  put16(end, 8, list.length);
  put16(end, 10, list.length);
  put32(end, 12, size);
  put32(end, 16, offset);
  const out = new Uint8Array(offset + size + 22);
  let p = 0;
  for (const b of [...parts, ...central, end]) (out.set(b, p), (p += b.length));
  return out;
}

const unescape = (s: string) =>
  s.replace(/&(lt|gt|quot|apos|amp|#(\d+)|#x([0-9a-f]+));/gi, (_, n, d, h) =>
    d
      ? String.fromCodePoint(+d)
      : h
        ? String.fromCodePoint(parseInt(h, 16))
        : ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' } as Record<string, string>)[n],
  );
const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const attr = (tag: string, name: string) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];

/** The `<c>` element for `ref` in sheet XML, with its position. */
function findCell(xml: string, ref: string): { start: number; end: number; text: string } | null {
  const start = xml.indexOf(`<c r="${ref}"`);
  if (start < 0) return null;
  const close = xml.indexOf('>', start);
  const end = xml[close - 1] === '/' ? close + 1 : xml.indexOf('</c>', close) + 4;
  return { start, end, text: xml.slice(start, end) };
}
function cellValue(xml: string, ref: string, strings: string[]): string | null {
  const c = findCell(xml, ref);
  if (!c) return null;
  if (attr(c.text.slice(0, c.text.indexOf('>')), 't') === 'inlineStr')
    return unescape([...c.text.matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((m) => m[1]).join(''));
  const v = c.text.match(/<v>([^<]*)<\/v>/)?.[1];
  if (v === undefined) return null;
  return attr(c.text, 't') === 's' ? strings[+v] : unescape(v);
}

export type HrWorkbook = {
  year: number | null;
  sheets: HrSheet[];
  /** Internal: team → zip entry name. */
  paths: Record<string, string>;
};

/** Text of every entry, for tests and the fixture script. */
export async function zipTexts(zip: Uint8Array): Promise<Map<string, string>> {
  const list = entries(zip);
  return new Map(await Promise.all(list.map(async (e) => [e.name, await read(zip, e)] as const)));
}
/** Raw stored bytes (compressed) of every entry, to compare copies byte for byte. */
export function zipRaw(zip: Uint8Array): Map<string, Uint8Array> {
  return new Map(entries(zip).map((e) => [e.name, e.local.subarray(30 + u16(e.local, 26) + u16(e.local, 28))]));
}
/** The zip with the given entries replaced. */
export function replaceZipEntries(zip: Uint8Array, changed: Map<string, string | Uint8Array>) {
  return rewrite(entries(zip), changed);
}

/** Team sheets of the workbook, located through workbook.xml and its rels. */
export async function readHrWorkbook(zip: Uint8Array): Promise<HrWorkbook> {
  const list = entries(zip);
  const get = async (name: string) => {
    const e = list.find((x) => x.name === name);
    return e ? read(zip, e) : null;
  };
  const workbook = await get('xl/workbook.xml');
  const rels = await get('xl/_rels/workbook.xml.rels');
  if (!workbook || !rels) throw new HrExportError('El fichero no es un libro de Excel');
  const strings = [...((await get('xl/sharedStrings.xml')) ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    unescape([...m[1].matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((t) => t[1]).join('')),
  );
  const targets = new Map(
    [...rels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => [attr(m[0], 'Id')!, attr(m[0], 'Target')!]),
  );
  const paths: Record<string, string> = {};
  for (const m of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const target = targets.get(attr(m[0], 'r:id') ?? '');
    if (!target) continue;
    paths[unescape(attr(m[0], 'name') ?? '')] = target.startsWith('/') ? target.slice(1) : 'xl/' + target;
  }
  const missing = TEAMS.filter((t) => !paths[t]);
  if (missing.length) throw new HrExportError('Faltan hojas de equipo en la plantilla', missing);

  let year: number | null = null;
  const meta = paths.Meta ? await get(paths.Meta) : null;
  if (meta)
    for (let r = 1; r < 20 && year === null; r++)
      if (/^A[ñn]o$/i.test(cellValue(meta, 'A' + r, strings) ?? '')) year = Number(cellValue(meta, 'B' + r, strings));

  const sheets: HrSheet[] = [];
  for (const team of TEAMS) {
    const xml = await get(paths[team]);
    if (!xml) throw new HrExportError('Hoja de equipo ilegible', [team]);
    const rows: HrSheet['rows'] = [];
    for (let row = FIRST_ROW; ; row++) {
      const c = Number(cellValue(xml, 'C' + row, strings)),
        d = Number(cellValue(xml, 'D' + row, strings));
      if (!c || !d) break;
      rows.push({ row, start: iso(c), end: iso(d) });
    }
    const roster: string[] = [];
    for (let row = FIRST_ROW; row < FIRST_ROW + 60; row++) {
      const name = cellValue(xml, 'J' + row, strings);
      if (name?.trim()) roster.push(name);
    }
    sheets.push({ team, rows, roster });
  }
  return { year: Number.isFinite(year) ? year : null, sheets, paths };
}

const column = (ref: string) => ref.match(/^[A-Z]+/)![0];
const columnIndex = (col: string) => [...col].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);

/** Write the cells as inline strings, keeping each cell's style. */
export function patchSheet(xml: string, cells: readonly HrCell[]): string {
  for (const { ref, value } of cells) {
    const found = findCell(xml, ref);
    const style = found ? attr(found.text.slice(0, found.text.indexOf('>') + 1), 's') : undefined;
    const s = style ? ` s="${style}"` : '';
    const cell = value
      ? `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${escape(value)}</t></is></c>`
      : `<c r="${ref}"${s}/>`;
    if (found) {
      xml = xml.slice(0, found.start) + cell + xml.slice(found.end);
      continue;
    }
    if (!value) continue;
    const row = ref.slice(column(ref).length);
    const rowStart = xml.indexOf(`<row r="${row}"`);
    if (rowStart < 0) throw new HrExportError('La plantilla no tiene la fila', [row]);
    const rowOpen = xml.indexOf('>', rowStart);
    const rowEnd = xml.indexOf('</row>', rowOpen);
    const want = columnIndex(column(ref));
    let at = rowEnd;
    for (const m of xml.slice(rowOpen, rowEnd).matchAll(/<c r="([A-Z]+)\d+"/g))
      if (columnIndex(m[1]) > want) {
        at = rowOpen + m.index!;
        break;
      }
    xml = xml.slice(0, at) + cell + xml.slice(at);
  }
  return xml;
}

/** Ask Excel to recalculate every formula when the workbook is opened. */
export function forceRecalc(workbook: string): string {
  if (/<calcPr\b[^>]*fullCalcOnLoad=/.test(workbook))
    return workbook.replace(/(<calcPr\b[^>]*fullCalcOnLoad=")[^"]*"/, '$11"');
  if (/<calcPr\b/.test(workbook)) return workbook.replace(/<calcPr\b/, '<calcPr fullCalcOnLoad="1"');
  return workbook.replace('</workbook>', '<calcPr fullCalcOnLoad="1"/></workbook>');
}

/** The workbook with `cells` written on each team's sheet. */
export async function writeHrWorkbook(
  zip: Uint8Array,
  book: HrWorkbook,
  cellsByTeam: Record<string, readonly HrCell[]>,
): Promise<Uint8Array<ArrayBuffer>> {
  const list = entries(zip);
  const changed = new Map<string, string>();
  for (const [team, cells] of Object.entries(cellsByTeam)) {
    const path = book.paths[team];
    const e = list.find((x) => x.name === path);
    if (!e) throw new HrExportError('Hoja de equipo ilegible', [team]);
    changed.set(path, patchSheet(await read(zip, e), cells));
  }
  const wb = list.find((x) => x.name === 'xl/workbook.xml')!;
  changed.set(wb.name, forceRecalc(await read(zip, wb)));
  return rewrite(list, changed);
}
