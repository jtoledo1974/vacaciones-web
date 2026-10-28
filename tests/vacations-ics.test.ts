import test from 'node:test';
import assert from 'node:assert/strict';
import { foldLine, personalVacationCalendar, type PersonalCalendarSource } from '../app/vacations-ics.ts';

function closedCampaign(): PersonalCalendarSource {
  const dates = ['2027-01-07', '2027-03-01', '2027-05-10', '2027-08-02', '2027-10-20', '2027-12-28'];
  const ends = ['2027-01-14', '2027-03-08', '2027-05-17', '2027-08-09', '2027-10-27', '2028-01-04'];
  return {
    campaign: { year: 2027, team_id: 'B', status: 'closed', scope_key: 'live', data_kind: 'configured' },
    election: { myMemberId: 'controller-1' },
    awards: [
      { member_id: 'controller-2', cycle_date: dates[0] },
      ...dates.map((cycle_date) => ({ member_id: 'controller-1', cycle_date })),
    ],
    result: { cycles: dates.map((date, i) => ({ date, end: ends[i] })) },
  };
}

test('one RFC 5545 file holds six eight-day all-day events belonging only to the user', () => {
  const file = personalVacationCalendar(closedCampaign(), new Date('2026-10-28T12:00:00Z'));
  assert.ok(file);
  assert.equal(file.filename, 'vacaciones-2027-equipo-B.ics');
  assert.equal(file.count, 6);
  assert.equal(file.content.match(/BEGIN:VEVENT/g)?.length, 6);
  assert.equal(file.content.match(/SUMMARY:Vacaciones/g)?.length, 6);
  assert.match(file.content, /DTSTART;VALUE=DATE:20270107\r\nDTEND;VALUE=DATE:20270115/);
  assert.match(file.content, /DTSTART;VALUE=DATE:20271228\r\nDTEND;VALUE=DATE:20280105/);
  assert.match(file.content, /DTSTAMP:20261028T120000Z/);
  assert.match(file.content, /TRANSP:OPAQUE/);
  assert.ok(file.content.endsWith('END:VCALENDAR\r\n'));
  assert.equal(file.content.replace(/\r\n/g, '').includes('\n'), false, 'CRLF only');
  assert.equal(file.content.includes('controller-2'), false);
});

test('leap-year correturnos includes the exceptional extra day from the engine', () => {
  const campaign = closedCampaign();
  campaign.campaign.year = 2028;
  campaign.awards = [{ member_id: 'controller-1', cycle_date: '2028-02-25' }];
  campaign.result.cycles = [{ date: '2028-02-25', end: '2028-03-04' }];
  const file = personalVacationCalendar(campaign);
  assert.ok(file);
  assert.equal(file.count, 1);
  assert.match(file.content, /DTSTART;VALUE=DATE:20280225\r\nDTEND;VALUE=DATE:20280305/);
});

test('anonymous, preview, demo, simulation and open campaigns have no download', () => {
  const base = closedCampaign();
  assert.equal(personalVacationCalendar({ ...base, election: { myMemberId: null } }), null);
  assert.equal(personalVacationCalendar({ ...base, election: undefined }), null);
  assert.equal(personalVacationCalendar({ ...base, preview: { code: 'CT1' } }), null);
  assert.equal(personalVacationCalendar({ ...base, campaign: { ...base.campaign, status: 'open' } }), null);
  assert.equal(personalVacationCalendar({ ...base, campaign: { ...base.campaign, scope_key: 'simulation' } }), null);
  assert.equal(personalVacationCalendar({ ...base, campaign: { ...base.campaign, data_kind: 'demo' } }), null);
});

test('fewer approved cycles, duplicate award rows and simulation awards are handled correctly', () => {
  const base = closedCampaign();
  base.awards = [
    { member_id: 'controller-2', cycle_date: '2027-01-07' },
    { member_id: 'controller-1', cycle_date: '2027-10-20' },
    { member_id: 'controller-1', cycle_date: '2027-10-20' },
    { member_id: 'controller-1', cycle_date: '2027-12-28', simulated: true },
  ];
  const file = personalVacationCalendar(base);
  assert.ok(file);
  assert.equal(file.count, 1);
  assert.match(file.content, /DTSTART;VALUE=DATE:20271020/);
  assert.doesNotMatch(file.content, /DTSTART;VALUE=DATE:20270107/);
  assert.doesNotMatch(file.content, /DTSTART;VALUE=DATE:20271228/);
});

test('missing or invalid cycle dates fail closed rather than creating a partial calendar', () => {
  const base = closedCampaign();
  base.awards.push({ member_id: 'controller-1', cycle_date: '2027-07-01' });
  assert.equal(personalVacationCalendar(base), null);
  base.awards.pop();
  base.result.cycles[0].end = '2027-01-12';
  assert.equal(personalVacationCalendar(base), null);
  base.result.cycles[0].end = '2027-02-30';
  assert.equal(personalVacationCalendar(base), null);
});

test('long UTF-8 UIDs fold at 75 octets and do not change between imports', () => {
  const base = closedCampaign();
  const id = 'usuario_é'.repeat(14);
  base.election = { myMemberId: id };
  base.awards = [{ member_id: id, cycle_date: '2027-01-07' }];
  const first = personalVacationCalendar(base, new Date('2026-10-28T12:00:00Z'));
  const second = personalVacationCalendar(base, new Date('2026-10-29T12:00:00Z'));
  assert.ok(first && second);
  const uid = first.content.match(/UID:.*?(?=\r\nDTSTAMP:)/s)?.[0];
  assert.ok(uid);
  assert.equal(uid, second.content.match(/UID:.*?(?=\r\nDTSTAMP:)/s)?.[0]);
  assert.ok(first.content.split('\r\n').every((line) => Buffer.byteLength(line, 'utf8') <= 75));
  assert.match(uid, /\r\n /);
});

test('folding never splits a multibyte character and each line stays within 75 octets', () => {
  const text = 'SUMMARY:' + 'ñé€😀'.repeat(20);
  const lines = foldLine(text).split('\r\n');
  assert.ok(lines.length > 1);
  assert.ok(lines.every((line) => Buffer.byteLength(line, 'utf8') <= 75));
  assert.equal(lines.map((line, i) => (i ? line.slice(1) : line)).join(''), text);
});
