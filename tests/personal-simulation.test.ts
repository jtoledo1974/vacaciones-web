import test from 'node:test';
import assert from 'node:assert/strict';
import { Service } from '../server/service.ts';
import { SQLiteRepo } from './sqlite-repo.ts';
import { canComplete2027 } from '../domain/policy-2027.ts';
import { policyState2027 } from '../domain/election-2027.ts';
import { permitCounts2027 as permitCounts } from '../domain/policy-2027.ts';

const owner = { id: 'chatgpt:owner', role: 'superadmin' as const, teams: [] };
const visitor = {
  id: 'chatgpt:person',
  emailKey: 'chatgpt-email:person@example.test',
  role: 'viewer' as const,
  teams: [],
};
const stranger = { id: 'chatgpt:stranger', role: 'viewer' as const, teams: [] };

async function setup() {
  const repo = new SQLiteRepo(),
    s = new Service(repo, owner);
  await s.init();
  await s.createCampaigns(2027, null, null);
  const cid = (await s.list()).campaigns.find(
    (c: any) => c.year === 2027 && c.team_id === 'A' && c.scope_key === 'live',
  ).id;
  let d = await s.view(cid);
  const codes = Array.from({ length: 20 }, (_, i) => 'P' + String(i + 1).padStart(2, '0'));
  d = await s.mutate(cid, {
    action: 'import_roster',
    version: d.campaign.version,
    source: {
      format: 'vacaciones-roster-v1',
      team: 'A',
      year: 2027,
      copySelections: false,
      rows: codes.map((code) => ({ code, label: 'CTA ' + code, seniority: '' })),
    },
  });
  d = await s.mutate(cid, {
    action: 'config',
    version: d.campaign.version,
    config: {
      ...d.config,
      previousScores: Object.fromEntries(codes.map((code, i) => [code, 300 - i])),
      previousScoresSource: 'Puntuaciones de ensayo verificadas para 2027',
    },
  });
  const act = async (body: any, as = s) => {
    await as.election().mutate(cid, { ...body, version: (await s.load(cid)).campaign.version });
    return s.view(cid);
  };
  const me = d.members[3];
  await act({ action: 'link_account', memberId: me.id, subject: 'person@example.test', accountVersion: 0 });
  d = await act({ action: 'start', rulesConfirmed: true, allowDeferral: false });
  return { repo, s, cid, d, me, act, person: new Service(repo, visitor) };
}

