import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ELECTION_COMMANDS, electionCommandFor, electionPreconditionError } from '../server/election-commands.ts';

test('tabla de comandos de elección: acciones conocidas y nada heredado del prototipo', () => {
  assert.deepEqual(Object.keys(ELECTION_COMMANDS).sort(), [
    'advance',
    'cancel_joint',
    'choose',
    'choose_joint',
    'defer',
    'early_cancel',
    'early_choose',
    'election_redo',
    'election_undo',
    'link_account',
    'pause',
    'preferences',
    'register_joint',
    'resolve_tie',
    'resume',
    'resume_automatic',
    'start',
  ]);
  for (const action of ['toString', 'constructor', '__proto__', 'reconstruction_start', 42, undefined])
    assert.equal(electionCommandFor(action), undefined);
});

test('precondiciones de elección: campaña real, responsable y elección configurada, en ese orden', () => {
  const managerOnly = [
    'start',
    'resolve_tie',
    'register_joint',
    'cancel_joint',
    'choose_joint',
    'pause',
    'resume',
    'resume_automatic',
    'link_account',
    'election_undo',
    'election_redo',
  ];
  const needsState = ['resolve_tie', 'register_joint', 'cancel_joint', 'pause', 'resume', 'advance'];
  for (const [action, command] of Object.entries(ELECTION_COMMANDS))
    for (const live of [true, false])
      for (const manage of [true, false])
        for (const state of [null, {}]) {
          const error = electionPreconditionError(command, { live, manage, state });
          let expected: number | null = null;
          if (action === 'link_account' && !live) expected = 400;
          else if (managerOnly.includes(action) && !manage) expected = 403;
          else if (needsState.includes(action) && !state) expected = 400;
          assert.equal(error?.status ?? null, expected, `${action} live=${live} manage=${manage} state=${!!state}`);
        }
});

test('deshacer y rehacer restauran su copia; arrancar y reanudar reinician el reloj del turno', () => {
  const restores = Object.keys(ELECTION_COMMANDS).filter((a) => ELECTION_COMMANDS[a].restoresSnapshot);
  const restarts = Object.keys(ELECTION_COMMANDS).filter((a) => ELECTION_COMMANDS[a].restartsClock);
  assert.deepEqual(restores.sort(), ['election_redo', 'election_undo']);
  assert.deepEqual(restarts.sort(), ['resume', 'resume_automatic', 'start']);
});
