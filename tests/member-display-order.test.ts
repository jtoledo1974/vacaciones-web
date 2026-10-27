import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderMemberAwards, orderMemberIds } from '../domain/member-display-order.ts';
import { orderAwardsBySelection } from '../domain/award-display-order.ts';

test('CTA: orden de petición por defecto o puntos acumulados ascendentes; empates estables', () => {
  const ids = ['A', 'B', 'C', 'D'],
    points = new Map([
      ['A', 80],
      ['B', 12],
      ['C', 12],
      ['D', 34],
    ]);
  assert.deepEqual(orderMemberIds(ids, points, 'request'), ids);
  assert.deepEqual(orderMemberIds(ids, points, 'points'), ['B', 'C', 'D', 'A']);
  assert.deepEqual(ids, ['A', 'B', 'C', 'D']);
  assert.deepEqual(
    orderMemberIds(
      ids,
      new Map([
        ['A', 10],
        ['B', 10],
      ]),
      'points',
    ),
    ['C', 'D', 'A', 'B'],
  );
});

test('ciclos: orden cronológico o el de selección sin mutar los registros', () => {
  const awards = [{ cycle_date: '2027-09-10' }, { cycle_date: '2027-02-10' }, { cycle_date: '2027-06-10' }];
  assert.deepEqual(
    orderMemberAwards(awards, 'chronological').map((a) => a.cycle_date),
    ['2027-02-10', '2027-06-10', '2027-09-10'],
  );
  assert.deepEqual(orderMemberAwards(awards, 'request'), awards);
  assert.equal(awards[0].cycle_date, '2027-09-10');
});

test('ciclos: orden de petición respeta historial efectivo aun tras deshacer/reconstruir', () => {
  const awards = [
    { id: 'last', member_id: 'A', cycle_date: '2027-01-10' },
    { id: 'first', member_id: 'A', cycle_date: '2027-10-10' },
    { id: 'second', member_id: 'A', cycle_date: '2027-06-10' },
  ];
  const effective = orderAwardsBySelection(awards, [
    { kind: 'choice', choices: [{ member_id: 'A', cycle_date: '2027-01-10' }] },
    { kind: 'choice', choices: [{ member_id: 'A', cycle_date: '2027-06-10' }] },
    { kind: 'choice', choices: [{ member_id: 'A', cycle_date: '2027-10-10' }] },
  ]);
  assert.deepEqual(
    orderMemberAwards(effective, 'request').map((a) => a.id),
    ['first', 'second', 'last'],
  );
  assert.deepEqual(
    orderMemberAwards(effective, 'chronological').map((a) => a.id),
    ['last', 'second', 'first'],
  );
});
