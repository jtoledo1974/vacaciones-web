// Reads RRHH's VA calendar workbook («Calendario VA AAAA - ejecutivo.xlsm») without
// running macros: one sheet with a block per month titled «Mes AAAA», a row of day
// numbers and, right below each, the free places of that day.
import { inflateRawSync } from 'node:zlib';

const MONTHS = {
  enero: 1,
  febrero: 2,
  marzo: 3,
  abril: 4,
  mayo: 5,
  junio: 6,
  julio: 7,
  agosto: 8,
  septiembre: 9,
  setiembre: 9,
  octubre: 10,
  noviembre: 11,
  diciembre: 12,
};

/** Text of the zip entries whose names pass `wanted`, from the central directory. */
export function unzipText(buffer, wanted) {
  let eocd = buffer.length - 22;
  while (eocd >= 0 && buffer.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('El archivo no es un libro de Excel');
  const files = {};
  let p = buffer.readUInt32LE(eocd + 16);
  for (let i = buffer.readUInt16LE(eocd + 10); i > 0; i--) {
    if (buffer.readUInt32LE(p) !== 0x02014b50) throw new Error('Libro de Excel dañado');
    const nameLength = buffer.readUInt16LE(p + 28);
    const name = buffer.toString('utf8', p + 46, p + 46 + nameLength);
    const method = buffer.readUInt16LE(p + 10),
      size = buffer.readUInt32LE(p + 20),
      local = buffer.readUInt32LE(p + 42);
    if (wanted(name)) {
      const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
      const raw = buffer.subarray(start, start + size);
      files[name] = (method === 0 ? raw : inflateRawSync(raw)).toString('utf8');
    }
    p += 46 + nameLength + buffer.readUInt16LE(p + 30) + buffer.readUInt16LE(p + 32);
  }
  return files;
}

const column = (letters) => [...letters].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
const unescape = (s) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

/** {row: {column: value}} of one worksheet, resolving shared and inline strings. */
export function sheetCells(sheetXml, sharedXml = '') {
  const shared = [...sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    unescape([...m[1].matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((t) => t[1]).join('')),
  );
  const cells = {};
  for (const m of sheetXml.matchAll(/<c r="([A-Z]+)(\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    if (!m[4]) continue;
    const value = m[4].match(/<v>([^<]*)<\/v>/)?.[1];
    const inline = m[4].match(/<t[^>]*>([^<]*)<\/t>/)?.[1];
    let v;
    if (/t="s"/.test(m[3]) && value !== undefined) v = shared[Number(value)];
    else if (inline !== undefined) v = unescape(inline);
    else if (value !== undefined) v = /t="str"/.test(m[3]) ? unescape(value) : Number(value);
    if (v === undefined) continue;
    (cells[m[2]] ??= {})[column(m[1])] = v;
  }
  return cells;
}

/**
 * {«AAAA-MM-DD»: places} from the month blocks. A day without a number below it is left
 * out, which the server treats as zero places like any other missing day.
 */
export function parseVaCalendar(cells) {
  const days = {};
  const blocks = [];
  for (const [r, row] of Object.entries(cells))
    for (const [c, v] of Object.entries(row)) {
      const m = typeof v === 'string' && /^\s*([a-záéíóú]+)\s+(\d{4})\s*$/i.exec(v);
      const month = m && MONTHS[m[1].toLowerCase()];
      if (month) blocks.push({ row: Number(r), col: Number(c), month, year: Number(m[2]) });
    }
  if (!blocks.length) throw new Error('No se encuentra ningún mes con el título «Mes AAAA» en el calendario');
  for (const b of blocks) {
    const last = new Date(Date.UTC(b.year, b.month, 0)).getUTCDate();
    // Header row of weekday initials, then pairs of rows: day numbers and places.
    for (let r = b.row + 2; r <= b.row + 14; r += 2)
      for (let c = b.col; c < b.col + 7; c++) {
        const day = cells[r]?.[c],
          places = cells[r + 1]?.[c];
        if (typeof day !== 'number' || !Number.isInteger(day) || day < 1 || day > last) continue;
        const date = `${b.year}-${String(b.month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        if (date in days) throw new Error('El día ' + date + ' aparece dos veces en el calendario');
        if (places === undefined || places === '') continue;
        if (typeof places !== 'number' || !Number.isInteger(places) || places < 0)
          throw new Error('Plazas no válidas el ' + date + ': ' + places);
        days[date] = places;
      }
  }
  return days;
}

/** The days of the workbook's first sheet, as in RRHH's example. */
export function readVaCalendarWorkbook(buffer) {
  const files = unzipText(buffer, (n) => n === 'xl/sharedStrings.xml' || /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
  const sheet = Object.keys(files)
    .filter((n) => n.startsWith('xl/worksheets/'))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))[0];
  if (!sheet) throw new Error('El libro no tiene hojas');
  return parseVaCalendar(sheetCells(files[sheet], files['xl/sharedStrings.xml']));
}
