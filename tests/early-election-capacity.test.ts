import assert from 'node:assert/strict';
import test from 'node:test';
import {hasUncontestedLocalSeat, type EarlyCycleLocalBound} from '../domain/early-election-capacity.ts';

const bound = (overrides: Partial<EarlyCycleLocalBound> = {}): EarlyCycleLocalBound => ({
  candidateMemberId: 'candidate',
  minimumCapacity: 2,
  occupiedMemberIds: [],
  potentialEarlierMemberIds: ['first'],
  ...overrides
});

test('one earlier controller cannot fill both ordinary seats', () => {
  assert.equal(hasUncontestedLocalSeat(bound()), true);
  assert.equal(hasUncontestedLocalSeat(bound({potentialEarlierMemberIds: ['first', 'second']})), false);
});

test('three earlier candidates cannot fill four proven seats, but four can', () => {
  assert.equal(hasUncontestedLocalSeat(bound({minimumCapacity: 4, potentialEarlierMemberIds: ['a', 'b', 'c']})), true);
  assert.equal(hasUncontestedLocalSeat(bound({minimumCapacity: 4, potentialEarlierMemberIds: ['a', 'b', 'c', 'd']})), false);
});

test('a controller with several deferred choices cannot take the same cycle twice', () => {
  assert.equal(hasUncontestedLocalSeat(bound({potentialEarlierMemberIds: ['first', 'first', 'first']})), true);
});

test('a joint selection may consume a place for each participant', () => {
  assert.equal(hasUncontestedLocalSeat(bound({potentialEarlierMemberIds: ['group-1', 'group-2']})), false);
  assert.equal(hasUncontestedLocalSeat(bound({minimumCapacity: 3, potentialEarlierMemberIds: ['group-1', 'group-2']})), true);
});

test('an earlier person already in this cycle cannot claim another place', () => {
  assert.equal(hasUncontestedLocalSeat(bound({
    minimumCapacity: 3, occupiedMemberIds: ['first'], potentialEarlierMemberIds: ['first', 'second']
  })), true);
  assert.equal(hasUncontestedLocalSeat(bound({
    minimumCapacity: 2, occupiedMemberIds: ['first'], potentialEarlierMemberIds: ['first', 'second']
  })), false);
});

test('use only the proved minimum capacity, never the displayed tentative fourth place', () => {
  assert.equal(hasUncontestedLocalSeat(bound({
    minimumCapacity: 3, occupiedMemberIds: [], potentialEarlierMemberIds: ['a', 'b', 'c']
  })), false);
});

test('already selected, full or malformed snapshots fail closed', () => {
  assert.equal(hasUncontestedLocalSeat(bound({occupiedMemberIds: ['candidate']})), false);
  assert.equal(hasUncontestedLocalSeat(bound({occupiedMemberIds: ['a', 'b']})), false);
  assert.equal(hasUncontestedLocalSeat(bound({minimumCapacity: null})), false);
  assert.equal(hasUncontestedLocalSeat(bound({minimumCapacity: Number.NaN})), false);
  assert.equal(hasUncontestedLocalSeat(bound({minimumCapacity: -1})), false);
  assert.equal(hasUncontestedLocalSeat(bound({minimumCapacity: 2.5})), false);
  assert.equal(hasUncontestedLocalSeat(bound({occupiedMemberIds: ['same', 'same']})), false);
  assert.equal(hasUncontestedLocalSeat(bound({potentialEarlierMemberIds: ['candidate']})), false);
});
