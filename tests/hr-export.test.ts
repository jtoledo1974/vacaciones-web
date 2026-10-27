import test from 'node:test';
import assert from 'node:assert/strict';
import { HrExportError, hrTeamCells, suggestHrNames, type HrSheet } from '../domain/hr-export.ts';

const sheet: HrSheet = {
  team: 'B',
  rows: [
    { row: 8, start: '2027-01-01', end: '2027-01-08' },
    { row: 9, start: '2027-01-09', end: '2027-01-16' },
  ],
  roster: ['PÉREZ GARCÍA,ANA', 'LÓPEZ RUIZ, LUIS', 'SANZ,EVA', 'GIL,PAZ', 'ROS,TEO'],
};
const cycles = [
  { date: '2027-01-01', end: '2027-01-08' },
  { date: '2027-01-09', end: '2027-01-16' },
];
const members = ['ana', 'luis', 'eva', 'paz', 'teo'].map((id) => ({ id, code: id.toUpperCase() }));
const names = {
  ana: 'PÉREZ GARCÍA,ANA',
  luis: 'LÓPEZ RUIZ, LUIS',
  eva: 'SANZ,EVA',
  paz: 'GIL,PAZ',
  teo: 'ROS,TEO',
};
const cell = (cells: { ref: string; value: string }[], ref: string) => cells.find((c) => c.ref === ref)?.value;

test('escribe E:H de cada fila en el orden de elección y deja vacíos los huecos', () => {
  const cells = hrTeamCells({
    sheet,
    cycles,
    members,
    names,
    awards: [
      { member_id: 'luis', cycle_date: '2027-01-09' },
      { member_id: 'ana', cycle_date: '2027-01-09' },
      { member_id: 'eva', cycle_date: '2027-01-01' },
    ],
  });
  assert.equal(cells.length, 8);
  assert.equal(cell(cells, 'E9'), 'LÓPEZ RUIZ, LUIS');
  assert.equal(cell(cells, 'F9'), 'PÉREZ GARCÍA,ANA');
  assert.equal(cell(cells, 'G9'), '');
  assert.equal(cell(cells, 'E8'), 'SANZ,EVA');
  assert.equal(cell(cells, 'H8'), '');
});

test('usa H como cuarto hueco y rechaza un quinto', () => {
  const four = ['ana', 'luis', 'eva', 'paz'].map((m) => ({ member_id: m, cycle_date: '2027-01-01' }));
  assert.equal(cell(hrTeamCells({ sheet, cycles, members, names, awards: four }), 'H8'), 'GIL,PAZ');
  assert.throws(
    () =>
      hrTeamCells({ sheet, cycles, members, names, awards: [...four, { member_id: 'teo', cycle_date: '2027-01-01' }] }),
    /Más de 4 personas en un ciclo: fila 8/,
  );
});

test('bloquea si algún adjudicado no tiene nombre de RRHH, y dice quién', () => {
  assert.throws(
    () =>
      hrTeamCells({
        sheet,
        cycles,
        members: [...members, { id: 'x', code: 'X1', label: 'Xavi' }],
        names: { ...names, eva: 'OTRA,PERSONA' },
        awards: [
          { member_id: 'x', cycle_date: '2027-01-01' },
          { member_id: 'eva', cycle_date: '2027-01-01' },
        ],
      }),
    (e: unknown) =>
      e instanceof HrExportError && /sin nombre de RRHH/.test(e.message) && /Xavi \(X1\), EVA/.test(e.message),
  );
});

test('las personas sin adjudicación no necesitan nombre', () => {
  const cells = hrTeamCells({ sheet, cycles, members, names: { ana: names.ana }, awards: [] });
  assert.ok(cells.every((c) => c.value === ''));
});

test('rechaza dos personas con el mismo nombre de RRHH', () => {
  assert.throws(
    () =>
      hrTeamCells({
        sheet,
        cycles,
        members,
        names: { ...names, luis: names.ana },
        awards: [
          { member_id: 'ana', cycle_date: '2027-01-01' },
          { member_id: 'luis', cycle_date: '2027-01-09' },
        ],
      }),
    /mismo nombre de RRHH/,
  );
});

test('las fechas C/D de la hoja deben coincidir con los ciclos de la campaña', () => {
  assert.throws(
    () =>
      hrTeamCells({
        sheet,
        cycles: [cycles[0], { date: '2027-01-10', end: '2027-01-17' }],
        members,
        names,
        awards: [],
      }),
    /no cuadran: fila 9/,
  );
  assert.throws(
    () => hrTeamCells({ sheet, cycles: [cycles[0]], members, names, awards: [] }),
    /2 ciclos y la campaña 1/,
  );
});

test('propone el nombre de RRHH sin tildes, mayúsculas ni orden de palabras', () => {
  assert.deepEqual(
    suggestHrNames(
      [
        { id: 'a', code: 'A1', label: 'Ana Pérez García' },
        { id: 'l', code: 'luis lopez ruiz' },
        { id: 'n', code: 'NADIE' },
      ],
      sheet.roster,
    ),
    { a: 'PÉREZ GARCÍA,ANA', l: 'LÓPEZ RUIZ, LUIS' },
  );
});
