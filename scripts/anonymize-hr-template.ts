/**
 * Build tests/fixtures/hr-template-anon.xlsm from RRHH's real workbook.
 *
 *   node --experimental-transform-types scripts/anonymize-hr-template.ts "<real .xlsm>"
 *
 * Names and employee numbers are replaced, and binary parts that may carry
 * personal or third-party data (VBA project, printer settings, images) become
 * placeholders of the same name. The script fails if any word of a real name
 * or any employee number survives anywhere in the output.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { readHrWorkbook, replaceZipEntries, zipTexts } from '../server/hr-xlsx.ts';

const source = process.argv[2];
const target = process.argv[3] ?? 'tests/fixtures/hr-template-anon.xlsm';
if (!source) throw new Error('Uso: anonymize-hr-template.ts <plantilla real .xlsm> [salida]');
const zip = new Uint8Array(readFileSync(source));
const book = await readHrWorkbook(zip);
const texts = await zipTexts(zip);
const sheetPath = (name: string) => book.paths[name];
const PRIVATE_SHEETS = ['OcultaEmpleados', 'Empleados'].map(sheetPath).filter(Boolean);

const sharedXml = texts.get('xl/sharedStrings.xml')!;
const items = [...sharedXml.matchAll(/<si>[\s\S]*?<\/si>/g)].map((m) => m[0]);
const text = (si: string) => [...si.matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((t) => t[1]).join('');
const refs = (xml: string, filter: (ref: string) => boolean) =>
  [...xml.matchAll(/<c r="([A-Z]+)(\d+)"[^>]*t="s"[^>]*>\s*<v>(\d+)<\/v>/g)]
    .filter((m) => filter(m[1] + ' ' + m[2]))
    .map((m) => +m[3]);

// Strings naming people: column J of team sheets and the private sheets below their header.
const sensitive = new Set<number>();
for (const team of 'ABCDEFGH')
  refs(texts.get(sheetPath(team))!, (r) => r.startsWith('J ') && +r.split(' ')[1] >= 8).forEach((i) =>
    sensitive.add(i),
  );
for (const path of PRIVATE_SHEETS) refs(texts.get(path)!, (r) => +r.split(' ')[1] > 1).forEach((i) => sensitive.add(i));
// Team letters and other short codes are structural.
for (const i of [...sensitive]) if (text(items[i]).trim().length <= 2) sensitive.delete(i);

const realNames = [...sensitive].map((i) => text(items[i]));
let n = 0;
const fake = new Map<string, string>();
for (const name of realNames) {
  n++;
  const sep = name.includes(', ') ? ', ' : ',';
  fake.set(name, name.includes(',') ? `APELLIDO${n} PRUEBA${sep}NOMBRE${n}` : `PERSONA ${n}`);
}
const shared = sharedXml.replace(/<si>[\s\S]*?<\/si>/g, (si) => {
  const t = text(si);
  return fake.has(t) ? `<si><t xml:space="preserve">${fake.get(t)}</t></si>` : si;
});

// Employee numbers (and start dates) in the private sheets.
const numbers = new Set<string>();
let k = 0;
const scrubNumbers = (xml: string) =>
  xml.replace(
    /(<c r="[A-Z]+(\d+)"(?![^>]*t="s")[^>]*>(?:<f[^<]*<\/f>|<f[^>]*\/>)?<v>)([^<]+)(<\/v>)/g,
    (m, open, row, v, close) => {
      if (+row <= 1 || !/^\d+(\.\d+)?$/.test(v) || +v < 100) return m;
      numbers.add(v);
      return open + (+v >= 40000 && +v < 50000 ? '46388' : String(900000 + ++k)) + close;
    },
  );

const changed = new Map<string, string | Uint8Array>([['xl/sharedStrings.xml', shared]]);
for (const path of PRIVATE_SHEETS) changed.set(path, scrubNumbers(texts.get(path)!));
// Cached formula results may show a name.
for (const [path, xml] of texts)
  if (path.startsWith('xl/worksheets/sheet') && !changed.has(path)) {
    const out = xml.replace(/(<c [^>]*t="str"[^>]*>(?:<f[\s\S]*?<\/f>)?<v>)([^<]*)(<\/v>)/g, (m, a, v, b) =>
      fake.has(v) ? a + fake.get(v) + b : m,
    );
    if (out !== xml) changed.set(path, out);
  }
changed.set(
  'docProps/core.xml',
  texts.get('docProps/core.xml')!.replace(/(<(dc:creator|cp:lastModifiedBy)>)[^<]*/g, '$1RRHH'),
);
// Organisation identifiers (sensitivity label, document properties).
for (const path of ['docMetadata/LabelInfo.xml', 'docProps/custom.xml'])
  if (texts.has(path))
    changed.set(
      path,
      texts
        .get(path)!
        .replace(
          /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
          '00000000-0000-0000-0000-000000000000',
        ),
    );
for (const path of texts.keys())
  if (/\.(bin|jpe?g|png|emf|wmf)$/.test(path)) changed.set(path, new TextEncoder().encode('placeholder ' + path));

const out = await replaceZipEntries(zip, changed);
// Nothing personal survives: every word of a real name and every replaced number.
const words = new Set(
  realNames
    .filter((s) => s.includes(','))
    .flatMap((s) =>
      s
        .toUpperCase()
        .split(/[^A-ZÁÉÍÓÚÜÑ]+/)
        .filter((w) => w.length >= 4),
    ),
);
const fakeWords = new Set([...fake.values()].flatMap((s) => s.split(/[^A-Z0-9]+/)));
const leaks: string[] = [];
for (const [path, xml] of await zipTexts(out)) {
  const upper = xml.toUpperCase();
  for (const w of words)
    if (!fakeWords.has(w) && new RegExp(`(^|[^A-ZÁÉÍÓÚÜÑ])${w}([^A-ZÁÉÍÓÚÜÑ]|$)`).test(upper))
      leaks.push(`${path}: palabra de nombre${process.env.HR_DEBUG ? ' ' + w : ''}`);
  for (const v of numbers)
    if (v.length >= 4 && !(+v >= 40000 && +v < 50000) && xml.includes('>' + v + '<')) leaks.push(`${path}: número`);
}
if (leaks.length) throw new Error('La anonimización deja datos reales:\n' + [...new Set(leaks)].join('\n'));
writeFileSync(target, out);
console.log(`${target}: ${realNames.length} nombres y ${numbers.size} números sustituidos`);
