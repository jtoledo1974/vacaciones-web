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
    { a: { name: 'PÉREZ GARCÍA,ANA', exact: true }, l: { name: 'LÓPEZ RUIZ, LUIS', exact: true } },
  );
});

test('propone por palabras en común solo cuando hay un candidato claro y libre', () => {
  const roster = ['GÓMEZ PRIETO,MARÍA JOSÉ', 'RUIZ SOTO,ANA', 'RUIZ VEGA,ANA BELÉN', 'LUNA MAR,PEDRO'];
  assert.deepEqual(
    suggestHrNames(
      [
        // Second surname missing in the app.
        { id: 'mj', code: 'MJ', label: 'Gómez, María José' },
        // Two candidates share "RUIZ ANA": no proposal.
        { id: 'ana', code: 'ANA', label: 'Ana Ruiz' },
        // Only one word in common: no proposal.
        { id: 'p', code: 'P', label: 'Pedro Sol' },
      ],
      roster,
    ),
    { mj: { name: 'GÓMEZ PRIETO,MARÍA JOSÉ', exact: false } },
  );
  // Two members wanting the same free entry: neither gets it.
  assert.deepEqual(
    suggestHrNames(
      [
        { id: 'a', code: 'A', label: 'Luna, Pedro Juan' },
        { id: 'b', code: 'B', label: 'Luna Sol, Pedro' },
      ],
      ['LUNA MAR,PEDRO', 'OTRO,NOMBRE'],
    ),
    {},
  );
});

test('«Nombre Apellido» se empareja si es el único nombre de la hoja que contiene ambas palabras', () => {
  const roster = ['GARCÍA LÓPEZ,LUIS', 'GARCÍA RUIZ,ANA', 'MORA PAZ,LUISA'];
  assert.deepEqual(
    suggestHrNames(
      [
        { id: 'l', code: 'L', label: 'Luis García' },
        // A nickname with the only "MORA" surname: the last-resort rule, also approximate.
        { id: 'p', code: 'P', label: 'Pepa Mora' },
      ],
      roster,
    ),
    { l: { name: 'GARCÍA LÓPEZ,LUIS', exact: false }, p: { name: 'MORA PAZ,LUISA', exact: false } },
  );
  // Both words in two entries: no proposal.
  assert.deepEqual(
    suggestHrNames([{ id: 'a', code: 'A', label: 'Ana García' }], ['GARCÍA RUIZ,ANA', 'GARCÍA SOL,ANA MARÍA']),
    {},
  );
});

test('una propuesta aproximada exige al menos un apellido en común', () => {
  // Same given names, different surname: no proposal.
  assert.deepEqual(
    suggestHrNames([{ id: 'a', code: 'A', label: 'Ana María Pérez' }], ['GARCÍA,ANA MARÍA', 'SOL,LUIS']),
    {},
  );
  // Both surnames, nickname as given name: proposed, but only as approximate.
  assert.deepEqual(suggestHrNames([{ id: 'p', code: 'P', label: 'Pepe Mora Paz' }], ['MORA PAZ,JOSÉ', 'SOL,LUIS']), {
    p: { name: 'MORA PAZ,JOSÉ', exact: false },
  });
});

test('último recurso: un apellido que solo está en un nombre libre de la hoja', () => {
  const roster = ['TORRES MOLINA,MARIA JOSE', 'GÓMEZ SOL,KEKA', 'RUIZ PAZ,ANA', 'RUIZ VEGA,LUIS'];
  assert.deepEqual(
    suggestHrNames(
      [
        // Nickname + one surname: approximate.
        { id: 'k', code: 'K', label: 'Keka Torres' },
        // Surname in two entries: no proposal.
        { id: 'r', code: 'R', label: 'Pepe Ruiz' },
      ],
      roster,
    ),
    { k: { name: 'TORRES MOLINA,MARIA JOSE', exact: false } },
  );
  // Only the given name in common (KEKA is not a surname there): no proposal.
  assert.deepEqual(suggestHrNames([{ id: 'k', code: 'K', label: 'Keka Martín' }], roster), {});
  // Two members with that only surname: neither gets it.
  assert.deepEqual(
    suggestHrNames(
      [
        { id: 'a', code: 'A', label: 'Keka Torres' },
        { id: 'b', code: 'B', label: 'Pepa Torres' },
      ],
      roster,
    ),
    {},
  );
});
