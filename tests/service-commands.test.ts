import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Service } from '../server/service.ts';
import { COMMANDS, commandFor, preconditionError } from '../server/service-commands.ts';
import { SQLiteRepo } from './sqlite-repo.ts';

const PAUSE = 'Pausa la elección antes de corregir datos o cambiar la plantilla',
  CLOSED = 'La campaña está cerrada. Un superadministrador puede reabrirla.',
  LIVE_ONLY = 'El traslado entre grupos se gestiona en la campaña real, no desde una simulación aislada';
const base = { electionActive: false, closed: false, live: true, renameOnly: false };

test('tabla de comandos: acciones de administración conocidas y nada heredado del prototipo', () => {
  assert.deepEqual(Object.keys(COMMANDS).sort(), [
    'award',
    'bulk_members',
    'calculate',
    'close',
    'config',
    'delete_award',
    'delete_request',
    'import_roster',
    'member',
    'publish',
    'redo_vacations',
    'reopen',
    'request',
    'reset_vacations',
    'retire_member',
    'transfer_member',
    'undo_vacations',
  ]);
  for (const action of ['toString', 'constructor', '__proto__', 'unknown', 42, undefined])
    assert.equal(commandFor(action), undefined);
});

test('precondiciones por acción: elección activa, campaña cerrada, simulación o campaña real', () => {
  const expected = (action: string, s: typeof base) => {
    if (s.electionActive && !s.renameOnly) {
      const allowed = ['calculate', 'close', ...(s.live ? [] : ['reset_vacations'])];
      if (!allowed.includes(action)) return PAUSE;
    }
    if (s.closed && !['reopen', 'publish', 'close'].includes(action)) return CLOSED;
    if (action === 'transfer_member' && !s.live) return LIVE_ONLY;
    return null;
  };
  for (const action of [...Object.keys(COMMANDS), 'unknown'])
    for (const electionActive of [false, true])
      for (const closed of [false, true])
        for (const live of [false, true])
          for (const renameOnly of [false, true]) {
            const s = { electionActive, closed, live, renameOnly };
            assert.equal(preconditionError(commandFor(action), s), expected(action, s), JSON.stringify({ action, s }));
          }
  assert.equal(preconditionError(undefined, base), null, 'la acción desconocida falla después: Operación no válida');
});

test('solo member y bulk_members pueden ser renombrados que no pausan ni reinician la elección', () => {
  const renaming = Object.entries(COMMANDS)
    .filter(([, command]) => command.preconditions.renameOnly)
    .map(([action]) => action);
  assert.deepEqual(renaming.sort(), ['bulk_members', 'member']);
  const d: any = { members: [{ id: 'm1', code: 'AA', seniority: '2001-01-01' }] };
  const member = COMMANDS.member.preconditions.renameOnly!;
  assert.equal(member({ memberId: 'm1', seniority: ' 2001-01-01 ' }, d), true);
  assert.equal(member({ memberId: 'm1', seniority: '2002-01-01' }, d), false);
  assert.equal(member({ seniority: '2001-01-01' }, d), false, 'un alta nunca es un renombrado');
  const bulk = COMMANDS.bulk_members.preconditions.renameOnly!;
  assert.equal(bulk({ rows: [{ memberId: 'm1', seniority: '2001-01-01' }] }, d), true);
  assert.equal(bulk({ rows: [] }, d), false, 'retirar filas no es un renombrado');
});

test('efecto sobre la elección y copia para deshacer declarados por comando', () => {
  const keeps = Object.entries(COMMANDS)
    .filter(([, command]) => command.election === 'keep')
    .map(([action]) => action);
  // Undo/redo restore the saved election inside execute; the pipeline must keep it.
  assert.deepEqual(keeps.sort(), ['calculate', 'publish', 'redo_vacations', 'reopen', 'undo_vacations']);
  const undoable = Object.entries(COMMANDS)
    .filter(([, command]) => command.vacationsUndo)
    .map(([action]) => action);
  assert.deepEqual(undoable.sort(), [
    'award',
    'delete_award',
    'delete_request',
    'redo_vacations',
    'request',
    'reset_vacations',
    'undo_vacations',
  ]);
});

test('la canalización aplica las precondiciones en la campaña real y en simulaciones', async () => {
  const repo = new SQLiteRepo(),
    s = new Service(repo, { id: 'chatgpt:owner', role: 'superadmin', teams: [] });
  await s.init();
  const cid = (await s.list()).campaigns.find((c: any) => c.team_id === 'C').id;
  let d: any = await s.view(cid);
  const request = (v: any) => ({
    action: 'request',
    version: v.campaign.version,
    memberId: v.members[0].id,
    slot: 1,
    date: v.result.cycles[0].date,
  });
  await assert.rejects(s.mutate(cid, { action: 'toString', version: d.campaign.version }), /Operación no válida/);

  const simulation = (await s.createSimulation(cid, { name: 'Ensayo', version: d.campaign.version })).id;
  const sim: any = await s.view(simulation);
  await assert.rejects(
    s.mutate(simulation, {
      action: 'transfer_member',
      version: sim.campaign.version,
      memberId: sim.members[0].id,
      targetTeam: 'A',
    }),
    { message: LIVE_ONLY },
  );

  d = await s.view(cid);
  d = await s.mutate(cid, {
    action: 'config',
    version: d.campaign.version,
    config: {
      ...d.config,
      previousScores: Object.fromEntries(d.members.map((m: any, i: number) => [m.code, i])),
      previousScoresSource: 'Puntuaciones de ensayo verificadas',
    },
  });
  await s.election().mutate(cid, {
    action: 'start',
    version: d.campaign.version,
    order: d.members.map((m: any) => m.id),
    source: 'Orden histórico confirmado por administrador',
    rulesConfirmed: true,
    allowDeferral: true,
  });
  d = await s.view(cid);
  assert.equal(d.election.state.status, 'active');
  await assert.rejects(s.mutate(cid, request(d)), { message: PAUSE });
  await assert.rejects(
    s.mutate(cid, { action: 'reset_vacations', version: d.campaign.version, confirmation: 'C-2026' }),
    { message: PAUSE },
  );
  const [m] = d.members;
  d = await s.mutate(cid, {
    action: 'member',
    version: d.campaign.version,
    memberId: m.id,
    code: 'ZZ1',
    seniority: m.seniority,
  });
  assert.equal(d.election.state.status, 'active', 'renombrar no pausa ni reinicia la elección');
  d = await s.mutate(cid, { action: 'calculate', version: d.campaign.version });
  assert.equal(d.election.state.status, 'active');
  d = await s.mutate(cid, { action: 'close', version: d.campaign.version });
  assert.equal(d.campaign.status, 'closed');
  assert.equal(d.election.state.status, 'paused', 'cerrar pausa la elección');
  await assert.rejects(s.mutate(cid, request(d)), { message: CLOSED });
  d = await s.mutate(cid, { action: 'reopen', version: d.campaign.version });
  assert.equal(d.campaign.status, 'open');
  d = await s.mutate(cid, request(d));
  assert.equal(d.election.state, null, 'una corrección con la elección en pausa la reinicia');
});
