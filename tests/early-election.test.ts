import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig } from '../domain/defaults.ts';
import { cycleTable } from '../domain/vacations.ts';
import {
  choiceIssues,
  choose,
  currentTurn,
  type ElectionContext,
  type ElectionState,
  type Preference,
} from '../domain/election.ts';
import { earlyProof, earlyWindow } from '../domain/early-election.ts';
import { earlyListChoice } from '../server/election-commands.ts';
import { Service } from '../server/service.ts';
import { SQLiteRepo } from './sqlite-repo.ts';
import { dispatchNotifications } from '../server/notifications.ts';

// Real 2027 rules on a 16-person team: the order is M0, M1, ..., M15.
const members = Array.from({ length: 16 }, (_, i) => ({ id: 'M' + i, code: 'M' + i, seniority: '' }));
const base: ElectionContext = {
  year: 2027,
  team: 'C',
  config: defaultConfig(2027),
  members,
  requests: [],
  awards: [],
};
const dates = cycleTable(2027, 'C', base.config, [], []).map((c) => c.date);
const active = (patch: Partial<ElectionState> = {}): ElectionState => ({
  status: 'active',
  order: members.map((m) => m.id),
  cursor: 0,
  credits: {},
  source: 'Orden de prueba',
  allowDeferral: true,
  ...patch,
});
// Later members fill `cycle` until `free` seats remain for M0 and M1.
function seatsLeft(cycle: string, free: number) {
  const awards: ElectionContext['awards'] = [];
  for (let i = 15; i > 1; i--) {
    if (choiceIssues({ ...base, awards }, 'M' + i, [cycle]).length) break;
    awards.push({ id: 'fill-' + i, member_id: 'M' + i, cycle_date: cycle });
  }
  const dropped = awards.splice(awards.length - free, free);
  return Object.assign({ ...base, awards }, { dropped });
}

test('ventana: solo quien tiene exactamente un turno individual delante', () => {
  const state = active();
  assert.deepEqual(earlyWindow(base, state, 'M1'), {
    memberId: 'M1',
    predecessor: 'M0',
    predecessorNeeds: 1,
    cursor: 1,
    round: 1,
    owed: 1,
  });
  assert.equal(earlyWindow(base, state, 'M0'), null, 'quien tiene el turno elige en su turno');
  assert.equal(earlyWindow(base, state, 'M2'), null, 'dos turnos delante: fuera de la primera iteración');
  assert.equal(earlyWindow(base, active({ status: 'paused' }), 'M1'), null);
  // The last of a round may be the only one ahead of the first of the next.
  assert.equal(earlyWindow(base, active({ cursor: 15 }), 'M0')?.round, 2);
  // A joint turn ahead is not an individual predecessor.
  const joint = active({ jointGroups: [['M0', 'M1']] });
  assert.equal(earlyWindow(base, joint, 'M2'), null);
});

test('existencia de plaza y garantía frente al predecesor son cosas distintas', () => {
  const [one] = [dates[10]];
  const contested = seatsLeft(one, 1);
  assert.deepEqual(choiceIssues(contested, 'M0', [one]), [], 'el predecesor puede elegirlo');
  assert.deepEqual(choiceIssues(contested, 'M1', [one]), [], 'hay plaza para el adelantado');
  const proof = earlyProof(contested, active(), 'M1', dates, { only: [one] });
  assert.deepEqual(proof?.guaranteed, [], 'una sola plaza: el adelanto quitaría opciones al predecesor');
  const roomy = seatsLeft(one, 2);
  assert.deepEqual(earlyProof(roomy, active(), 'M1', dates, { only: [one] })?.guaranteed, [one]);
});

test('campaña vacía: todos los ciclos legales están garantizados, en orden de calendario', () => {
  const proof = earlyProof(base, active(), 'M1', dates)!;
  assert.equal(proof.indeterminate, false);
  assert.deepEqual(proof.guaranteed, dates);
  assert.equal(earlyProof(base, active(), 'M2', dates), null);
});

