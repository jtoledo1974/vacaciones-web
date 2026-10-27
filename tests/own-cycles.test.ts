import test from 'node:test';
import assert from 'node:assert/strict';
import type { AvailabilitySnapshot, CycleAvailability } from '../domain/occupancy.ts';
import { ownCycles, seatsLeft, splitPreferences } from '../app/own-cycles.ts';

const cycles = ['2027-01-07', '2027-01-15', '2027-01-23', '2027-01-31'].map((date) => ({ date, occupied: 1, max: 4 }));
function snapshot(rows: Record<string, Partial<CycleAvailability>>): AvailabilitySnapshot {
  const out: AvailabilitySnapshot = { policyVersion: 'p', status: 'exact', cycles: {}, checked: 0 };
  for (const [cycle, row] of Object.entries(rows))
    out.cycles[cycle] = {
      cycle,
      period: 0 as CycleAvailability['period'],
      occupied: 1,
      localMaximum: 4,
      status: 'exact',
      additional: 3,
      provenAdditional: 3,
      possibleAdditionalUpperBound: 3,
      slots: [],
      ...row,
    };
  return out;
}

test('ownCycles identifies the owner by member, not by shared cycle dates', () => {
  const awards = [
    { member_id: 'a', cycle_date: '2027-01-07' },
    { member_id: 'b', cycle_date: '2027-01-07' },
    { member_id: 'a', cycle_date: '2027-01-15', simulated: true },
  ];
  const own = ownCycles('a', awards, [{ member_id: 'a', dates: ['2027-01-23'] }]);
  assert.equal(own.owner, 'a');
  assert.deepEqual(own.mine, ['2027-01-07']);
  assert.deepEqual(own.preferences, ['2027-01-23']);
  assert.deepEqual(ownCycles(null, awards, []), { owner: undefined, mine: [], preferences: [] });
});

test('splitPreferences follows the occupancy engine: a proven zero is full even if the local quota has room', () => {
  const dates = ['2027-01-07', '2027-01-15', '2027-01-23', '2027-01-31'];
  const split = splitPreferences(
    dates,
    ['2027-01-07'],
    cycles,
    snapshot({
      '2027-01-15': { additional: 0, provenAdditional: 0, possibleAdditionalUpperBound: 0 },
      '2027-01-23': { status: 'indeterminate', additional: null, provenAdditional: 0, possibleAdditionalUpperBound: 2 },
      '2027-01-31': {},
    }),
    true,
  );
  assert.deepEqual([...split.owned], ['2027-01-07']);
  assert.deepEqual([...split.full], ['2027-01-15']);
  assert.deepEqual(split.active, ['2027-01-23', '2027-01-31']);
  assert.deepEqual([...split.unknown], ['2027-01-23']);
});

test('splitPreferences: an indeterminate cycle with no possible seat is full; unruled campaigns use the local quota', () => {
  const zero = snapshot({
    '2027-01-15': { status: 'indeterminate', additional: null, provenAdditional: 0, possibleAdditionalUpperBound: 0 },
  });
  assert.deepEqual([...splitPreferences(['2027-01-15'], [], cycles, zero, true).full], ['2027-01-15']);
  const local = cycles.map((c) => (c.date === '2027-01-15' ? { ...c, occupied: 4 } : c));
  const split = splitPreferences(['2027-01-15', '2027-01-23'], [], local, null, false);
  assert.deepEqual([...split.full], ['2027-01-15']);
  assert.deepEqual(split.active, ['2027-01-23']);
  assert.equal(split.unknown.size, 0);
});

test('seatsLeft says what the calendar shows: engine figures when ruled, local quota otherwise', () => {
  const cycle = cycles[0],
    data = (row: Partial<CycleAvailability>) => snapshot({ [cycle.date]: row });
  assert.equal(
    seatsLeft(cycle, data({ additional: 1, provenAdditional: 1, possibleAdditionalUpperBound: 1 }), true),
    'queda 1 plaza',
  );
  assert.equal(
    seatsLeft(cycle, data({ additional: 0, provenAdditional: 0, possibleAdditionalUpperBound: 0 }), true),
    'quedan 0 plazas',
  );
  assert.equal(
    seatsLeft(
      cycle,
      data({ status: 'indeterminate', additional: null, provenAdditional: 0, possibleAdditionalUpperBound: 2 }),
      true,
    ),
    'plazas por confirmar',
  );
  assert.equal(seatsLeft(cycle, null, true), 'plazas por confirmar');
  assert.equal(seatsLeft(cycle, null, false), 'quedan 3 plazas');
});

test('seatsLeft: sin motor, un ciclo completo con cupo adicional autorizado lo dice como el mapa', () => {
  const full = { date: '2027-01-07', occupied: 4, max: 4 };
  assert.equal(seatsLeft({ ...full, available: true }, null, false), 'cupo adicional posible');
  assert.equal(seatsLeft(full, null, false), 'quedan 0 plazas');
  assert.deepEqual(splitPreferences([full.date], [], [{ ...full, available: true }], null, false).active, [full.date]);
});
