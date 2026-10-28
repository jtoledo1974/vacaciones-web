import test from 'node:test';
import assert from 'node:assert/strict';
import { dailyScore, holidayDates, calendar, serial } from '../domain/calendar.ts';
import { defaultConfig, copyConfig } from '../domain/defaults.ts';
import { cycleTable, nextYearOrdering } from '../domain/vacations.ts';
import { hasAnnualScoring, scoringVersion, scoringWeights } from '../domain/scoring.ts';
import reference from './fixtures/scoring-2027-final2.json' with { type: 'json' };

// Independent transcription of the corrected-date column in FINAL2 V22.
const approved: [string, number][] = [
  ['2027-01-01', 10],
  ['2027-01-06', 9],
  ['2027-03-01', 8],
  ['2027-03-22', 9],
  ['2027-03-28', 9],
  ['2027-04-10', 5],
  ['2027-04-11', 5],
  ['2027-04-12', 8],
  ['2027-04-18', 8],
  ['2027-05-01', 8],
  ['2027-04-14', 8],
  ['2027-05-27', 8],
  ['2027-08-16', 10],
  ['2027-10-12', 8],
  ['2027-11-01', 8],
  ['2027-12-06', 8],
  ['2027-12-08', 8],
  ['2028-01-01', 10],
  ['2028-01-06', 9],
];

test('2027: all 19 corrected holiday dates and scores match the approved table', () => {
  const c = defaultConfig(2027);
  const actual = holidayDates(2027, c);
  assert.equal(actual.length, approved.length);
  for (const [date, score] of approved) {
    assert.equal(actual.find((h) => h.date === date)?.score, score, date);
    assert.equal(dailyScore(serial(date), 2027, c), score, date);
  }
});

test('2027: stored legacy Saturday and Corpus flags cannot override annual authority', () => {
  const legacy = defaultConfig(2026);
  assert.equal(legacy.holidays.find((h) => h.label === 'Día del Trabajo')?.saturdayBase, true);
  for (const [date, score] of approved) assert.equal(dailyScore(serial(date), 2027, legacy), score, date);
  assert.equal(dailyScore(serial('2027-05-02'), 2027, legacy), 5);
});

test('2027: Holy Week and Feria retain their complete scoring intervals', () => {
  const c = defaultConfig(2027);
  for (let d = 22; d <= 28; d++) assert.equal(dailyScore(serial(`2027-03-${d}`), 2027, c), 9);
  for (let d = 12; d <= 18; d++) assert.equal(dailyScore(serial(`2027-04-${d}`), 2027, c), 8);
});

test('campaign initialization and copying select the destination annual baremo', () => {
  const old = defaultConfig(2026);
  const c = copyConfig(old, 2026, 2027);
  assert.deepEqual(c.holidays, defaultConfig(2027).holidays);
  assert.deepEqual(c.baseScores, defaultConfig(2027).baseScores);
  assert.deepEqual(copyConfig(c, 2027, 2028).holidays, defaultConfig(2028).holidays);
  assert.deepEqual(copyConfig(c, 2027, 2028).baseScores, defaultConfig(2028).baseScores);
  assert.equal(old.holidays.find((h) => h.label === 'Día del Trabajo')?.saturdayBase, true);
  c.holidays[0].score = 1;
  assert.equal(defaultConfig(2027).holidays[0].score, 10);
  const custom = defaultConfig(2026);
  custom.holidays[0].score = 11;
  assert.equal(copyConfig(custom, 2026, 2028).holidays[0].score, 11);
});

test('2027: every team matches independent FINAL2 daily values, including next-year ordering', () => {
  const c = defaultConfig(2027);
  const normative = new Map(reference.daily.map((d) => [serial(d.date), d.score]));
  for (const team of 'ABCDEFGH') {
    const cycles = calendar(2027, team, c);
    for (const cycle of cycles) {
      const start = serial(cycle.date);
      let sum = 0;
      for (let d = 0; d < 8; d++) {
        const expected = normative.get(start + d);
        assert.notEqual(expected, undefined, `Falta referencia ${team} ${cycle.date} día ${d}`);
        sum += expected!;
      }
      assert.equal(cycle.score, sum, `${team} ${cycle.date}`);
    }
    const may = cycles.find((x) => serial(x.date) <= serial('2027-05-01') && serial(x.end) >= serial('2027-05-01'))!;
    const member = { id: 'a', code: 'A', seniority: '2000-01-01' };
    const requests = [{ id: 'r', member_id: 'a', slot: 1, cycle_date: may.date }];
    const result = nextYearOrdering(2027, cycleTable(2027, team, c, requests, []), c, [member], requests);
    assert.equal(result[0].score, may.score);
  }
});

