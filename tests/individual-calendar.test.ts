import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig, copyConfig } from '../domain/defaults.ts';
import { rotationCode, serial, validateConfig } from '../domain/calendar.ts';
import { calendarHolidaysForYear, officialHolidays } from '../domain/official-holidays.ts';
import { individualCalendarRanges, renderIndividualCalendarPdf } from '../server/individual-calendar-pdf.ts';
import { liteSummary } from '../server/lite.ts';

const view = {
  campaign: { team_id: 'D', year: 2027, scope_key: 'live' },
  members: [
    { id: 'alfredo', code: 'ALFREDO' },
    { id: 'other', code: 'OTHER' },
  ],
  awards: [
    { id: '1', member_id: 'alfredo', cycle_date: '2027-02-04' },
    { id: '2', member_id: 'other', cycle_date: '2027-02-04' },
    { id: '3', member_id: 'alfredo', cycle_date: '2027-03-16' },
  ],
  result: {
    cycles: [
      { date: '2027-02-04', end: '2027-02-11', score: 50, period: 0, occupied: 2, max: 3 },
      { date: '2027-03-16', end: '2027-03-23', score: 50, period: 0, occupied: 1, max: 3 },
    ],
  },
} as never;

test('official Sevilla 2027 holidays: local dates and Sunday transfers are exact', () => {
  const holidays = officialHolidays(2027);
  assert.equal(holidays.length, 14);
  assert.deepEqual(
    holidays.filter((h) => h.local).map((h) => h.date),
    ['2027-04-14', '2027-05-27'],
  );
  assert.ok(holidays.some((h) => h.date === '2027-03-01' && h.label === 'Día de Andalucía'));
  assert.ok(holidays.some((h) => h.date === '2027-08-16' && h.label === 'Asunción'));
  assert.ok(!holidays.some((h) => h.date === '2027-02-28' || h.date === '2027-08-15'));
  assert.deepEqual(officialHolidays(2028), []);
});

test('year rules override defaults; copying a campaign never transfers last year holidays', () => {
  const defaults = defaultConfig(2027);
  assert.equal(calendarHolidaysForYear(2027, {} as never).length, 14);
  assert.deepEqual(calendarHolidaysForYear(2027, { calendarHolidays: [] }), []);
  const copied = copyConfig(defaults, 2027, 2028);
  assert.deepEqual(copied.calendarHolidays, []);
  assert.ok(officialHolidays(2027).length === 14);
  validateConfig(defaults, 2027);
  assert.throws(
    () =>
      validateConfig(
        {
          ...defaults,
          calendarHolidays: [
            { date: '2027-04-14', label: 'Feria' },
            { date: '2027-04-14', label: 'Duplicado' },
          ],
        },
        2027,
      ),
    /repetidos/,
  );
  assert.throws(
    () => validateConfig({ ...defaults, calendarHolidays: [{ date: '2028-01-01', label: 'Otro año' }] }, 2027),
    /fuera del ejercicio/,
  );
});

test('individual calendar includes only that CTA awards and one valid landscape PDF page', () => {
  const summary = liteSummary(view, new Date('2026-10-28T11:00:00Z'));
  assert.deepEqual(individualCalendarRanges(summary, 'ALFREDO'), [
    { date: '2027-02-04', end: '2027-02-11' },
    { date: '2027-03-16', end: '2027-03-23' },
  ]);
  assert.throws(() => individualCalendarRanges(summary, 'INVALID'), /no pertenece/);
  const pdf = renderIndividualCalendarPdf(summary, 'ALFREDO', defaultConfig(2027));
  assert.ok(pdf.startsWith('%PDF-1.4') && pdf.endsWith('%%EOF\n'));
  assert.ok(pdf.includes('/MediaBox [0 0 842 595]'));
  assert.equal(pdf.split('/Type /Page ').length - 1, 1);
  assert.ok(pdf.includes('(ALFREDO)') || pdf.includes('ALFREDO'));
  assert.ok(pdf.includes('(Vacaciones ordinarias: 04/02-11/02  |  16/03-23/03)'));
  assert.ok(pdf.includes('14/04 Feria de Sevilla \\(local\\)'), 'full holiday legend is printed');
  assert.ok(!pdf.includes('(OTHER)'));
  const start = Number(pdf.match(/startxref\n(\d+)/)![1]);
  assert.ok(pdf.slice(start).startsWith('xref'));
});

test('team D shift cycle is five working days and three rest days', () => {
  const config = defaultConfig(2027);
  const jan = serial('2027-01-01');
  const codes = Array.from({ length: 8 }, (_, n) => rotationCode(jan + n, 2027, 'D', config));
  assert.equal(codes.filter((c) => c !== ' ').length, 5);
  assert.equal(codes.filter((c) => c === ' ').length, 3);
});
