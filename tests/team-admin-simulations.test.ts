import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Service } from '../server/service.ts';
import { SQLiteRepo } from './sqlite-repo.ts';

const owner = { id: 'chatgpt:owner', role: 'superadmin' as const, teams: [] };
async function setup() {
  const repo = new SQLiteRepo(),
    global = new Service(repo, owner);
  await global.init();
  const live = (await global.list()).campaigns.find((c: any) => c.team_id === 'B' && c.scope_key === 'live');
  await global.configureUser({
    provider: 'chatgpt',
    subject: 'admin-b@example.test',
    role: 'team_admin',
    teams: ['B'],
    version: 0,
  });
  const team = new Service(repo, { id: 'chatgpt:email:admin-b@example.test', role: 'team_admin', teams: ['B'] });
  return { repo, global, team, live };
}
test('team admins share scenarios in their team but cannot access other teams', async () => {
  const { repo, global, team, live } = await setup();
  const real = await team.view(live.id);
  const first = await team.createSimulation(live.id, {
    name: 'Ensayo 1',
    version: real.campaign.version,
    copyPreferences: true,
  });
  const second = await team.createSimulation(live.id, { name: 'Ensayo 2', version: real.campaign.version });
  const scenarios = (await team.list()).campaigns.filter((c: any) => c.scope_key !== 'live');
  assert.equal(scenarios.length, 2);
  assert.ok(scenarios.some((c: any) => c.id === first.id));
  assert.ok(scenarios.some((c: any) => c.id === second.id));
  const foreign = (await global.list()).campaigns.find((c: any) => c.team_id === 'A');
  const other = new Service(repo, { id: 'chatgpt:a', role: 'team_admin', teams: ['A'] });
  await assert.rejects(other.view(first.id), /Simulación reservada/);
  await assert.rejects(other.createSimulation(live.id, { name: 'Ajeno', version: real.campaign.version }), /permiso/);
  await assert.rejects(team.createSimulation(foreign.id, { name: 'Ajeno', version: 1 }), /permiso/);
  await team.deleteSimulation(first.id, { version: (await team.view(first.id)).campaign.version });
  assert.equal((await team.list()).campaigns.filter((c: any) => c.scope_key !== 'live').length, 1);
});
test('simulation preferences never copy real private lists, but all simulated members are editable', async () => {
  const { global, team, live } = await setup();
  const real = await global.view(live.id),
    [a, b] = real.members,
    date = real.result.cycles[0].date;
  await global.election().mutate(live.id, {
    action: 'link_account',
    memberId: a.id,
    subject: 'private@example.test',
    accountVersion: 0,
    version: real.campaign.version,
  });
  const v = await global.view(live.id);
  await global
    .election()
    .mutate(live.id, { action: 'preferences', memberId: a.id, dates: [date], version: v.campaign.version });
  const current = await global.view(live.id);
  assert.ok(!current.election.preferenceMemberIds.includes('impossible'));
  const sim = await team.createSimulation(live.id, {
    name: 'Sin listas privadas',
    version: current.campaign.version,
    copyPreferences: true,
  });
  let d = await team.view(sim.id);
  assert.deepEqual(d.election.preferences, []);
  assert.equal(d.election.preferenceMemberIds.length, d.members.length);
  await team
    .election()
    .mutate(sim.id, { action: 'preferences', memberId: d.members[0].id, dates: [date], version: d.campaign.version });
  d = await team.view(sim.id);
  await team
    .election()
    .mutate(sim.id, { action: 'preferences', memberId: d.members[1].id, dates: [date], version: d.campaign.version });
  d = await team.view(sim.id);
  assert.equal(d.election.preferences.length, 2);
  assert.equal((await global.view(live.id)).election.preferences.length, 1);
  await assert.rejects(
    team
      .election()
      .mutate(live.id, { action: 'preferences', memberId: a.id, dates: [], version: current.campaign.version }),
    /preferencias/,
  );
});
test('team admins may activate real elections, and a team always retains a permanent admin', async () => {
  const { repo, global, team, live } = await setup();
  let d = await team.view(live.id);
  d = await team.mutate(live.id, {
    action: 'config',
    version: d.campaign.version,
    config: {
      ...d.config,
      previousScores: Object.fromEntries(d.members.map((m: any, i: number) => [m.code, 10 + i])),
      previousScoresSource: 'Puntuaciones de prueba del responsable',
    },
  });
  await team.election().mutate(live.id, {
    action: 'start',
    order: d.members.map((m: any) => m.id),
    source: 'Orden de prueba confirmado de 2025',
    rulesConfirmed: true,
    allowDeferral: true,
    version: d.campaign.version,
  });
  d = await team.view(live.id);
  assert.equal(d.election.state.status, 'active');
  await team.election().mutate(live.id, { action: 'pause', version: d.campaign.version });
  await assert.rejects(
    team.deleteUser({ action: 'delete', id: 'chatgpt:email:admin-b@example.test', version: 1, teamId: 'B' }),
  );
  await team.configureUser({
    subject: 'second@example.test',
    provider: 'chatgpt',
    role: 'team_admin',
    teams: ['B'],
    teamId: 'B',
    version: 0,
  });
  const grants = await repo.all("SELECT * FROM grants WHERE team_id='B'");
  assert.equal(grants.length, 2);
  await team.deleteUser({ action: 'delete', id: 'chatgpt:email:admin-b@example.test', version: 1, teamId: 'B' });
  assert.equal((await repo.all("SELECT * FROM grants WHERE team_id='B'")).length, 1);
});
test('delegated grants cannot remove permissions in other teams', async () => {
  const { repo, global, team } = await setup();
  await global.configureUser({
    provider: 'chatgpt',
    subject: 'two-teams@example.test',
    role: 'team_admin',
    teams: ['A'],
    version: 0,
  });
  await team.configureUser({
    provider: 'chatgpt',
    subject: 'two-teams@example.test',
    role: 'team_admin',
    teams: ['B'],
    teamId: 'B',
    version: 0,
  });
  const id = 'chatgpt:email:two-teams@example.test';
  assert.deepEqual(
    (await repo.all('SELECT team_id FROM grants WHERE user_id=? ORDER BY team_id', [id])).map((r: any) => r.team_id),
    ['A', 'B'],
  );
  await team.deleteUser({ action: 'delete', id, version: 2, teamId: 'B' });
  assert.deepEqual(
    (await repo.all('SELECT team_id FROM grants WHERE user_id=?', [id])).map((r: any) => r.team_id),
    ['A'],
  );
  const listing = await team.admin();
  assert.ok(listing.grants.every((g: any) => g.team_id === 'B'));
});