test('la elección anticipada cuenta como su turno: tras el predecesor pasa el siguiente', () => {
  const cycle = dates[5];
  const award = { id: 'early-1', member_id: 'M1', cycle_date: cycle };
  const state = active({
    earlyChoices: [{ memberId: 'M1', round: 1, cursor: 1, awardId: award.id, at: '2026-10-27T00:00:00Z' }],
  });
  const ctx = { ...base, awards: [award] };
  // The predecessor may still choose the same cycle: nothing was taken from them.
  const next = choose(ctx, state, 'M0', [cycle]);
  const after = currentTurn({ ...ctx, awards: [award, { id: 'x', ...next.choices[0] }] }, next.state);
  assert.equal(after.memberId, 'M2');
});

test('listas inmediatas: primera preferencia viable solo si está garantizada', () => {
  const contestedCycle = dates[10],
    free = dates[30];
  const ctx = seatsLeft(contestedCycle, 1);
  const list = (cycles: string[]): Preference => ({ member_id: 'M1', dates: cycles, automatic: true, active: true });
  // A is possible but unproved: B is never taken instead.
  assert.equal(earlyListChoice(ctx, active(), list([contestedCycle, free]), dates), null);
  // A already impossible for M1: the list moves on to B.
  const full = { ...ctx, awards: [...ctx.awards, ...ctx.dropped] };
  assert.notDeepEqual(choiceIssues(full, 'M1', [contestedCycle]), []);
  assert.equal(earlyListChoice(full, active(), list([contestedCycle, free]), dates)?.date, free);
  assert.equal(earlyListChoice(ctx, active(), list([free]), dates)?.date, free);
});

// Service level: commands, permissions, undo and the view on the seeded 2026 campaign.
const owner = { id: 'chatgpt:owner', role: 'superadmin' as const, teams: [] },
  visitor = { id: 'chatgpt:person', emailKey: 'chatgpt-email:person@example.test', role: 'viewer' as const, teams: [] };
async function election(order = 3) {
  const repo = new SQLiteRepo(),
    s = new Service(repo, owner);
  await s.init();
  const cid = (await s.list()).campaigns.find((c) => c.team_id === 'C').id;
  let d = await s.view(cid);
  const rows = ['AA', 'BB', 'CC'].slice(0, order).map((code) => ({ code, label: code, seniority: '' }));
  d = await s.mutate(cid, {
    action: 'import_roster',
    version: d.campaign.version,
    source: { format: 'vacaciones-roster-v1', team: 'C', year: 2026, copySelections: false, rows },
  });
  d = await s.mutate(cid, {
    action: 'config',
    version: d.campaign.version,
    config: { ...d.config, previousScores: { AA: 10, BB: 20, CC: 30 }, previousScoresSource: 'Puntuaciones de ensayo' },
  });
  const run = async (actor: Service, body: Record<string, unknown>) => {
    await actor.election().mutate(cid, { ...body, version: (await actor.load(cid)).campaign.version });
    return actor.view(cid);
  };
  await run(s, { action: 'start', rulesConfirmed: true, allowDeferral: true });
  const [a, b, c] = d.members;
  await run(s, { action: 'link_account', memberId: b.id, subject: 'person@example.test', accountVersion: 0 });
  return { repo, s, person: new Service(repo, visitor), cid, a, b, c, run, dates: d.result.cycles.map((x) => x.date) };
}

test('elegir por adelantado: comprobación en servidor, vista propia y turno saltado', async () => {
  const { s, person, run, cid, a, b, c, dates } = await election();
  const mine = (await person.view(cid)).election;
  assert.equal(mine.myMemberId, b.id);
  assert.ok(mine.early.guaranteed.includes(dates[3]));
  await assert.rejects(run(person, { action: 'early_choose', memberId: c.id, date: dates[3] }), /propias/);
  await assert.rejects(run(s, { action: 'early_choose', memberId: c.id, date: dates[3] }), /único turno/);
  let view = await run(person, { action: 'early_choose', memberId: b.id, date: dates[3] });
  assert.deepEqual(
    view.awards.filter((x) => x.member_id === b.id).map((x) => x.cycle_date),
    [dates[3]],
  );
  assert.equal(view.election.early.choices.length, 1);
  assert.equal(view.election.early.choices[0].cancellable, true);
  assert.equal(view.election.turn.memberId, a.id, 'el turno ordinario no cambia');
  assert.ok(view.election.timeline.some((item) => item.anticipated));
  // A may still take the same cycle; then B's slot is skipped.
  view = await run(s, { action: 'choose', memberId: a.id, dates: [dates[3]] });
  assert.equal(view.election.turn.memberId, c.id);
});

