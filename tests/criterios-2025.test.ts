import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig } from '../domain/defaults.ts';
import { calendar } from '../domain/calendar.ts';
import {
  choose,
  chooseJoint,
  currentTurn,
  defer,
  orderForRound,
  choiceIssues,
  type ElectionState,
  type ElectionContext,
} from '../domain/election.ts';
import { newcomerScore } from '../domain/historical-order.ts';

function fixture(cyclesPerPerson = 6) {
  const config = { ...defaultConfig(2026), cyclesPerPerson };
  const ctx: ElectionContext = {
    year: 2026,
    team: 'C',
    config,
    members: ['A', 'B', 'C'].map((id) => ({ id, code: id, seniority: '' })),
    requests: [],
    awards: [],
  };
  const state: ElectionState = {
    status: 'active',
    order: ['A', 'B', 'C'],
    cursor: 0,
    credits: {},
    source: 'Criterios Vacaciones 1.1, sorteo registrado',
    allowDeferral: true,
  };
  return { ctx, state, dates: calendar(2026, 'C', config).map((c) => c.date) };
}
test('Criterios 1.1 p.3: los empates rotan en todas las rondas; otros CTA conservan su posición', () => {
  const { ctx, state } = fixture();
  state.tieGroups = [['A', 'B']];
  assert.deepEqual(orderForRound(state, 0), ['A', 'B', 'C']);
  assert.deepEqual(orderForRound(state, 1), ['B', 'A', 'C']);
  assert.deepEqual(orderForRound(state, 2), ['A', 'B', 'C']);
  const r = currentTurn(ctx, { ...state, cursor: 3 });
  assert.equal(r.memberId, 'B');
});
test('Criterios 1.1 p.2: se aplazan dos turnos y se eligen tres ciclos atómicamente', () => {
  const { ctx, state, dates } = fixture();
  const first = defer(ctx, state, 'A');
  assert.equal(first.credits.A, 1);
  const second = defer(ctx, { ...first, cursor: 3 }, 'A');
  assert.equal(second.credits.A, 2);
  const turn = currentTurn(ctx, { ...second, cursor: 6 });
  assert.equal(turn.needed, 3);
  assert.throws(() => choose(ctx, turn.state, 'A', dates.slice(0, 2)), /3 ciclo/);
  const result = choose(ctx, turn.state, 'A', dates.slice(0, 3));
  assert.equal(result.choices.length, 3);
  assert.equal(result.state.credits.A, 0);
});
test('Criterios 1.1 p.2: dos CTA solicitan conjuntamente en el turno del último', () => {
  const { ctx, state, dates } = fixture();
  state.jointGroups = [['A', 'C']];
  assert.equal(currentTurn(ctx, state).memberId, 'B');
  const b = choose(ctx, state, 'B', [dates[0]]);
  const nextCtx = { ...ctx, awards: b.choices.map((c, i) => ({ ...c, id: 'b' + i })) };
  const turn = currentTurn(nextCtx, b.state);
  assert.equal(turn.memberId, 'C');
  assert.deepEqual(turn.participants, ['A', 'C']);
  assert.throws(() => choose(nextCtx, turn.state, 'C', [dates[1]]), /turno individual/);
  const result = chooseJoint(nextCtx, turn.state, [
    { member_id: 'A', dates: [dates[1]] },
    { member_id: 'C', dates: [dates[2]] },
  ]);
  assert.deepEqual(
    result.choices.map((c) => c.member_id),
    ['A', 'C'],
  );
});
test('Criterios 1.1 p.1: un cupo extra RRHH de un CTA impide un segundo', () => {
  const { ctx, dates } = fixture();
  ctx.config.specialQuotas = { [dates[0]]: 1 };
  ctx.awards = [{ id: 'one', member_id: 'A', cycle_date: dates[0] }];
  assert.ok(choiceIssues(ctx, 'B', [dates[0]]).some((message) => message.includes('cupo máximo')));
  assert.equal(choiceIssues(ctx, 'B', [dates[1]]).length, 0);
});
test('Criterios 1.1 p.3: nuevas incorporaciones usan puntos completos y medias de rondas ausentes', () => {
  const rounds = [
    [10, 20],
    [11, 21],
    [12, 22],
    [13, 23],
    [14, 24],
    [15, 25],
  ];
  assert.deepEqual(
    newcomerScore(
      [1, 2, 3, 4, 5, 6].map((round) => ({ round, points: 10 })),
      rounds,
    ),
    { score: 60, source: 'six-cycles', missingRounds: [] },
  );
  assert.equal(
    newcomerScore(
      [1, 2, 3, 4, 5].map((round) => ({ round, points: 10 })),
      rounds,
    ).score,
    50 + 20,
  );
  assert.equal(
    newcomerScore(
      [1, 2, 3, 4].map((round) => ({ round, points: 10 })),
      rounds,
    ).score,
    40 + 19 + 20,
  );
  assert.equal(
    newcomerScore(
      [1, 2, 3].map((round) => ({ round, points: 10 })),
      rounds,
    ).score,
    (10 + 11 + 12 + 13 + 14 + 15 + 20 + 21 + 22 + 23 + 24 + 25) / 2 + 1,
  );
});
