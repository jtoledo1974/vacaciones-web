import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderAwardsBySelection } from '../domain/award-display-order.ts';

const choice = (member_id: string, cycle_date: string) => ({ member_id, cycle_date });
const event = (...choices: ReturnType<typeof choice>[]) => ({ kind: 'choice', choices });

test('5 de agosto: DAVID figura antes que GONZALO aunque D1 devuelva las adjudicaciones al revés', () => {
  const date = '2027-08-05';
  const david = { id: 'david-award', ...choice('DAVID', date) };
  const gonzalo = { id: 'gonzalo-award', ...choice('GONZALO', date) };
  const awards = [gonzalo, david];
  const sorted = orderAwardsBySelection(awards, [event(choice('GONZALO', date)), event(choice('DAVID', date))]);
  assert.deepEqual(
    sorted.map((a) => a.member_id),
    ['DAVID', 'GONZALO'],
  );
  assert.deepEqual(
    awards.map((a) => a.member_id),
    ['GONZALO', 'DAVID'],
    'no modifica los datos originales',
  );
  assert.deepEqual(
    sorted.map((a) => a.id),
    ['david-award', 'gonzalo-award'],
  );
});

test('turnos conjuntos y dobles: orden de selección dentro de un mismo evento', () => {
  const date = '2027-08-05';
  const a = choice('A', date),
    b = choice('B', date),
    c = choice('C', date),
    d = choice('D', date);
  assert.deepEqual(orderAwardsBySelection([d, b, c, a], [event(d), event(b, c), event(a)]), [a, b, c, d]);
});

test('undo/redo y reconstrucción: solo cuenta el orden de las decisiones vigentes', () => {
  const date = '2027-08-05';
  const david = choice('DAVID', date),
    gonzalo = choice('GONZALO', date);
  const input = [gonzalo, david];
  assert.deepEqual(orderAwardsBySelection(input, [event(gonzalo), event(david)]), [david, gonzalo]);
  assert.deepEqual(orderAwardsBySelection(input, [event(david), event(gonzalo)]), [gonzalo, david]);
});

test('sin historial: importaciones mantienen el orden de entrada sin inventar secuencia', () => {
  const date = '2027-08-05';
  const legacy1 = choice('IMPORTADO1', date),
    legacy2 = choice('IMPORTADO2', date),
    david = choice('DAVID', date),
    gonzalo = choice('GONZALO', date);
  assert.deepEqual(orderAwardsBySelection([legacy1, gonzalo, legacy2, david], [event(gonzalo), event(david)]), [
    legacy1,
    legacy2,
    david,
    gonzalo,
  ]);
  assert.deepEqual(orderAwardsBySelection([gonzalo, david], []), [gonzalo, david]);
});
