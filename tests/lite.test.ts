import test from 'node:test';
import assert from 'node:assert/strict';
import { liteSummary, renderLiteHtml, renderLitePdf } from '../server/lite.ts';

const view = {
  campaign: { team_id: 'A', year: 2027 },
  members: [
    { id: 'm1', code: 'ÁNGEL' },
    { id: 'm2', code: 'B<2>' },
  ],
  awards: [
    { id: 'a1', member_id: 'm1', cycle_date: '2027-07-01' },
    { id: 'a2', member_id: 'm2', cycle_date: '2027-07-01' },
  ],
  result: {
    cycles: [
      { date: '2027-07-01', end: '2027-07-08', score: 80, period: 1, occupied: 2, max: 2 },
      { date: '2027-08-01', end: '2027-08-08', score: 75, period: 1, occupied: 0, max: 3 },
    ],
  },
  election: { state: { status: 'active' }, turn: { memberId: 'm2', round: 3 } },
} as never;

test('summary lists scores, free places, awards in choice order and the current turn', () => {
  const s = liteSummary(view, new Date('2027-01-01T10:00:00Z'));
  assert.equal(s.current, 'B<2>');
  assert.equal(s.round, 3);
  assert.deepEqual(
    s.cycles.map((c) => [c.date, c.score, c.freeText, c.codes]),
    [
      ['2027-07-01', 80, '0 libres', ['ÁNGEL', 'B<2>']],
      ['2027-08-01', 75, '3 libres', []],
    ],
  );
  assert.deepEqual(s.members[0], { code: 'ÁNGEL', dates: ['2027-07-01'], points: 80 });
});

test('lite page has no scripts and escapes codes', () => {
  const html = renderLiteHtml([{ team: 'A', year: 2027 }], liteSummary(view));
  assert.ok(!/<script/i.test(html));
  assert.ok(html.includes('B&lt;2&gt;'));
  assert.ok(html.includes('/lite/pdf?equipo=A&amp;year=2027'));
});

test('pdf is ASCII with a consistent xref table', () => {
  const pdf = renderLitePdf(liteSummary(view));
  assert.ok(pdf.startsWith('%PDF-1.4') && pdf.trimEnd().endsWith('%%EOF'));
  assert.ok(/^[\x00-\x7f]*$/.test(pdf));
  assert.ok(pdf.includes('(\\301NGEL)'));
  // The four web views, one page each.
  for (const view of ['Tabla', 'Mapa', 'Meses', 'Por CTA']) assert.ok(pdf.includes('(' + view + ')'));
  assert.equal(pdf.split('/Type /Page ').length - 1, 4);
  const start = Number(pdf.match(/startxref\n(\d+)/)![1]);
  assert.ok(pdf.slice(start).startsWith('xref'));
  for (const [, offset, id] of pdf
    .slice(start)
    .matchAll(/(\d{10}) 00000 n /g)
    .map((m, i) => [m, m[1], i + 1]))
    assert.ok(pdf.slice(Number(offset)).startsWith(`${id} 0 obj`));
});

const ruledView = (cycles: Record<string, unknown>) =>
  ({
    ...(view as object),
    result: {
      cycles: [
        { date: '2027-07-01', occupied: 3, max: 4 },
        { date: '2027-07-15', occupied: 3, max: 4 },
        { date: '2027-08-01', occupied: 1, max: 3 },
        { date: '2027-08-15', occupied: 1, max: 3 },
      ],
    },
    election: {
      state: { status: 'active' },
      turn: { memberId: 'm1', round: 1 },
      occupancyPolicyVersion: 'test',
      cycleAvailability: { cycles },
    },
  }) as never;

test('free places come from the engine, not max − occupied (EC3/EC4 blocked by extra quotas)', () => {
  const s = liteSummary(
    ruledView({
      // Fourth place exists locally (3/4) but the extra-quota limit blocks it globally.
      '2027-07-01': { status: 'exact', additional: 0, provenAdditional: 0, possibleAdditionalUpperBound: 0 },
      '2027-07-15': { status: 'indeterminate', additional: null, provenAdditional: 0, possibleAdditionalUpperBound: 1 },
      '2027-08-01': { status: 'invalid', additional: null, provenAdditional: 0, possibleAdditionalUpperBound: 0 },
      // Not computed yet.
    }),
  );
  assert.deepEqual(
    s.cycles.map((c) => [c.date, c.freeText, c.full]),
    [
      ['2027-07-01', '0 libres', true],
      ['2027-07-15', '? por confirmar', false],
      ['2027-08-01', 'en revisión', false],
      ['2027-08-15', '? por confirmar', false],
    ],
  );
  const pdf = renderLitePdf(s);
  assert.ok(!pdf.includes('(1 libre)') && pdf.includes('(? por confirmar)'));
});

test('the Tabla view marks engine-blocked places (EC3/EC4) even when the local maximum allows them', () => {
  const s = liteSummary({
    ...(view as object),
    members: [
      { id: 'm1', code: 'A01' },
      { id: 'm2', code: 'A02' },
      { id: 'm3', code: 'A03' },
    ],
    awards: ['m1', 'm2', 'm3'].map((member_id, i) => ({ id: 'a' + i, member_id, cycle_date: '2027-07-01' })),
    result: { cycles: [{ date: '2027-07-01', end: '2027-07-08', score: 80, period: 1, occupied: 3, max: 4 }] },
    election: {
      state: { status: 'active' },
      turn: null,
      occupancyPolicyVersion: 'test',
      cycleAvailability: {
        cycles: {
          '2027-07-01': {
            status: 'exact',
            additional: 0,
            provenAdditional: 0,
            possibleAdditionalUpperBound: 0,
            slots: [
              { status: 'occupied', reasons: [] },
              { status: 'occupied', reasons: [] },
              { status: 'occupied', reasons: [] },
              { status: 'blocked', reasons: [{ code: 'EC3', message: 'Extracupos agotados' }] },
            ],
          },
        },
      },
    },
  } as never);
  const [cycle] = s.cycles;
  assert.equal(cycle.freeText, '0 libres');
  assert.deepEqual(
    cycle.slots.map((x) => x.kind),
    ['occupied', 'occupied', 'occupied', 'blocked'],
  );
  // A blocked place is drawn as the web does: dark cell with ×.
  assert.ok(renderLitePdf(s).includes('(\\327)'));
});

test('occupants follow the election history, not the storage order of the award rows', () => {
  const s = liteSummary({
    ...(view as object),
    awards: [
      { id: 'a2', member_id: 'm2', cycle_date: '2027-07-01' },
      { id: 'a1', member_id: 'm1', cycle_date: '2027-07-01' },
    ],
    election: {
      state: { status: 'active' },
      turn: null,
      // Newest first, as the server sends it: m1 chose before m2.
      timeline: [
        { kind: 'choice', selectionCursor: 1, choices: [{ member_id: 'm2', cycle_date: '2027-07-01' }] },
        { kind: 'choice', selectionCursor: 0, choices: [{ member_id: 'm1', cycle_date: '2027-07-01' }] },
      ],
    },
  } as never);
  assert.deepEqual(s.cycles[0].codes, ['ÁNGEL', 'B<2>']);
  assert.deepEqual(
    s.cycles[0].slots.slice(0, 2).map((x) => x.code),
    ['ÁNGEL', 'B<2>'],
  );
});