test('deshacer la anticipada: el titular antes de su turno, después solo el responsable', async () => {
  const { s, person, run, cid, a, b, dates } = await election();
  let view = await run(person, { action: 'early_choose', memberId: b.id, date: dates[4] });
  const awardId = view.election.early.choices[0].awardId;
  view = await run(person, { action: 'early_cancel', awardId });
  assert.equal(view.awards.length, 0);
  assert.equal(view.requests.length, 0);
  assert.equal((await person.view(cid)).election.early.choices.length, 0);
  // Again, and this time A chooses: B's slot has passed.
  view = await run(person, { action: 'early_choose', memberId: b.id, date: dates[4] });
  const second = view.election.early.choices[0].awardId;
  await run(s, { action: 'choose', memberId: a.id, dates: [dates[0]] });
  await assert.rejects(run(person, { action: 'early_cancel', awardId: second }), /responsable/);
  view = await run(s, { action: 'early_cancel', awardId: second });
  assert.ok(!view.awards.some((x) => x.member_id === b.id));
  await assert.rejects(run(s, { action: 'early_cancel', awardId: second }), /ya no existe/);
});

test('undo y redo de una elección anticipada restauran adjudicación y estado', async () => {
  const { s, person, run, cid, b, dates } = await election();
  await run(person, { action: 'early_choose', memberId: b.id, date: dates[2] });
  let view = await s.view(cid);
  view = await run(s, { action: 'election_undo', historyId: view.election.undo });
  assert.equal(view.awards.length, 0);
  assert.equal(view.election.state.earlyChoices?.length ?? 0, 0);
  view = await run(s, { action: 'election_redo', historyId: view.election.redo });
  assert.equal(view.awards.length, 1);
  assert.equal(view.election.state.earlyChoices.length, 1);
});

test('lista inmediata del siguiente: se adjudica por adelantado con advance; en espera, no', async () => {
  const { s, run, cid, b, dates } = await election();
  await run(s, { action: 'preferences', memberId: b.id, dates: [dates[6]], mode: 'wait', waitMinutes: 30 });
  let view = await s.view(cid);
  assert.equal(view.election.pendingAutomatic, false, 'una lista en espera aguarda al turno ordinario');
  await run(s, { action: 'preferences', memberId: b.id, dates: [dates[6]] });
  view = await s.view(cid);
  assert.equal(view.election.pendingAutomatic, true);
  view = await run(s, { action: 'advance' });
  assert.deepEqual(
    view.awards.map((x) => x.cycle_date),
    [dates[6]],
  );
  assert.equal(view.election.state.earlyChoices.length, 1);
  assert.equal(view.election.preferences.find((p) => p.member_id === b.id).active, false);
  const automatic = view.election.timeline.find((item) => item.anticipated);
  assert.ok(automatic, 'la línea de tiempo marca la adjudicación como anticipada');
});

const push = { VAPID_PUBLIC_KEY: 'k', VAPID_PRIVATE_JWK: 'k', VAPID_SUBJECT: 'mailto:admin@example.test' };
const earlyNotices = async (repo: SQLiteRepo) =>
  repo.all("SELECT id,push_status FROM turn_notifications WHERE id LIKE 'early:%'");
test('aviso de oportunidad: uno por ronda, y obsoleto si la ventana se cierra antes de enviarse', async () => {
  const { repo, s, run, a, b, dates } = await election();
  const noSend = async () => ({ ok: false, status: 503 }) as never;
  await dispatchNotifications(repo, push, undefined, noSend);
  await dispatchNotifications(repo, push, undefined, noSend);
  let rows = await earlyNotices(repo);
  assert.equal(rows.length, 1);
  assert.match(rows[0].id, new RegExp(':' + b.id + ':1$'));
  // A chooses: B's own turn arrives, so the pending opportunity is no longer true.
  await run(s, { action: 'choose', memberId: a.id, dates: [dates[0]] });
  await dispatchNotifications(repo, push, undefined, noSend);
  rows = await earlyNotices(repo);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].push_status, 'obsolete');
});
test('sin aviso de oportunidad cuando la lista inmediata va a adjudicar por sí sola', async () => {
  const { repo, s, run, b, dates } = await election();
  await run(s, { action: 'preferences', memberId: b.id, dates: [dates[6]] });
  await dispatchNotifications(repo, push, undefined, async () => ({ ok: false, status: 503 }) as never);
  assert.equal((await earlyNotices(repo)).length, 0);
});

