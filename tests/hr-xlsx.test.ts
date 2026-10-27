import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { calendar } from '../domain/calendar.ts';
import { defaultConfig } from '../domain/defaults.ts';
import { hrTeamCells } from '../domain/hr-export.ts';
import { readHrWorkbook, writeHrWorkbook, zipRaw, zipTexts } from '../server/hr-xlsx.ts';

// Anonymised copy of RRHH's 2027 workbook (scripts/anonymize-hr-template.ts).
const template = new Uint8Array(readFileSync(new URL('./fixtures/hr-template-anon.xlsm', import.meta.url)));

test('lee las ocho hojas de equipo con sus ciclos y su plantilla J', async () => {
  const book = await readHrWorkbook(template);
  assert.equal(book.year, 2027);
  assert.deepEqual(
    book.sheets.map((s) => [s.team, s.rows.length, s.rows[0].row, s.rows[0].start]),
    [
      ['A', 45, 8, '2027-01-08'],
      ['B', 46, 8, '2027-01-01'],
      ['C', 46, 8, '2027-01-02'],
      ['D', 46, 8, '2027-01-03'],
      ['E', 46, 8, '2027-01-04'],
      ['F', 46, 8, '2027-01-05'],
      ['G', 45, 8, '2027-01-06'],
      ['H', 45, 8, '2027-01-07'],
    ],
  );
  assert.ok(book.sheets.every((s) => s.roster.length >= 19));
});

test('los ciclos de cada hoja son los del calendario de la web', async () => {
  for (const sheet of (await readHrWorkbook(template)).sheets) {
    const cycles = calendar(2027, sheet.team, defaultConfig(2027));
    assert.doesNotThrow(() => hrTeamCells({ sheet, cycles, members: [], names: {}, awards: [] }), sheet.team);
  }
});

test('escribe solo E:H de la hoja del equipo y conserva el resto del libro', async () => {
  const book = await readHrWorkbook(template);
  const b = book.sheets.find((s) => s.team === 'B')!;
  const out = await writeHrWorkbook(template, book, {
    B: [
      { ref: 'E8', value: b.roster[0] },
      { ref: 'H53', value: 'A & <B>' },
      { ref: 'F8', value: '' },
    ],
  });
  const before = zipRaw(template),
    after = zipRaw(out);
  assert.deepEqual([...after.keys()], [...before.keys()]);
  const edited = [book.paths.B, 'xl/workbook.xml'];
  for (const [name, bytes] of before)
    if (!edited.includes(name)) assert.deepEqual(after.get(name), bytes, name + ' cambió');
  assert.ok(after.has('xl/vbaProject.bin'));

  const texts = await zipTexts(out),
    original = await zipTexts(template);
  const sheet = texts.get(book.paths.B)!;
  assert.match(
    sheet,
    /<c r="E8" s="2" t="inlineStr"><is><t xml:space="preserve">APELLIDO\d+ PRUEBA, ?NOMBRE\d+<\/t><\/is><\/c>/,
  );
  assert.match(sheet, /<c r="H53" s="2" t="inlineStr"><is><t xml:space="preserve">A &amp; &lt;B&gt;<\/t><\/is><\/c>/);
  assert.match(sheet, /<c r="F8" s="2"\/>/);
  // Totals stay array formulas over E:G.
  assert.match(sheet, /<c r="K8" cm="1"><f t="array" ref="K8">SUMPRODUCT\(\(\$E\$8:\$G\$54=J8\)/);
  // Nothing else on the sheet moved.
  const strip = (x: string) => x.replace(/<c r="(E8|F8|H53)"[^>]*?(\/>|>[\s\S]*?<\/c>)/g, '');
  assert.equal(strip(sheet), strip(original.get(book.paths.B)!));
  assert.match(texts.get('xl/workbook.xml')!, /<calcPr fullCalcOnLoad="1" calcId="\d+"\/>/);

  const reread = await readHrWorkbook(out);
  assert.deepEqual(reread.sheets, book.sheets);
});

test('una hoja sin cambios no se toca', async () => {
  const book = await readHrWorkbook(template);
  const out = await writeHrWorkbook(template, book, { A: [] });
  assert.equal((await zipTexts(out)).get(book.paths.C), (await zipTexts(template)).get(book.paths.C));
});
