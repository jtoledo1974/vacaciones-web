import test from 'node:test';
import assert from 'node:assert/strict';
import { formatLogWhen, formatLogWhenFull } from '../domain/log-when.ts';

// Tuesday 27 October 2026, 16:00 in Madrid (CET, UTC+1).
const now = Date.parse('2026-10-27T15:00:00Z');

test('today shows only the time', () => {
  assert.equal(formatLogWhen('2026-10-27T08:05:00Z', now), '09:05');
  // 00:30 Madrid is still today even though it is the previous UTC day.
  assert.equal(formatLogWhen('2026-10-26T23:30:00Z', now), '00:30');
});

test('yesterday says «ayer»', () => {
  assert.equal(formatLogWhen('2026-10-26T17:57:00Z', now), 'ayer 18:57');
});

test('within the week shows the weekday letter', () => {
  // 22 Oct was still summer time (UTC+2).
  assert.equal(formatLogWhen('2026-10-22T16:57:00Z', now), 'J 18:57');
  assert.equal(formatLogWhen('2026-10-21T08:00:00Z', now), 'X 10:00');
});

test('a week or more shows no date at all (the icon tooltip carries it)', () => {
  assert.equal(formatLogWhen('2026-10-20T10:00:00Z', now), null);
  assert.equal(formatLogWhen('2025-10-01T10:00:00Z', now), null);
});

test('the full date in the tooltip includes the year', () => {
  const lastYear = formatLogWhenFull('2025-10-22T16:57:00Z'),
    thisYear = formatLogWhenFull('2026-10-22T16:57:00Z');
  assert.match(lastYear, /2025/);
  assert.match(thisYear, /2026/);
  assert.notEqual(lastYear, thisYear);
});