test('team administrator reset removes linked preferences but roster import respects privacy', async () => {
  const { global, team, live } = await setup();
  let d = await global.view(live.id),
    member = d.members[0],
    date = d.result.cycles[0].date;
  await global.election().mutate(live.id, {
    action: 'link_account',
    memberId: member.id,
    subject: 'owner@example.test',
    accountVersion: 0,
    version: d.campaign.version,
  });
  d = await global.view(live.id);
  await global
    .election()
    .mutate(live.id, { action: 'preferences', memberId: member.id, dates: [date], version: d.campaign.version });
  d = await global.view(live.id);
  const before = { version: d.campaign.version, awards: d.awards, state: d.election.state };
  const cleared = await team.mutate(live.id, {
    action: 'reset_vacations',
    confirmation: 'B-2026',
    version: d.campaign.version,
  });
  d = await global.view(live.id);
  assert.equal(d.campaign.version, before.version + 1);
  assert.deepEqual(d.awards, []);
  assert.deepEqual(d.requests, []);
  assert.deepEqual(d.election.preferences, [], 'todas las preferencias vinculadas se borran también');
  assert.equal(d.election.state, null);
  await team.mutate(live.id, {
    action: 'undo_vacations',
    undoId: cleared.undo.id,
    version: d.campaign.version,
  });
  d = await global.view(live.id);
  assert.deepEqual(d.awards, before.awards);
  assert.deepEqual(d.election.state, before.state);
  assert.deepEqual(d.election.preferences.find((p: any) => p.member_id === member.id)?.dates, [date]);
  const roster = {
    format: 'vacaciones-roster-v1',
    team: 'B',
    year: 2026,
    copySelections: false,
    rows: [{ code: 'B_TEST', label: 'Ficticio', seniority: '' }],
  };
  await assert.rejects(
    team.mutate(live.id, { action: 'import_roster', version: d.campaign.version, source: roster }),
    /preferencias privadas/,
  );
  assert.equal((await global.view(live.id)).members.length, d.members.length);
});

