import test from 'node:test';
import assert from 'node:assert/strict';
import { validateImportOrder } from '../domain/import-order.mjs';
import { reviewImport } from '../server/import-review.ts';
import { Service } from '../server/service.ts';
import { SQLiteRepo } from './sqlite-repo.ts';
import { restoreStatements } from '../server/campaign-snapshot.ts';
import type { ImportFinding } from '../domain/import-review-types.ts';
import type { Award, Member } from '../domain/vacations.ts';
import type { ElectionTimelineItem } from '../domain/election-timeline-types.ts';
import { numberTimelineCycles } from '../domain/timeline-numbering.ts';
import { decodePayload } from '../server/payload-codec.ts';

const owner = { id: 'chatgpt:test', role: 'superadmin' as const, teams: [] };
async function setup() {
  const repo = new SQLiteRepo(),
    service = new Service(repo, owner);
  await service.init();
  const cid = (await service.list()).campaigns.find((c) => c.team_id === 'C' && c.year === 2026).id;
  const data = await service.load(cid);
  const view = await service.view(cid);
  const dates = [view.result.cycles[12].date, view.result.cycles[0].date];
  const source = {
    format: 'vacaciones-roster-v1',
    team: 'C',
    year: 2026,
    copySelections: true,
    rows: [
      { code: 'AA', label: 'A', seniority: '', dates },
      { code: 'BB', label: 'B', seniority: '', dates },
    ],
    selectionOrder: [
      { round: 1, code: 'AA', date: dates[0] },
      { round: 1, code: 'BB', date: dates[0] },
      { round: 2, code: 'AA', date: dates[1] },
      { round: 2, code: 'BB', date: dates[1] },
    ],
  };
  const call = (action: string, extra: Record<string, unknown> = {}) =>
    service.mutate(cid, { action, version: data.campaign.version, source, ...extra });
  return { repo, service, cid, data, source, call };
}

test('no API import or preview may omit order, even when importing requests only', async () => {
  const { service, cid, data, source, call } = await setup();
  delete (source as { selectionOrder?: unknown }).selectionOrder;
  for (const copySelections of [true, false]) {
    source.copySelections = copySelections;
    await assert.rejects(() => call('import_roster'), /selectionOrder/);
    await assert.rejects(() => call('preview_import_roster'), /selectionOrder/);
  }
  assert.deepEqual(await service.load(cid), data);
});

test('member-major sequences, duplicate/missing steps and wrong round are rejected structurally', async () => {
  const { source } = await setup();
  const seq = source.selectionOrder;
  assert.equal(
    validateImportOrder({ ...source, selectionOrder: seq.map((s) => ({ ...s, code: s.code.toLowerCase() })) })[0].code,
    'AA',
  );
  assert.throws(
    () => validateImportOrder({ ...source, selectionOrder: [seq[0], seq[2], seq[1], seq[3]] }),
    /rondas.*orden/,
  );
  assert.throws(
    () => validateImportOrder({ ...source, selectionOrder: [seq[0], seq[0], seq[2], seq[3]] }),
    /duplicada/,
  );
  assert.throws(() => validateImportOrder({ ...source, selectionOrder: seq.slice(1) }), /completo/);
  assert.throws(
    () =>
      validateImportOrder({
        ...source,
        selectionOrder: [seq[0], seq[1], { ...seq[2], round: 1 }, seq[3]].sort((x, y) => x.round - y.round),
      }),
    /no puede elegir su ciclo 2 en la ronda 1/,
  );
  // Columns are chosen in row order, whatever their round.
  assert.throws(
    () =>
      validateImportOrder({
        ...source,
        selectionOrder: [seq[2], seq[1], seq[0], seq[3]].map((x) => ({ ...x, round: 2 })),
      }),
    /orden de columnas/,
  );
});