test('FINAL2: all 397 daily scores match the saved workbook, including legacy campaigns', () => {
  for (const config of [defaultConfig(2027), defaultConfig(2026)]) {
    for (const d of reference.daily) {
      assert.equal(d.score, Math.max(d.base, d.holiday), d.date);
      assert.equal(dailyScore(serial(d.date), 2027, config), d.score, d.date);
    }
  }
});

function legacy2027() {
  const old = defaultConfig(2026);
  return { ...defaultConfig(2027), baseScores: old.baseScores, holidays: old.holidays };
}

test('FINAL2: every BRAVO cycle matches the 46 workbook totals', () => {
  for (const config of [defaultConfig(2027), legacy2027()]) {
    const cycles = calendar(2027, 'B', config).map(({ date, score }) => ({ date, score }));
    assert.deepEqual(cycles, reference.cycles);
  }
});

test('FINAL2: all 20 accumulated totals match the six selections per controller', () => {
  const config = legacy2027(); // Existing campaigns may store old formulas and arbitrary weights.
  config.weights = [2, 3, 4, 5, 6, 7];
  const members = reference.controllers.map((c) => ({
    id: `row-${c.sourceRow}`,
    code: `CTA-${c.sourceRow}`,
    seniority: '',
  }));
  const requests = reference.controllers.flatMap((c) =>
    c.dates.map((date, i) => ({
      id: `r-${c.sourceRow}-${i}`,
      member_id: `row-${c.sourceRow}`,
      slot: i + 1,
      cycle_date: date,
    })),
  );
  const before = JSON.stringify({ config, members, requests });
  const ordering = nextYearOrdering(2027, cycleTable(2027, 'B', config, requests, []), config, members, requests);
  assert.equal(requests.length, 120);
  for (const c of reference.controllers)
    assert.equal(ordering.find((m) => m.id === `row-${c.sourceRow}`)?.score, c.score, `Fila ${c.sourceRow}`);
  assert.equal(
    JSON.stringify({ config, members, requests }),
    before,
    'No modificar las selecciones ni la configuración guardada',
  );
  // Rows 8 and 12: next-year order flips once May 1 contributes eight points.
  assert.equal(ordering.findIndex((m) => m.id === 'row-8') + 1, 15);
  assert.equal(ordering.findIndex((m) => m.id === 'row-12') + 1, 16);
});

test('annual scoring is selected by the established policy registry', () => {
  assert.equal(hasAnnualScoring(2027), true);
  assert.equal(scoringVersion(2027), 'lecs-2027-final2-v22.0.0.d1-2');
  assert.equal(hasAnnualScoring(2026), false);
  assert.equal(scoringVersion(2026), 'legacy-config');
});

test('2027: official weights match Vac!D5:I5; copying cannot import arbitrary legacy weights', () => {
  const old = defaultConfig(2026);
  old.weights = [2, 3, 4, 5, 6, 7];
  const snapshot = JSON.stringify(old);
  assert.deepEqual(scoringWeights(2027, old.weights), reference.weights);
  assert.deepEqual(defaultConfig(2027).weights, reference.weights);
  assert.deepEqual(copyConfig(old, 2026, 2027).weights, reference.weights);
  assert.equal(JSON.stringify(old), snapshot);
  // Unregistered historical years retain their saved behavior; this PR validates 2027 only.
  assert.deepEqual(scoringWeights(2026, old.weights), old.weights);
});

test('annual MAX never reduces the base when overlapping holidays have a lower score', () => {
  // Asunción already has the maximum base: ten, not ten plus ten.
  assert.equal(dailyScore(serial('2027-08-16'), 2027, defaultConfig(2027)), 10);
  assert.equal(dailyScore(serial('2027-05-01'), 2027, defaultConfig(2027)), 8);
  assert.equal(dailyScore(serial('2028-01-01'), 2027, defaultConfig(2027)), 10);
});