test('un reinicio no se puede deshacer sobre preferencias nuevas de cuentas vinculadas', async () => {
  const { global, team, live } = await setup();
  let d = await global.view(live.id);
  const member = d.members[0];
  const date = d.result.cycles[0].date;
  await global.election().mutate(live.id, {
    action: 'link_account',
    memberId: member.id,
    subject: 'protected@example.test',
    accountVersion: 0,
    version: d.campaign.version,
  });
  d = await global.view(live.id);
  const reset = await team.mutate(live.id, {
    action: 'reset_vacations',
    confirmation: 'B-2026',
    version: d.campaign.version,
  });
  await global.election().mutate(live.id, {
    action: 'preferences',
    memberId: member.id,
    dates: [date],
    version: reset.campaign.version,
  });
  d = await global.view(live.id);
  await assert.rejects(
    team.mutate(live.id, {
      action: 'undo_vacations',
      undoId: reset.undo.id,
      version: d.campaign.version,
    }),
    /El cambio ya no se puede deshacer/,
  );
  assert.deepEqual((await global.view(live.id)).election.preferences.find((p) => p.member_id === member.id)?.dates, [
    date,
  ]);
});

test('otro administrador rehace un reinicio deshecho solo si nadie ha guardado nada después', async () => {
  const { global, team, live } = await setup();
  let d = await global.view(live.id);
  const [member, other] = d.members;
  const [first, second] = d.result.cycles.map((c) => c.date);
  await global.election().mutate(live.id, {
    action: 'link_account',
    memberId: member.id,
    subject: 'redo@example.test',
    accountVersion: 0,
    version: d.campaign.version,
  });
  d = await global.view(live.id);
  await global.election().mutate(live.id, {
    action: 'preferences',
    memberId: member.id,
    dates: [first],
    mode: 'wait',
    waitMinutes: 30,
    labels: { [first]: 'Verano' },
    version: d.campaign.version,
  });
  d = await global.view(live.id);
  const reset = await global.mutate(live.id, {
    action: 'reset_vacations',
    confirmation: 'B-2026',
    version: d.campaign.version,
  });
  const undone = await team.mutate(live.id, {
    action: 'undo_vacations',
    undoId: reset.undo.id,
    version: reset.campaign.version,
  });
  d = await global.view(live.id);
  assert.deepEqual(d.election.preferences.find((p) => p.member_id === member.id)?.dates, [first]);
  const redone = await team.mutate(live.id, {
    action: 'redo_vacations',
    undoId: d.redo.id,
    version: d.campaign.version,
  });
  assert.deepEqual((await global.view(live.id)).election.preferences, []);
  // Undo again, then a controller saves: redoing must not erase that list.
  const view = await global.view(live.id);
  await team.mutate(live.id, { action: 'undo_vacations', undoId: view.undo.id, version: view.campaign.version });
  d = await global.view(live.id);
  const pending = d.redo;
  await global.election().mutate(live.id, {
    action: 'preferences',
    memberId: other.id,
    dates: [second],
    version: d.campaign.version,
  });
  d = await global.view(live.id);
  await assert.rejects(
    global.mutate(live.id, { action: 'redo_vacations', undoId: pending.id, version: d.campaign.version }),
    /ya no se puede deshacer|datos nuevos/,
  );
  assert.equal((await global.view(live.id)).election.preferences.length, 2);
  assert.ok(undone && redone);
});

test('team admin can activate, pause and resume an unstarted private simulation', async () => {
  const { global, team, live } = await setup();
  const source = await team.view(live.id);
  const created = await team.createSimulation(live.id, {
    name: 'Primera elección del responsable',
    version: source.campaign.version,
  });
  let d = await team.view(created.id);
  assert.equal(d.election.state, null);
  assert.equal(d.election.canManage, true);
  d = await team.mutate(created.id, {
    action: 'config',
    version: d.campaign.version,
    config: {
      ...d.config,
      previousScores: Object.fromEntries(d.members.map((m: any, i: number) => [m.code, 10 + i])),
      previousScoresSource: 'Puntuaciones previas para simulación del equipo',
    },
  });
  await team
    .election()
    .mutate(created.id, { action: 'start', rulesConfirmed: true, allowDeferral: true, version: d.campaign.version });
  d = await team.view(created.id);
  assert.equal(d.election.state.status, 'active');
  await team.election().mutate(created.id, { action: 'pause', version: d.campaign.version });
  d = await team.view(created.id);
  assert.equal(d.election.state.status, 'paused');
  await team.election().mutate(created.id, { action: 'resume', version: d.campaign.version });
  d = await team.view(created.id);
  assert.equal(d.election.state.status, 'active');
  assert.equal((await global.view(live.id)).election.state, null);
});