test('preview is read-only; explicit review and acknowledgement precede an atomic write', async () => {
  const { repo, service, cid, data, source, call } = await setup();
  // Valid explicit order, but BB chooses before AA: report, never silently sort.
  [source.selectionOrder[0], source.selectionOrder[1]] = [source.selectionOrder[1], source.selectionOrder[0]];
  const report = await call('preview_import_roster');
  assert.ok(report.findings.some((f: ImportFinding) => f.step === 1 && /Fuera de turno/.test(f.message)));
  assert.deepEqual(await service.load(cid), data, 'cancel by not committing: no rows or version changed');
  await assert.rejects(() => call('import_roster'), /reviewToken/);
  await assert.rejects(() => call('import_roster', { reviewToken: report.reviewToken }), /confirma explícitamente/);
  const imported = await call('import_roster', { reviewToken: report.reviewToken, acceptViolations: true });
  assert.deepEqual(
    imported.awards.map((a: Award) => a.selection_index),
    [1, 2, 3, 4],
  );
  assert.deepEqual(
    imported.awards.map((a: Award) => a.selection_round),
    [1, 1, 2, 2],
  );
  assert.deepEqual(
    imported.awards.map((a: Award) => ({
      round: a.selection_round,
      code: imported.members.find((m: Member) => m.id === a.member_id).code,
      date: a.cycle_date,
    })),
    source.selectionOrder,
  );
  assert.deepEqual(
    imported.election.timeline.map((e: ElectionTimelineItem) => ({
      round: e.round,
      code: imported.members.find((m: Member) => m.id === e.choices[0].member_id).code,
      date: e.choices[0].cycle_date,
    })),
    [...source.selectionOrder].reverse(),
    'history exposes the declared progression, newest first, without invented dates',
  );
  await repo.batch(restoreStatements(cid, { awards: imported.awards }));
  const numbers = numberTimelineCycles(imported.election.timeline);
  assert.deepEqual(
    imported.election.timeline.map((e: ElectionTimelineItem) => numbers.get(e.id)),
    [[2], [1], [2], [1]],
  );
  assert.deepEqual((await service.load(cid)).awards, imported.awards, 'snapshot rewrites preserve sequence metadata');
  const audit = await repo.all("SELECT after_json FROM audit WHERE campaign_id=? AND action='import_roster'", [cid]);
  assert.equal(JSON.parse(decodePayload(audit[0].after_json)).acceptedViolations, true);
});

test('confirmation cannot be reused for changed input or a newer campaign version', async () => {
  const { service, cid, data, source, call } = await setup();
  const report = await call('preview_import_roster');
  source.rows[0].label = 'Changed';
  await assert.rejects(
    () => call('import_roster', { reviewToken: report.reviewToken, acceptViolations: true }),
    /reviewToken/,
  );
  assert.deepEqual(await service.load(cid), data);
  await service.mutate(cid, {
    action: 'member',
    version: data.campaign.version,
    memberId: data.members[0].id,
    code: data.members[0].code,
    label: 'Concurrent edit',
    seniority: data.members[0].seniority,
  });
  await assert.rejects(
    () => call('import_roster', { reviewToken: report.reviewToken, acceptViolations: true }),
    /campaña cambió/,
  );
});

test('a clean ordered import needs review but no violation override; final invalidity cannot be overridden', async () => {
  const { source, data, call } = await setup();
  const configured = { ...source, config: { ...data.config, previousScores: { AA: 1, BB: 2 } } };
  const clean = await call('preview_import_roster', { source: configured });
  assert.deepEqual(clean.findings, []);
  await call('import_roster', { source: configured, reviewToken: clean.reviewToken });

  const second = await setup();
  const date = second.source.rows[0].dates[0];
  const crowded = {
    ...second.source,
    rows: Array.from({ length: 8 }, (_, i) => ({ code: 'P' + i, label: '', seniority: '', dates: [date] })),
    selectionOrder: Array.from({ length: 8 }, (_, i) => ({ round: 1, code: 'P' + i, date })),
  };
  const report = await second.call('preview_import_roster', { source: crowded });
  assert.ok(report.blockingIssues.length > 0);
  assert.ok(
    report.findings.some((f: ImportFinding) => f.step > 1 && !f.message.startsWith('Fuera de turno:')),
    'occupancy is checked at the selection that exceeds it, not only on the final total',
  );
  await assert.rejects(
    () => second.call('import_roster', { source: crowded, reviewToken: report.reviewToken, acceptViolations: true }),
    /Revisa la plantilla/,
  );
  assert.deepEqual(await second.service.load(second.cid), second.data);
});