test('personal simulation: private turns on top of the real election, without preferences', async () => {
  const { s, cid, d, me, act, person, repo } = await setup();
  const order: string[] = d.election.state.order.filter((id: string) => id !== me.id);
  const [first, second] = order.map((id) => d.members.find((m: any) => m.id === id));
  assert.equal(d.election.turn.memberId, first.id);
  // Someone else's saved list must never reach the simulator.
  const secret = d.result.cycles.slice(5, 8).map((c: any) => c.date);
  await act({ action: 'preferences', memberId: d.members[2].id, dates: secret, persistent: true });
  let view: any = await person.personalSimulation().view(cid);
  assert.equal(view.available, true);
  assert.equal(view.memberId, me.id);
  assert.deepEqual(view.steps, []);
  assert.equal(view.turn.memberId, first.id);
  assert.equal(JSON.stringify(view).includes('preferences'), false);
  assert.equal(view.permits.length, 6);

  const x = d.result.cycles[0].date,
    y = d.result.cycles[1].date;
  view = await person
    .personalSimulation()
    .mutate(cid, { action: 'add', entries: [{ member_id: first.id, dates: [x] }] });
  assert.equal(view.steps.length, 1);
  assert.equal(view.turn.memberId, second.id);
  assert.ok(view.awards.some((a: any) => a.simulated && a.member_id === first.id && a.cycle_date === x));
  // Not the simulated turn: rejected with the real rules.
  await assert.rejects(
    person.personalSimulation().mutate(cid, { action: 'add', entries: [{ member_id: me.id, dates: [y] }] }),
    /turno/,
  );
  view = await person
    .personalSimulation()
    .mutate(cid, { action: 'add', entries: [{ member_id: second.id, dates: [y] }] });
  assert.equal(view.steps.length, 2);
  // The real campaign is untouched and other accounts do not see the scenario.
  assert.equal((await s.view(cid)).awards.length, 0);
  await assert.rejects(new Service(repo, stranger).personalSimulation().view(cid), /vinculada/);

  view = await person.personalSimulation().mutate(cid, { action: 'undo' });
  assert.equal(view.steps.length, 1);
  view = await person
    .personalSimulation()
    .mutate(cid, { action: 'add', entries: [{ member_id: second.id, dates: [y] }] });

  // A real decision replaces the first simulated one, in order, even if it differs.
  const z = d.result.cycles[2].date;
  await act({ action: 'choose', memberId: first.id, dates: [z] });
  view = await person.personalSimulation().view(cid);
  assert.equal(view.replaced, 1);
  assert.equal(view.notice, undefined);
  assert.equal(view.steps.length, 1);
  assert.ok(view.awards.some((a: any) => !a.simulated && a.cycle_date === z));
  assert.ok(!view.awards.some((a: any) => a.cycle_date === x));

  // A real undo leaves the remaining simulated turns out of order: the whole simulation is cleared.
  await act({ action: 'election_undo', historyId: (await s.view(cid)).election.undo });
  view = await person.personalSimulation().view(cid);
  assert.match(view.notice, /se ha borrado/);
  assert.deepEqual(view.steps, []);
  assert.equal((await repo.all('SELECT * FROM personal_simulations')).length, 0);

  view = await person
    .personalSimulation()
    .mutate(cid, { action: 'add', entries: [{ member_id: first.id, dates: [x] }] });
  assert.equal(view.steps.length, 1);
  view = await person.personalSimulation().mutate(cid, { action: 'clear' });
  assert.deepEqual(view.steps, []);
});

test('personal simulation: blocked cycles name the simulated turn that blocked them', async () => {
  const { cid, d, person } = await setup();
  // Fill a preverano cycle with four people: the period's only fourth place is used up.
  const pre = d.result.cycles.filter((c: any) => c.period === 0);
  const target = pre[0].date;
  let view: any = await person.personalSimulation().view(cid);
  const before = view.permits.find((p: any) => p.period === 0 && p.kind === 'fourths');
  assert.equal(before.used, 0);
  for (let i = 0; i < 4; i++) {
    const id = view.turn.memberId;
    view = await person
      .personalSimulation()
      .mutate(cid, { action: 'add', entries: [{ member_id: id, dates: [target] }] });
  }
  assert.equal(view.permits.find((p: any) => p.period === 0 && p.kind === 'fourths').used, 1);
  // That fourth place spends an extracupo of the preverano pool (guide v1.3).
  assert.ok(view.permits.find((p: any) => p.period === 0 && p.kind === 'extras').used >= 1);
  const full = view.blocked.find((b: any) => b.cycle === target);
  assert.equal(full.causedBy, 3);
  // Other preverano cycles lose their fourth place, but a controller only needs the next free place.
  assert.ok(view.blocked.every((b: any) => b.causedBy === null || b.causedBy < view.steps.length));
});

test('permit counts: committed permits never decrease and do not depend on award order', async () => {
  const { s: admin, cid } = await setup();
  const full = await admin.load(cid);
  const base = policyState2027(2027, 'A', full.config, full.members, []);
  const pre = base.cycles.filter((c) => c.period === 0).map((c) => c.date);
  const ids = base.members.map((m) => m.id);
  const awards = [0, 1, 2].map((i) => ({ member_id: ids[i], cycle_date: pre[0] }));
  const counts = (a: typeof awards) => permitCounts({ ...base, awards: a }).map((c) => c.used);
  const empty = counts([]),
    three = counts(awards);
  assert.ok(empty.every((n) => n !== null));
  assert.deepEqual(counts([...awards].reverse()), three);
  three.forEach((n, i) => assert.ok(n === null || n >= empty[i]!));
  assert.equal(canComplete2027({ ...base, awards }).status, 'possible');
});
