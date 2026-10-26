import { test } from 'node:test';
import assert from 'node:assert/strict';
import reference from './historical-2020-2022.json' with { type: 'json' };
import { defaultConfig } from '../domain/defaults.ts';
import { calendar, type Config } from '../domain/calendar.ts';
import { calculate, type Award, type Member, type Request } from '../domain/vacations.ts';
import { choose, currentTurn, type ElectionState, type ElectionContext } from '../domain/election.ts';

// Values are transcribed from cached cells of the two *different* Excel files.
// The daily-score transitions are independent of the cached K5:K50 cycle totals.
// Using them as baseScores with no holidays validates the cycle grid, aggregation,
// requests/selection logic and rollover, NOT independently the holiday formulas.
type Case = (typeof reference.cases)[number];
const words = (value: string) => value.split(' ').filter(Boolean);
const numbers = (value: string) => words(value).map(Number);

function historicalConfig(data: Case): Config {
  const config = defaultConfig(data.year);
  config.correturnos = data.correturnos;
  config.excludeLast = false; // The older Vac!L5:L50 grid contains 46 cycles.
  config.excludePenultimate = false;
  config.holidays = []; // Avoid applying current holiday rules to historical daily scores.
  config.baseScores = words(data.dailyTransitions).map((item) => {
    const [iso, rawScore] = item.split(':');
    return {
      month: Number(iso.slice(5, 7)),
      day: Number(iso.slice(8, 10)),
      score: Number(rawScore),
      nextYear: Number(iso.slice(0, 4)) > data.year,
    };
  });
  config.specialCycles = [];
  // Historical Vac!F1 authorises 15 extra allocations. The current relation
  // engine has no dedicated F1 field, so graceJanuary is the equivalent global
  // allowance for this retrospective check. It is NOT an annual RRHH setting.
  config.relation = { minimum: 1, base: 2, maximum: 3, graceJanuary: data.allowedAdditional, graceOctober: 0 };
  config.grace = [data.allowedAdditional, 0, data.allowedAdditional];
  return config;
}

for (const data of reference.cases) {
  test('Excel ' + data.year + ' H: reconstruir las 46 fechas (incluido correturnos)', () => {
    const actual = calendar(data.year, data.team, historicalConfig(data));
    assert.deepEqual(
      actual.map((x) => x.date),
      words(data.dates),
    );
    assert.equal(actual.length, 46);
    if (data.year === 2020) {
      const gap = actual.findIndex(
        (v, i) => i > 0 && Date.parse(v.date) - Date.parse(actual[i - 1].date) === 9 * 86400000,
      );
      assert.equal(actual[gap - 1]?.date, '2020-02-27');
      assert.equal(actual[gap]?.date, '2020-03-07');
    }
  });
  test('Excel ' + data.year + ' H: sumar puntuaciones diarias y comparar con K5:K50', () => {
    const actual = calendar(data.year, data.team, historicalConfig(data));
    const expected = numbers(data.scores);
    // The 2022 Baremo cache contains #N/A for 2023-01-10: K50 cannot be
    // independently confirmed; retain the last date but do not certify its score.
    const checked = data.year === 2022 ? 45 : 46;
    assert.deepEqual(
      actual.slice(0, checked).map((x) => x.score),
      expected.slice(0, checked),
    );
  });
}

test('Excel 2020 H: reproducir cronológicamente 90 elecciones respetando los cupos', () => {
  const data = reference.cases[0] as Case & {
    picks: string[];
    personScores: number[];
    nextOrder: number[];
    nextScores: number[];
  };
  assert.equal(data.year, 2020);
  const config = historicalConfig(data),
    dates = words(data.dates),
    expectedScores = numbers(data.scores);
  const picks = data.picks!.map(numbers);
  const members: Member[] = picks.map((_, i) => ({
    id: 'P' + String(i + 1).padStart(2, '0'),
    code: 'P' + String(i + 1).padStart(2, '0'),
    seniority: '',
  }));
  let ctx: ElectionContext = { year: 2020, team: 'H', config, members, requests: [], awards: [] };
  let state: ElectionState = {
    status: 'active',
    order: members.map((x) => x.id),
    cursor: 0,
    credits: {},
    source: 'Vac!A6:B20; elección real guardada de 2020',
    allowDeferral: false,
    policyVersion: 'replay-historico-2020',
  };
  const orderedEntries: { round: number; memberId: string; cycleDate: string }[] = [];
  for (let round = 0; round < 6; round++) {
    for (let i = 0; i < members.length; i++) {
      const member = members[i],
        date = dates[picks[i][round]];
      const turn = currentTurn(ctx, state);
      assert.equal(turn.memberId, member.id, 'orden de elección, ronda ' + (round + 1) + ' miembro ' + member.id);
      assert.equal(turn.round, round + 1);
      const result = choose(ctx, state, member.id, [date]);
      assert.equal(result.choices.length, 1);
      const awards: Award[] = result.choices.map((p, j) => ({
        id: 'A-' + round + '-' + i + '-' + j,
        member_id: p.member_id,
        cycle_date: p.cycle_date,
      }));
      const requests: Request[] = result.choices.map((p, j) => ({
        id: 'R-' + round + '-' + i + '-' + j,
        member_id: p.member_id,
        slot: round + 1,
        cycle_date: p.cycle_date,
      }));
      ctx = { ...ctx, requests: [...ctx.requests, ...requests], awards: [...ctx.awards, ...awards] };
      state = result.state;
      orderedEntries.push({ round: round + 1, memberId: member.id, cycleDate: date });
    }
  }
  assert.equal(state.status, 'complete');
  assert.equal(ctx.awards.length, 90);
  assert.equal(ctx.requests.length, 90);
  const result = calculate(2020, 'H', config, members, ctx.requests, ctx.awards);
  assert.deepEqual(result.issues, []);
  const occupancy = result.cycles.map((c) => c.occupied);
  assert.equal(
    occupancy.reduce((a, b) => a + b, 0),
    90,
  );
  assert.equal(occupancy.filter((n) => n === 1).length, 11);
  assert.equal(occupancy.filter((n) => n === 2).length, 26);
  assert.equal(occupancy.filter((n) => n === 3).length, 9);
  assert.ok(occupancy.every((n) => n >= 1 && n <= 3));
  assert.ok(occupancy.filter((n) => n === 3).length <= data.allowedAdditional);
  const expectedPicks = picks.map((row) => row.map((i) => dates[i]));
  for (const [i, member] of members.entries()) {
    assert.deepEqual(
      ctx.awards.filter((a) => a.member_id === member.id).map((a) => a.cycle_date),
      expectedPicks[i],
    );
    assert.equal(result.ordering.find((m) => m.id === member.id)?.score, data.personScores![i]);
    assert.equal(
      expectedPicks[i].reduce((sum, date) => sum + expectedScores[dates.indexOf(date)], 0),
      data.personScores![i],
    );
  }
  assert.deepEqual(
    result.ordering.map((m) => members.findIndex((p) => p.id === m.id)),
    data.nextOrder,
  );
  assert.deepEqual(
    result.ordering.map((m) => m.score),
    data.nextScores,
  );
  // This equality comes from the preserved historical grid, not inferred timing.
  assert.deepEqual(picks[4], picks[6]); // Two CTA requested exactly the same six cycles.
  assert.equal(orderedEntries.length, 90);
});
