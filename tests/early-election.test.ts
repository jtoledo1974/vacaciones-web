import { test } from 'node:test';
import { importRoster } from './import-helper.ts';
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
import { discretion } from '../server/early-discretion.ts';
import { Service } from '../server/service.ts';
import { SQLiteRepo } from './sqlite-repo.ts';
import { dispatchNotifications, notificationSettings, flushTurnNotifications } from '../server/notifications.ts';

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
  d = await importRoster(s, cid, {
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
  // Another controller's own account: early choices are made only by their owner.
  const account = async (member: { id: string }, name: string) => {
    await run(s, { action: 'link_account', memberId: member.id, subject: name + '@example.test', accountVersion: 0 });
    return new Service(repo, {
      id: 'chatgpt:' + name,
      emailKey: 'chatgpt-email:' + name + '@example.test',
      role: 'viewer' as const,
      teams: [],
    });
  };
  return {
    repo,
    s,
    person: new Service(repo, visitor),
    cid,
    a,
    b,
    c,
    run,
    account,
    dates: d.result.cycles.map((x) => x.date),
  };
}

test('elegir por adelantado: comprobación en servidor, vista propia y turno saltado', async () => {
  const { s, person, run, cid, a, b, c, dates } = await election();
  const mine = (await person.view(cid)).election;
  assert.equal(mine.myMemberId, b.id);
  assert.ok(mine.early.guaranteed.includes(dates[3]));
  await assert.rejects(run(person, { action: 'early_choose', memberId: c.id, date: dates[3] }), /propias/);
  await assert.rejects(run(s, { action: 'early_choose', memberId: b.id, date: dates[3] }), /propio controlador/);
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

test('la anticipada manual confirmada se reconstruye en su posición ordinaria, sin reabrir al predecesor', async () => {
  const { s, person, run, cid, repo, a, b, c, dates } = await election();
  await run(person, { action: 'early_choose', memberId: b.id, date: dates[4] });
  const target = (await repo.all("SELECT id FROM audit WHERE action='early_choose'"))[0].id;
  await assert.rejects(run(s, { action: 'reconstruction_start', historyId: target }), /todavía no está disponible/);
  assert.ok(!(await s.view(cid)).election.reconstruction.candidates.some((e) => e.id === target));
  await run(s, { action: 'choose', memberId: a.id, dates: [dates[0]] });
  const original = await run(s, { action: 'choose', memberId: c.id, dates: [dates[2]] });
  let view = await run(s, { action: 'reconstruction_start', historyId: target });
  assert.equal(view.election.reconstruction.current.memberId, b.id);
  assert.deepEqual(
    view.awards,
    original.awards.filter((award) => award.member_id === a.id),
  );
  view = await run(s, { action: 'reconstruction_step', kind: 'choose', mode: 'manual', dates: [dates[5]] });
  assert.equal(view.election.reconstruction.current.memberId, c.id);
  view = await run(s, { action: 'reconstruction_step', kind: 'choose', mode: 'original' });
  view = await run(s, { action: 'reconstruction_finish' });
  assert.equal(view.awards.length, 3);
  assert.equal(view.awards.find((award) => award.member_id === b.id)?.cycle_date, dates[5]);
  assert.ok(!view.election.timeline.find((entry) => entry.memberIds.includes(b.id))?.anticipated);
});

test('normalizar una anticipada firme no revela ni obliga a reconstruir otra que sigue siendo privada', async () => {
  const { s, person, run, cid, a, b, dates, account } = await election();
  const first = await account(a, 'first');
  await run(person, { action: 'early_choose', memberId: b.id, date: dates[4] });
  await run(s, { action: 'choose', memberId: a.id, dates: [dates[0]] });
  const offer = (await first.view(cid)).election.early!.guaranteed;
  assert.ok(offer.length);
  await run(first, { action: 'early_choose', memberId: a.id, date: offer[0] });
  const secret = (await first.view(cid)).election.early!.choices[0].awardId;
  const target = (await s.view(cid)).election.reconstruction.candidates.find((entry) =>
    entry.memberIds.includes(b.id),
  )!;
  let view = await run(s, { action: 'reconstruction_start', historyId: target.id });
  assert.equal(view.election.reconstruction.current.memberId, b.id);
  assert.ok(!JSON.stringify(view).includes(secret));
  view = await run(s, { action: 'reconstruction_step', kind: 'choose', mode: 'original' });
  assert.equal(
    view.election.reconstruction.status,
    'review',
    'la elección todavía privada no alarga la reconstrucción',
  );
  assert.ok(!JSON.stringify(view).includes(secret));
  await run(s, { action: 'reconstruction_cancel' });
  assert.ok((await first.view(cid)).election.early!.choices.some((choice) => choice.awardId === secret));
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
  const { s, person, run, cid, repo, a, b, dates } = await election();
  const hiddenUndo = (await s.view(cid)).election.undo;
  await run(person, { action: 'early_choose', memberId: b.id, date: dates[2] });
  const early = (await repo.all("SELECT id FROM audit WHERE action='early_choose'"))[0].id;
  // Discreet: the manager's undo does not reach it, nor may it be named.
  assert.equal((await s.view(cid)).election.undo, hiddenUndo);
  await assert.rejects(run(s, { action: 'election_undo', historyId: early }), /ya no está disponible/);
  // Once revealed, undoing the predecessor hides it again; redo brings both back.
  let view = await run(s, { action: 'choose', memberId: a.id, dates: [dates[0]] });
  assert.equal(view.awards.length, 2);
  view = await run(s, { action: 'election_undo', historyId: view.election.undo });
  assert.equal(view.awards.length, 0);
  assert.equal(view.election.state!.earlyChoices?.length ?? 0, 0);
  assert.equal((await person.view(cid)).election.early?.choices.length, 1, 'B la conserva');
  view = await run(s, { action: 'election_redo', historyId: view.election.redo });
  assert.equal(view.awards.length, 2);
  assert.equal(view.election.state!.earlyChoices!.length, 1);
});

test('lista inmediata del siguiente: se adjudica por adelantado con advance; en espera, no', async () => {
  const { s, person, run, cid, b, dates } = await election();
  await run(s, { action: 'preferences', memberId: b.id, dates: [dates[6]], mode: 'wait', waitMinutes: 30 });
  let view = await s.view(cid);
  assert.equal(view.election.pendingAutomatic, false, 'una lista en espera aguarda al turno ordinario');
  await run(s, { action: 'preferences', memberId: b.id, dates: [dates[6]] });
  view = await s.view(cid);
  assert.equal(view.election.pendingAutomatic, true);
  view = await run(s, { action: 'advance' });
  assert.deepEqual(view.awards, [], 'discreta también para la administración');
  view = await person.view(cid);
  assert.deepEqual(
    view.awards.map((x) => x.cycle_date),
    [dates[6]],
  );
  assert.equal(view.election.early?.choices.length, 1);
  assert.equal(view.election.preferences.find((p) => p.member_id === b.id)?.active, false);
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

test('anulación administrativa tras completar reabre el derecho sin detener automatismos', async () => {
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
  assert.notEqual(view.election.state.automaticPaused, true);
  assert.equal(view.election.turn.memberId, b.id);
});

test('anticipada de la próxima ronda conserva ronda lógica en historial y aviso', async () => {
  const { s, run, account, a, b, dates } = await election();
  const first = await account(a, 'first');
  await run(s, { action: 'choose', memberId: a.id, dates: [dates[0]] });
  await run(s, { action: 'choose', memberId: b.id, dates: [dates[1]] });
  const view = await run(first, { action: 'early_choose', memberId: a.id, date: dates[4] });
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

test('anular tras su turno con la elección en marcha: el derecho vuelve, su lista pasa a manual y se le avisa', async () => {
  const { repo, s, person, run, a, b, c, dates } = await election();
  await run(s, {
    action: 'preferences',
    memberId: b.id,
    dates: [dates[6], dates[7]],
    persistent: true,
    mode: 'wait',
    waitMinutes: 30,
  });
  await run(s, { action: 'preferences', memberId: c.id, dates: [dates[8]], mode: 'wait', waitMinutes: 30 });
  let view = await run(person, { action: 'early_choose', memberId: b.id, date: dates[4] });
  const awardId = view.election.early.choices[0].awardId;
  view = await run(s, { action: 'choose', memberId: a.id, dates: [dates[0]] });
  assert.equal(view.election.turn.memberId, c.id, 'el turno de B ya se saltó');
  view = await run(s, { action: 'early_cancel', awardId });
  assert.ok(!view.awards.some((w) => w.member_id === b.id));
  assert.notEqual(view.election.state.automaticPaused, true, 'las listas de los demás siguen activas');
  const prefs = view.election.preferences;
  assert.equal(prefs.find((p) => p.member_id === b.id).mode, 'manual');
  assert.equal(prefs.find((p) => p.member_id === c.id).mode, 'wait');
  const notices = await repo.all("SELECT round FROM turn_notifications WHERE member_id=? AND id LIKE 'manual:%'", [
    b.id,
  ]);
  assert.deepEqual(
    notices.map((n) => n.round),
    [1],
  );
  // The recovered right is not lost: B gets a turn that covers it.
  const seen: string[] = [];
  for (let i = 0; i < 30 && view.election.state.status !== 'complete'; i++) {
    const turn = view.election.turn;
    seen.push(turn.memberId);
    const owned = new Set(view.awards.filter((w) => w.member_id === turn.memberId).map((w) => w.cycle_date));
    const available = view.election.available.filter((d) => !owned.has(d));
    view = await run(s, { action: 'choose', memberId: turn.memberId, dates: available.slice(0, turn.needed) });
  }
  assert.ok(seen.includes(b.id));
  const perMember = (id: string) => view.awards.filter((w) => w.member_id === id).length;
  assert.equal(perMember(b.id), perMember(a.id));
});

async function cancelledPersistentList() {
  const f = await election();
  await f.run(f.s, {
    action: 'preferences',
    memberId: f.b.id,
    dates: [f.dates[6]],
    persistent: true,
    mode: 'wait',
    waitMinutes: 30,
  });
  let view = await f.run(f.person, { action: 'early_choose', memberId: f.b.id, date: f.dates[4] });
  const awardId = view.election.early.choices[0].awardId;
  await f.run(f.s, { action: 'choose', memberId: f.a.id, dates: [f.dates[0]] });
  view = await f.run(f.s, { action: 'early_cancel', awardId });
  return { ...f, view, awardId };
}

test('deshacer/rehacer la anulación restaura solo el cambio automático de modo', async () => {
  const f = await cancelledPersistentList();
  let view = await f.run(f.s, { action: 'election_undo', historyId: f.view.election.undo });
  let pref = view.election.preferences.find((p) => p.member_id === f.b.id);
  assert.equal(pref.mode, 'wait');
  assert.equal(pref.waitMinutes, 30);
  view = await f.run(f.s, { action: 'election_redo', historyId: view.election.redo });
  pref = view.election.preferences.find((p) => p.member_id === f.b.id);
  assert.equal(pref.mode, 'manual');
  assert.equal(pref.waitMinutes, 0);
});

test('la anulación registra en su auditoría qué lista pasó a manual', async () => {
  const f = await cancelledPersistentList();
  const audits = await f.repo.all("SELECT after_json FROM audit WHERE action='early_cancel' ORDER BY rowid");
  assert.equal(JSON.parse(audits.at(-1).after_json).manualized, f.b.id);
  // Withdrawn before its slot: no list changes, so undo leaves every mode alone.
  const g = await election();
  await g.run(g.s, { action: 'preferences', memberId: g.b.id, dates: [g.dates[6]], mode: 'wait', waitMinutes: 30 });
  let view = await g.run(g.person, { action: 'early_choose', memberId: g.b.id, date: g.dates[4] });
  view = await g.run(g.person, { action: 'early_cancel', awardId: view.election.early.choices[0].awardId });
  const own = await g.repo.all(
    "SELECT id,after_json FROM audit WHERE action IN ('early_choose','early_cancel') ORDER BY rowid",
  );
  assert.equal(JSON.parse(own.at(-1).after_json).manualized, null);
  assert.equal(JSON.parse(own.at(-1).after_json).discreet, true);
  // Withdrawn before its slot, it never comes to light: not even the manager's undo shows it.
  view = await g.s.view(g.cid);
  assert.ok(!own.some((row) => row.id === view.election.undo));
  assert.equal(view.election.preferences.find((p) => p.member_id === g.b.id)?.mode, 'wait');
});

test('deshacer la anulación conserva una edición posterior de la lista', async () => {
  const f = await cancelledPersistentList();
  await f.run(f.person, {
    action: 'preferences',
    memberId: f.b.id,
    dates: [f.dates[8]],
    persistent: true,
    mode: 'wait',
    waitMinutes: 50,
  });
  const admin = new Service(f.repo, { id: 'chatgpt:team-manager', role: 'team_admin', teams: ['C'] });
  let view = await admin.view(f.cid);
  view = await f.run(admin, { action: 'election_undo', historyId: view.election.undo });
  const pref = (await f.person.view(f.cid)).election.preferences.find((p) => p.member_id === f.b.id);
  assert.deepEqual(pref.dates, [f.dates[8]]);
  assert.equal(pref.waitMinutes, 50);
});

test('aviso manual: deshacer lo invalida y rehacer lo recupera sin duplicarlo', async () => {
  const f = await cancelledPersistentList();
  let view = await f.run(f.s, { action: 'election_undo', historyId: f.view.election.undo });
  await dispatchNotifications(f.repo, push, f.cid, async () => ({ status: 503 }) as never);
  let rows = await f.repo.all("SELECT push_status FROM turn_notifications WHERE id LIKE 'manual:%'");
  assert.deepEqual(
    rows.map((n) => n.push_status),
    ['obsolete'],
  );
  view = await f.run(f.s, { action: 'election_redo', historyId: view.election.redo });
  if (view.election.state.automaticPaused) await f.run(f.s, { action: 'resume_automatic' });
  await dispatchNotifications(f.repo, push, f.cid, async () => ({ status: 503 }) as never);
  rows = await f.repo.all("SELECT push_status FROM turn_notifications WHERE id LIKE 'manual:%'");
  assert.deepEqual(
    rows.map((n) => n.push_status),
    ['pending'],
  );
});

test('reactivar preferencias antes del envío invalida el aviso manual', async () => {
  const f = await cancelledPersistentList();
  await f.run(f.person, {
    action: 'preferences',
    memberId: f.b.id,
    dates: [f.dates[6]],
    persistent: true,
    mode: 'wait',
    waitMinutes: 30,
  });
  await dispatchNotifications(f.repo, push, f.cid, async () => ({ status: 503 }) as never);
  const rows = await f.repo.all("SELECT push_status FROM turn_notifications WHERE id LIKE 'manual:%'");
  assert.deepEqual(
    rows.map((n) => n.push_status),
    ['obsolete'],
  );
});

test('anular en simulación no encola avisos para cuentas vinculadas', async () => {
  const f = await cancelledPersistentList();
  await f.run(f.s, { action: 'election_undo', historyId: f.view.election.undo });
  await f.repo.batch([
    { sql: "UPDATE campaigns SET scope_key='simulation-test' WHERE id=?", args: [f.cid] },
    { sql: 'DELETE FROM turn_notifications WHERE campaign_id=?', args: [f.cid] },
  ]);
  await f.run(f.s, { action: 'early_cancel', awardId: f.awardId });
  assert.equal((await f.repo.all('SELECT id FROM turn_notifications WHERE campaign_id=?', [f.cid])).length, 0);
});

test('el responsable puede deshacer/rehacer el cambio de modo sin editar preferencias privadas', async () => {
  const f = await cancelledPersistentList();
  const admin = new Service(f.repo, { id: 'chatgpt:team-manager', role: 'team_admin', teams: ['C'] });
  let view = await admin.view(f.cid);
  view = await f.run(admin, { action: 'election_undo', historyId: view.election.undo });
  assert.equal((await f.person.view(f.cid)).election.preferences.find((p) => p.member_id === f.b.id).mode, 'wait');
  await f.run(admin, { action: 'election_redo', historyId: view.election.redo });
  assert.equal((await f.person.view(f.cid)).election.preferences.find((p) => p.member_id === f.b.id).mode, 'manual');
});

test('avisos antiguos de simulación no se muestran ni se envían', async () => {
  const f = await cancelledPersistentList();
  await f.repo.batch([{ sql: "UPDATE campaigns SET scope_key='simulation-test' WHERE id=?", args: [f.cid] }]);
  const settings = await notificationSettings(f.repo, visitor, push);
  assert.equal(settings.notifications.length, 0);
  const notice = (await f.repo.all("SELECT owner_key FROM turn_notifications WHERE id LIKE 'manual:%'"))[0];
  await f.repo.batch([
    {
      sql: 'INSERT INTO push_subscriptions(endpoint,owner_key,p256dh,auth,created_at) VALUES(?,?,?,?,?)',
      args: ['https://local-test.invalid/push', notice.owner_key, 'dummy', 'dummy', new Date().toISOString()],
    },
  ]);
  let sends = 0;
  await flushTurnNotifications(f.repo, push, f.cid, { remaining: 10 }, async () => {
    sends++;
    return { status: 200 } as never;
  });
  assert.equal(sends, 0);
});

test('la anticipada pendiente no se ve fuera de la administración y luego ocupa su turno', async () => {
  const { s, person, run, cid, a, b, dates } = await election();
  await run(s, { action: 'link_account', memberId: a.id, subject: 'first@example.test', accountVersion: 0 });
  const first = new Service(s['repo'], {
    id: 'chatgpt:first',
    emailKey: 'chatgpt-email:first@example.test',
    role: 'viewer' as const,
    teams: [],
  });
  const before = (await first.view(cid)).election;
  await run(person, { action: 'early_choose', memberId: b.id, date: dates[3] });
  let seen = await first.view(cid);
  assert.equal(seen.election.myMemberId, a.id);
  assert.deepEqual(seen.awards, [], 'A no ve la adjudicación de B');
  assert.deepEqual(seen.election.timeline, []);
  assert.deepEqual(seen.election.available, before.available, 'A elige entre lo mismo');
  assert.ok(
    (await person.view(cid)).election.timeline.some((item) => item.anticipated),
    'B sí la ve',
  );
  const admin = await s.view(cid);
  assert.deepEqual(admin.awards, [], 'ni la administración la ve');
  assert.deepEqual(admin.election.timeline, []);
  await run(first, { action: 'choose', memberId: a.id, dates: [dates[0]] });
  seen = await first.view(cid);
  assert.deepEqual(seen.awards.map((x) => x.member_id).sort(), [a.id, b.id].sort());
  assert.ok(!seen.election.timeline.some((item) => item.anticipated), 'sin marca para los demás');
  // Newest first, in turn order: B's slot follows A's although B chose earlier.
  const order = (timeline: { memberIds: string[] }[]) => timeline.map((item) => item.memberIds[0]);
  assert.deepEqual(order(seen.election.timeline), [b.id, a.id]);
  assert.deepEqual(order((await s.view(cid)).election.timeline), [b.id, a.id]);
});

test('la disponibilidad, las opciones y el impacto tampoco revelan la anticipada pendiente', async () => {
  // The global availability needs an occupancy engine: the 2027 rules.
  const repo = new SQLiteRepo(),
    s = new Service(repo, owner);
  await s.init();
  await s.createCampaigns(2027, null, null);
  const cid = (await s.list()).campaigns.find((c) => c.year === 2027 && c.team_id === 'A').id;
  let d = await s.view(cid);
  const codes = Array.from({ length: 20 }, (_, i) => 'P' + String(i + 1).padStart(2, '0'));
  d = await importRoster(s, cid, {
    action: 'import_roster',
    version: d.campaign.version,
    source: {
      format: 'vacaciones-roster-v1',
      team: 'A',
      year: 2027,
      copySelections: false,
      rows: codes.map((code) => ({ code, label: code, seniority: '' })),
    },
  });
  d = await s.mutate(cid, {
    action: 'config',
    version: d.campaign.version,
    config: {
      ...d.config,
      previousScores: Object.fromEntries(codes.map((code, i) => [code, 10 + i])),
      previousScoresSource: 'Puntuaciones de ensayo',
    },
  });
  const run = async (actor: Service, body: Record<string, unknown>) => {
    await actor.election().mutate(cid, { ...body, version: (await actor.load(cid)).campaign.version });
    return actor.view(cid);
  };
  const started = await run(s, { action: 'start', rulesConfirmed: true, allowDeferral: true });
  const [a, b] = started.election.state!.order.map((id: string) => d.members.find((m) => m.id === id)!);
  await run(s, { action: 'link_account', memberId: a.id, subject: 'first@example.test', accountVersion: 0 });
  await run(s, { action: 'link_account', memberId: b.id, subject: 'person@example.test', accountVersion: 0 });
  const person = new Service(repo, visitor),
    first = new Service(repo, {
      id: 'chatgpt:first',
      emailKey: 'chatgpt-email:first@example.test',
      role: 'viewer' as const,
      teams: [],
    });
  const date = (await person.view(cid)).election.early?.guaranteed[0];
  assert.ok(date, 'B tiene algún ciclo asegurado');
  const before = await first.election().availability(cid);
  const options = await first.election().options(cid, []);
  await run(person, { action: 'early_choose', memberId: b.id, date: date! });
  const slots = (view: typeof before) =>
    Object.values(view.cycles).flatMap((cycle) => cycle.slots.map((slot) => slot.memberId).filter(Boolean));
  const after = await first.election().availability(cid);
  assert.ok(!slots(after).includes(b.id), 'A no ve a B ocupando una plaza');
  assert.deepEqual(after.cycles, before.cycles);
  assert.deepEqual({ ...(await first.election().options(cid, [])), version: options.version }, options);
  const version = (await first.load(cid)).campaign.version;
  const pick = options.available.find((x: string) => x !== date) ?? options.available[0];
  const impact = await first.election().previewImpact(cid, [{ member_id: a.id, cycle_date: pick }], version);
  assert.ok(!JSON.stringify(impact).includes(b.id), 'el impacto no menciona a B');
  assert.ok(!slots(await s.election().availability(cid)).includes(b.id), 'ni la administración lo ve');
});

test('dos anticipadas seguidas se muestran en orden de turno tras el predecesor', async () => {
  const { s, person, run, account, cid, a, b, c, dates } = await election();
  const third = await account(c, 'third');
  await run(person, { action: 'early_choose', memberId: b.id, date: dates[3] });
  await run(third, { action: 'early_choose', memberId: c.id, date: dates[4] });
  await run(s, { action: 'choose', memberId: a.id, dates: [dates[0]] });
  const order = (timeline: { memberIds: string[] }[]) => timeline.map((item) => item.memberIds[0]);
  assert.deepEqual(order((await s.view(cid)).election.timeline), [c.id, b.id, a.id]);
  assert.deepEqual(order((await person.view(cid)).election.timeline), [c.id, b.id, a.id]);
});

test('un deshacer que anula una anticipada discreta se lo avisa a su titular, sin que lo vea nadie', async () => {
  const { s, person, run, cid, repo, b, dates } = await election();
  await run(person, { action: 'early_choose', memberId: b.id, date: dates[2] });
  const early = (await repo.all("SELECT id FROM audit WHERE action='early_choose'"))[0].id;
  // Nor in the global log of a superadministrator.
  assert.ok(!(await s.admin()).audit.some((row: { id: string }) => row.id === early));
  // The manager's newest visible decision predates it: undoing it takes it away.
  await run(s, { action: 'election_undo', historyId: (await s.view(cid)).election.undo });
  assert.equal((await person.view(cid)).election.early?.choices.length ?? 0, 0);
  const notices = await repo.all("SELECT member_id FROM turn_notifications WHERE id LIKE 'withdrawn:%'");
  assert.deepEqual(
    notices.map((n) => n.member_id),
    [b.id],
  );
});

test('las copias del registro global no conservan la anticipada discreta', async () => {
  const { s, person, run, repo, b, dates } = await election();
  await run(person, { action: 'early_choose', memberId: b.id, date: dates[2] });
  const awardId = (await repo.all('SELECT id FROM awards'))[0].id;
  // A later decision copies the campaign, the hidden award included, into its snapshot.
  await run(s, { action: 'preferences', memberId: b.id, dates: [dates[6]] });
  const stored = await repo.all("SELECT before_json FROM audit WHERE action='preferences'");
  assert.ok(
    stored.some((row) => row.before_json.includes(awardId)),
    'la copia guardada la contiene',
  );
  const log = JSON.stringify((await s.admin()).audit);
  assert.ok(!log.includes(awardId), 'el registro global no la muestra');
});

test('una reconstrucción no revela la anticipada discreta de su origen', async () => {
  const { s, person, run, account, cid, repo, a, b, c, dates } = await election();
  for (const [member, date] of [
    [a, dates[0]],
    [b, dates[1]],
    [c, dates[5]],
  ] as const)
    await run(s, { action: 'choose', memberId: member.id, dates: [date] });
  // Round two: whoever is second may choose ahead.
  const state = (await s.view(cid)).election;
  const turn = state.turn!.memberId!,
    order = state.state!.order;
  const second = [a, b, c].find((m) => m.id === order[(order.indexOf(turn) + 1) % order.length])!;
  const owner = second.id === b.id ? person : await account(second, 'second');
  const offer = (await owner.view(cid)).election.early?.guaranteed ?? [];
  assert.ok(offer.length, 'hay un ciclo asegurado');
  await run(owner, { action: 'early_choose', memberId: second.id, date: offer[0] });
  const awardId = (await repo.all('SELECT id FROM awards WHERE member_id=? AND cycle_date=?', [second.id, offer[0]]))[0]
    .id;
  const target = (await s.view(cid)).election.reconstruction.candidates.at(-1);
  const view = await run(s, { action: 'reconstruction_start', historyId: target.id });
  const rebuilt = view.election.reconstruction;
  assert.equal(rebuilt.active, true);
  assert.ok(
    !rebuilt.original.some((x: { memberId: string; date: string }) => x.date === offer[0] && x.memberId === second.id),
  );
  assert.ok(!JSON.stringify(rebuilt).includes(awardId));
  // Gone with the rewind, it stays discreet: recorded, its owner told, and unseen in the log.
  const started = (await repo.all("SELECT after_json FROM audit WHERE action='reconstruction_start'"))[0];
  assert.deepEqual(JSON.parse(started.after_json).withdrawnEarly, [awardId]);
  const notices = await repo.all("SELECT member_id FROM turn_notifications WHERE id LIKE 'withdrawn:%'");
  assert.deepEqual(
    notices.map((n) => n.member_id),
    [second.id],
  );
  assert.ok(!JSON.stringify((await s.admin()).audit).includes(awardId), 'el registro global no la muestra');
  // Its request survives the rewind (requests are restored), still unseen.
  const shown = (view: unknown) =>
    (view as { requests: { member_id: string; cycle_date: string }[] }).requests.some(
      (r) => r.member_id === second.id && r.cycle_date === offer[0],
    );
  assert.ok(
    (await repo.all('SELECT id FROM requests WHERE member_id=? AND cycle_date=?', [second.id, offer[0]])).length,
    'la solicitud sigue guardada',
  );
  assert.ok(!shown(await s.view(cid)), 'ni su solicitud durante la reconstrucción');
  // Out of the effective history, its row is still recognised as discreet.
  const loaded = await s.load(cid);
  const history = await s.election().managerHistory(cid, loaded, null);
  const earlyRow = (await repo.all("SELECT id FROM audit WHERE action='early_choose'"))[0].id;
  assert.ok(!history.done.some((e: { id: string }) => e.id === earlyRow));
  assert.ok(history.discreetIds.has(earlyRow));
  // Cancelling brings it back as it was: still pending, still discreet, still its owner's.
  const cancelled = await run(s, { action: 'reconstruction_cancel' });
  assert.equal(cancelled.election.reconstruction.active, false);
  assert.ok(!cancelled.awards.some((x) => x.id === awardId), 'la administración sigue sin verla');
  assert.equal((await owner.view(cid)).election.early?.choices[0]?.awardId, awardId);
  assert.ok(!JSON.stringify((await s.admin()).audit).includes(awardId), 'ni tras cancelar');
  assert.ok(!shown(cancelled), 'ni su solicitud tras cancelar');
});

test('la solicitud que registra la anticipada discreta tampoco se ve', async () => {
  const { s, person, run, cid, b, dates } = await election();
  await run(person, { action: 'early_choose', memberId: b.id, date: dates[2] });
  const requests = (view: unknown) =>
    (view as { requests: { member_id: string; cycle_date: string }[] }).requests
      .filter((r) => r.member_id === b.id)
      .map((r) => r.cycle_date);
  assert.deepEqual(requests(await s.view(cid)), [], 'la administración no la ve');
  const own = await person.view(cid);
  assert.ok(
    own.awards.some((a) => a.member_id === b.id && a.cycle_date === dates[2]),
    'B sí ve su elección',
  );
});

test('discreción: oculta la solicitud que creó la anticipada, nunca una que ya existía', () => {
  const row = (id: string, action: string, before: unknown, after: unknown) => ({
    id,
    action,
    before_json: JSON.stringify(before),
    after_json: JSON.stringify(after),
    created_at: '',
  });
  const old = { id: 'r-old', member_id: 'B', cycle_date: '2026-03-01', slot: 1 };
  const rows = [
    row(
      'e1',
      'early_choose',
      { requests: [old] },
      { memberId: 'B', choices: [{ id: 'a1', member_id: 'B', cycle_date: '2026-03-01' }] },
    ),
    row(
      'e2',
      'early_choose',
      { requests: [old] },
      { memberId: 'B', choices: [{ id: 'a2', member_id: 'B', cycle_date: '2026-05-01' }] },
    ),
  ];
  const current = [old, { id: 'r-new', member_id: 'B', cycle_date: '2026-05-01', slot: 2 }];
  const { ids, row: discreet } = discretion(rows, new Set(['a1', 'a2']), 'A', new Set(['a1', 'a2']), current);
  assert.ok(ids.has('r-new'), 'la solicitud creada por la anticipada');
  assert.ok(!ids.has('r-old'), 'la solicitud histórica se conserva');
  assert.ok(discreet(rows[0]) && discreet(rows[1]));
  // Its owner keeps seeing everything.
  assert.equal(discretion(rows, new Set(['a1', 'a2']), 'B', new Set(['a1', 'a2']), current).ids.size, 2);
});

test('una anticipada que se lleva un deshacer no reaparece en el registro global', async () => {
  const { s, person, run, cid, repo, b, dates } = await election();
  await run(person, { action: 'early_choose', memberId: b.id, date: dates[2] });
  const awardId = (await repo.all('SELECT id FROM awards'))[0].id;
  await run(s, { action: 'election_undo', historyId: (await s.view(cid)).election.undo });
  assert.equal((await repo.all('SELECT id FROM awards')).length, 0);
  const undo = (await repo.all("SELECT after_json FROM audit WHERE action='election_undo'"))[0];
  assert.deepEqual(JSON.parse(undo.after_json).withdrawnEarly, [awardId]);
  const log = JSON.stringify((await s.admin()).audit);
  assert.ok(!log.includes(awardId), 'ni la elección ni sus copias');
  assert.ok(!log.includes('early_choose'));
});

test('la lista que consume una anticipada discreta se muestra como estaba hasta su turno', async () => {
  const { s, person, run, cid, repo, a, b, dates } = await election();
  await run(s, { action: 'preferences', memberId: b.id, dates: [dates[6]] });
  await run(s, { action: 'advance' });
  // Stored: consumed, as the election needs it.
  const stored = await repo.all('SELECT active FROM preferences WHERE member_id=?', [b.id]);
  assert.equal(Number(stored[0].active), 0);
  assert.equal((await person.view(cid)).election.preferences.find((p) => p.member_id === b.id)?.active, false);
  // Shown to the administration as it was, with nothing pending to apply.
  const admin = await s.view(cid);
  assert.equal(admin.election.preferences.find((p) => p.member_id === b.id)?.active, true);
  assert.equal(admin.election.pendingAutomatic, false);
  const log = (await s.admin()).audit.filter((row: { campaign_id: string }) => row.campaign_id === cid);
  for (const row of log)
    for (const json of [row.before_json, row.after_json]) {
      const lists = json ? (JSON.parse(json).preferences ?? []) : [];
      assert.ok(
        !lists.some((p: { member_id: string; active?: boolean }) => p.member_id === b.id && p.active === false),
        'ninguna copia la muestra consumida',
      );
    }
  // Once the slot arrives, the real list shows.
  await run(s, { action: 'choose', memberId: a.id, dates: [dates[0]] });
  assert.equal((await s.view(cid)).election.preferences.find((p) => p.member_id === b.id)?.active, false);
});

test('estadísticas: la anticipada cuenta solo cuando es firme, para todos y también para su titular', async () => {
  const { s, person, run, cid, a, b, dates } = await election();
  await run(s, { action: 'link_account', memberId: a.id, subject: 'first@example.test', accountVersion: 0 });
  const first = new Service(s['repo'], {
    id: 'chatgpt:first',
    emailKey: 'chatgpt-email:first@example.test',
    role: 'viewer' as const,
    teams: [],
  });
  await run(person, { action: 'early_choose', memberId: b.id, date: dates[3] });
  // Its owner included: until A finishes, B's turn has not happened.
  for (const viewer of [first, s, person]) {
    const timing = (await viewer.election().summary(cid)).timing!;
    assert.ok(!timing.turns.some((t) => t.memberIds.includes(b.id)), 'pendiente: no cuenta para nadie');
    assert.ok(!timing.averages.some((x) => x.memberId === b.id));
  }
  // The owner still sees their own early choice in their view.
  assert.ok((await person.view(cid)).election.timeline.some((item) => item.anticipated));
  await run(first, { action: 'choose', memberId: a.id, dates: [dates[0]] });
  for (const viewer of [first, s, person]) {
    const timing = (await viewer.election().summary(cid)).timing!;
    const [turnA, turnB] = timing.turns;
    assert.deepEqual(
      timing.turns.map((t) => t.memberIds[0]),
      [a.id, b.id],
      'B ocupa su turno tras A',
    );
    assert.equal(turnB.activeMs, 0);
    assert.equal(turnB.at, turnA.at, 'sin revelar cuándo eligió de verdad');
    assert.ok(!('anticipated' in turnB));
    assert.deepEqual(
      timing.averages.find((x) => x.memberId === b.id),
      { memberId: b.id, turns: 1, meanMs: 0 },
    );
  }
});