test('elección anticipada manual consume una lista no persistente', async () => {
  const { s, person, run, cid, b, dates } = await election();
  await run(s, { action: 'preferences', memberId: b.id, dates: [dates[6]], mode: 'wait', waitMinutes: 30 });
  const view = await run(person, { action: 'early_choose', memberId: b.id, date: dates[4] });
  assert.equal(view.election.preferences.find((p) => p.member_id === b.id).active, false);
});

test('cancelar y repetir una anticipada no duplica su historial', async () => {
  const { s, person, run, b, dates } = await election();
  let view = await run(person, { action: 'early_choose', memberId: b.id, date: dates[4] });
  await run(person, { action: 'early_cancel', awardId: view.election.early.choices[0].awardId });
  view = await run(person, { action: 'early_choose', memberId: b.id, date: dates[4] });
  assert.equal(view.election.timeline.filter((e) => e.choices.some((c) => c.member_id === b.id)).length, 1);
});

test('anulación administrativa tras completar reabre el derecho y detiene automatismos', async () => {
  const { s, person, run, b, dates } = await election();
  let view = await run(person, { action: 'early_choose', memberId: b.id, date: dates[4] });
  const awardId = view.election.early.choices[0].awardId;
  // Complete every ordinary turn without draining lists.
  for (let i = 0; i < 30 && view.election.state.status !== 'complete'; i++) {
    const turn = view.election.turn;
    const owned = new Set(view.awards.filter((w) => w.member_id === turn.memberId).map((w) => w.cycle_date));
    const available = view.election.available.filter((d) => !owned.has(d));
    view = await run(s, { action: 'choose', memberId: turn.memberId, dates: available.slice(0, turn.needed) });
  }
  assert.equal(view.election.state.status, 'complete');
  view = await run(s, { action: 'early_cancel', awardId });
  assert.equal(view.election.state.status, 'active');
  assert.equal(view.election.state.automaticPaused, true);
  assert.equal(view.election.turn.memberId, b.id);
});

test('anticipada de la próxima ronda conserva ronda lógica en historial y aviso', async () => {
  const { s, run, cid, a, b, c, dates } = await election();
  await run(s, { action: 'choose', memberId: a.id, dates: [dates[0]] });
  await run(s, { action: 'choose', memberId: b.id, dates: [dates[1]] });
  const view = await run(s, { action: 'early_choose', memberId: a.id, date: dates[4] });
  const entry = view.election.timeline.find((e) => e.anticipated);
  assert.equal(entry.round, 2);
  assert.equal(entry.selectionCursor, 3);
});

test('aviso automático anticipado usa la ronda adjudicada', async () => {
  const { repo, s, run, cid, a, b, dates } = await election();
  await run(s, { action: 'link_account', memberId: a.id, subject: 'first@example.test', accountVersion: 0 });
  await run(s, { action: 'choose', memberId: a.id, dates: [dates[0]] });
  await run(s, { action: 'choose', memberId: b.id, dates: [dates[1]] });
  await run(s, { action: 'preferences', memberId: a.id, dates: [dates[4]] });
  await run(s, { action: 'advance' });
  await dispatchNotifications(repo, push, cid, async () => ({ ok: false, status: 503 }) as never);
  const notices = await repo.all("SELECT round FROM turn_notifications WHERE member_id=? AND id LIKE 'auto:%'", [a.id]);
  assert.deepEqual(
    notices.map((n) => n.round),
    [2],
  );
});

test('anular antes del turno conserva el reloj del predecesor y no pausa sus listas', async () => {
  const { person, run, b, dates } = await election();
  let view = await run(person, { action: 'early_choose', memberId: b.id, date: dates[4] });
  const clock = view.election.state.turnSince;
  view = await run(person, { action: 'early_cancel', awardId: view.election.early.choices[0].awardId });
  assert.deepEqual(view.election.state.turnSince, clock);
  assert.notEqual(view.election.state.automaticPaused, true);
});