test('a deferred turn lets a later round take two cycles, exactly as in a live election', async () => {
  const { source, call, service, cid } = await setup();
  const [first, second] = source.rows[0].dates;
  // AA lets round 1 pass and takes both its cycles in round 2.
  const deferred = {
    ...source,
    selectionOrder: [
      { round: 1, code: 'AA', deferred: true },
      { round: 1, code: 'BB', date: first },
      { round: 2, code: 'AA', date: first },
      { round: 2, code: 'AA', date: second },
      { round: 2, code: 'BB', date: second },
    ],
  };
  const report = await call('preview_import_roster', { source: deferred });
  assert.ok(!report.findings.some((f: ImportFinding) => /turno/i.test(f.message)), JSON.stringify(report.findings));
  assert.equal(report.selections, 4);
  const imported = await call('import_roster', {
    source: deferred,
    reviewToken: report.reviewToken,
    acceptViolations: report.findings.length > 0,
  });
  assert.deepEqual(
    imported.awards.map((a: Award) => [a.selection_index, a.selection_round]),
    [
      [1, 1],
      [2, 2],
      [3, 2],
      [4, 2],
    ],
  );
  // A double turn without its deferral is out of turn.
  const undeclared = {
    ...source,
    selectionOrder: [
      { round: 1, code: 'BB', date: first },
      { round: 2, code: 'AA', date: first },
      { round: 2, code: 'AA', date: second },
      { round: 2, code: 'BB', date: second },
    ],
  };
  const out = await call('preview_import_roster', {
    source: undeclared,
    version: (await service.load(cid)).campaign.version,
  });
  assert.ok(out.findings.some((f: ImportFinding) => /Fuera de turno/.test(f.message)));
});

test('partial previous scores keep the roster order without building tie groups', async () => {
  const { source, data } = await setup();
  const date = source.rows[0].dates[0];
  const codes = ['AA', 'BB', 'CC', 'DD'];
  const rows = codes.map((code, position) => ({ code, label: code, seniority: '', position, dates: [date] }));
  // AA and CC tie on score but are not contiguous in the declared order; DD has no score.
  const config = { ...data.config, previousScores: { AA: 100, BB: 110, CC: 100 } };
  const report = await reviewImport(
    { ...source, rows, selectionOrder: codes.map((code) => ({ round: 1, code, date })) } as never,
    rows as never,
    config,
    1,
  );
  assert.ok(
    !report.findings.some((f: ImportFinding) => /empatados|estado|Fuera de turno/i.test(f.message)),
    JSON.stringify(report.findings),
  );
});

test('even an empty, destructive import requires the preview token', async () => {
  const { source, call, service, cid, data } = await setup();
  const empty = {
    ...source,
    copySelections: false,
    rows: source.rows.map((r) => ({ ...r, dates: [] })),
    selectionOrder: [],
  };
  await assert.rejects(() => call('import_roster', { source: empty }), /reviewToken/);
  assert.deepEqual(await service.load(cid), data);
  const report = await call('preview_import_roster', { source: empty });
  await call('import_roster', { source: empty, reviewToken: report.reviewToken });
});

test('a declared joint turn takes all its participants’ cycles in one step', async () => {
  const { source, call } = await setup();
  const joint = { ...source, jointGroups: [['AA', 'BB']] };
  const report = await call('preview_import_roster', { source: joint });
  assert.ok(!report.findings.some((f: ImportFinding) => /turno/i.test(f.message)), JSON.stringify(report.findings));
  assert.throws(() => validateImportOrder({ ...source, jointGroups: [['AA', 'ZZ']] }), /jointGroups/);
});

test('a joint turn agreed for one round applies to that round only', async () => {
  const { source, call } = await setup();
  const joint = { ...source, jointTurns: [{ round: 2, codes: ['aa', 'BB'] }] };
  const report = await call('preview_import_roster', { source: joint });
  assert.ok(!report.findings.some((f: ImportFinding) => /turno/i.test(f.message)), JSON.stringify(report.findings));
  // Within a joint turn the participants' cycles form one step, in any order: alone, BB before AA is out of turn.
  const split = {
    ...joint,
    jointTurns: [{ round: 1, codes: ['AA', 'BB'] }],
    selectionOrder: [source.selectionOrder[1], source.selectionOrder[0], ...source.selectionOrder.slice(2)],
  };
  const reordered = await call('preview_import_roster', { source: split });
  assert.ok(!reordered.findings.some((f: ImportFinding) => /turno/i.test(f.message)));
  assert.throws(
    () =>
      validateImportOrder({
        ...source,
        jointTurns: [
          { round: 1, codes: ['AA', 'BB'] },
          { round: 1, codes: ['bb', 'AA'] },
        ],
      }),
    /jointTurns/,
  );
});

test('joint groups compare nicks case-insensitively', async () => {
  const { source } = await setup();
  assert.throws(() => validateImportOrder({ ...source, jointGroups: [['AA', 'aa']] }), /jointGroups/);
  assert.throws(
    () =>
      validateImportOrder({
        ...source,
        jointGroups: [
          ['AA', 'BB'],
          ['bb', 'AA'],
        ],
      }),
    /jointGroups/,
  );
  assert.doesNotThrow(() => validateImportOrder({ ...source, jointGroups: [['aa', 'BB']] }));
});
