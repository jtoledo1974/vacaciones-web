import { type Repository, type Statement } from './repository.ts';
import { ApiError } from './errors.ts';
import { decodePayload, encodePayload } from './payload-codec.ts';
import { vaChoose, vaNext, vaStartRound, vaAutomatic, vaAvailable, type VaElection } from '../domain/va-election.ts';

type History = {
  id: number;
  action: string;
  before_json: string;
  after_json: string;
  undone: number;
  created_at: string;
};
export type VaReconstruction = {
  year: number;
  working_json: string;
  steps_json: string;
  created_at: string;
  actor: string;
};
export const readVaReconstruction = async (repo: Repository, year: number) =>
  (await repo.all<VaReconstruction>('SELECT * FROM va_reconstructions WHERE year=?', [year]))[0] ?? null;
const snapshot = (state: VaElection) => {
  const { preferences: _private, ...run } = state;
  return JSON.stringify(run);
};
export function vaHistoryOps(
  before: string | null,
  state: VaElection,
  action: string,
  actor: string | null,
  at: string,
): Statement[] {
  if (action === 'import')
    return [
      { sql: 'DELETE FROM va_election_history WHERE year=?', args: [state.year] },
      { sql: 'DELETE FROM va_reconstructions WHERE year=?', args: [state.year] },
    ];
  if (
    !before ||
    ![
      'start',
      'choose',
      'skip',
      'defer',
      'pause',
      'resume',
      'resume_automatic',
      'advance',
      'reconstruct_finish',
    ].includes(action)
  )
    return [];
  return [
    { sql: 'DELETE FROM va_election_history WHERE year=? AND undone=1', args: [state.year] },
    {
      sql: 'INSERT INTO va_election_history(year,action,actor,before_json,after_json,created_at,undone) VALUES(?,?,?,?,?,?,0)',
      args: [
        state.year,
        action,
        actor,
        encodePayload(snapshot(JSON.parse(before) as VaElection)),
        encodePayload(snapshot(state)),
        at,
      ],
    },
  ];
}
export async function vaControlsView(repo: Repository, year: number) {
  const history = await repo.all<History>(
    'SELECT id,action,undone,created_at FROM va_election_history WHERE year=? ORDER BY id DESC LIMIT 100',
    [year],
  );
  const reconstruction = await readVaReconstruction(repo, year);
  const [counts] = await repo.all<{ undo: number; redo: number }>(
    'SELECT SUM(CASE WHEN undone=0 THEN 1 ELSE 0 END) AS undo,SUM(CASE WHEN undone=1 THEN 1 ELSE 0 END) AS redo FROM va_election_history WHERE year=?',
    [year],
  );
  return {
    canUndo: !reconstruction && (counts?.undo ?? 0) > 0,
    canRedo: !reconstruction && (counts?.redo ?? 0) > 0,
    history: history.map((h) => ({ id: h.id, action: h.action, undone: !!h.undone, at: h.created_at })),
    reconstruction: reconstruction
      ? { active: true, steps: (JSON.parse(reconstruction.steps_json) as string[]).length }
      : null,
  };
}
export function validateVaRestoration(
  state: VaElection,
  quotas: Record<string, number>,
  blocked: Record<string, Set<string>>,
) {
  const seen = new Set<string>();
  for (const c of state.choices) {
    if (seen.has(c.personId + ':' + c.date)) throw new ApiError('La restauración duplica un día');
    seen.add(c.personId + ':' + c.date);
    if (vaAvailable(state, quotas, c.date) < 0)
      throw new ApiError('No se puede restaurar: el ' + c.date + ' ya no tiene cupo suficiente', 409);
    if (blocked[c.personId]?.has(c.date))
      throw new ApiError('No se puede restaurar: el ' + c.date + ' coincide con ordinarias', 409);
  }
}
type Input = { action?: string; personId?: string; dates?: unknown; reason?: string };
export async function vaControlMutation(
  repo: Repository,
  state: VaElection,
  body: Input,
  actor: string,
  quotas: Record<string, number>,
  blocked: Record<string, Set<string>>,
  dates: (v: unknown) => string[],
  at: string,
) {
  const action = body.action ?? '',
    year = state.year;
  if (
    ![
      'undo',
      'redo',
      'resume_automatic',
      'reconstruct_start',
      'reconstruct_step',
      'reconstruct_skip',
      'reconstruct_auto',
      'reconstruct_back',
      'reconstruct_cancel',
      'reconstruct_finish',
    ].includes(action)
  )
    return null;
  const reconstruction = await readVaReconstruction(repo, year);
  if (action === 'undo' || action === 'redo') {
    if (reconstruction) throw new ApiError('Termina o cancela la reconstrucción antes de deshacer');
    const undone = action === 'redo' ? 1 : 0;
    const h = (
      await repo.all<History>(
        `SELECT * FROM va_election_history WHERE year=? AND undone=? ORDER BY id ${undone ? 'ASC' : 'DESC'} LIMIT 1`,
        [year, undone],
      )
    )[0];
    if (!h) throw new ApiError(action === 'undo' ? 'No hay cambios que deshacer' : 'No hay cambios que rehacer');
    const restored = {
      ...JSON.parse(decodePayload(action === 'undo' ? h.before_json : h.after_json)),
      preferences: state.preferences,
      automaticPaused: true,
    } as VaElection;
    restored.turnStartedAt = restored.turnStartedAt ? at : null;
    if (restored.status === 'paused') restored.pausedAt = at;
    return {
      state: restored,
      ops: [
        {
          sql: 'UPDATE va_election_history SET undone=? WHERE id=? AND year=?',
          args: [action === 'undo' ? 1 : 0, h.id, year],
        },
      ],
      detail: { targetId: h.id, action: h.action },
    };
  }
  if (action === 'resume_automatic') {
    if (reconstruction) throw new ApiError('Los automatismos están detenidos durante la reconstrucción');
    const next = structuredClone(state);
    next.automaticPaused = false;
    const automatic = vaAutomatic(next, quotas, blocked, at);
    return { state: next, ops: [] as Statement[], detail: { automatic } };
  }
  if (action === 'reconstruct_start') {
    if (reconstruction) throw new ApiError('Ya hay una reconstrucción abierta');
    if (state.status === 'preparation') throw new ApiError('Abre primero la elección para reconstruirla');
    const working = structuredClone(state);
    working.status = 'preparation';
    working.choices = [];
    working.automaticPaused = true;
    working.pausedAt = null;
    vaStartRound(working, 1, at);
    return {
      state,
      ops: [
        {
          sql: 'INSERT INTO va_reconstructions(year,working_json,steps_json,created_at,actor) VALUES(?,?,?, ?,?)',
          args: [year, snapshot(working), '[]', at, actor],
        },
      ],
      detail: { originalChoices: state.choices.length },
    };
  }
  if (!reconstruction) throw new ApiError('No hay reconstrucción abierta');
  const working = { ...JSON.parse(reconstruction.working_json), preferences: state.preferences } as VaElection;
  const steps = JSON.parse(reconstruction.steps_json) as string[];
  if (action === 'reconstruct_cancel') {
    return {
      state: { ...state, automaticPaused: true },
      ops: [{ sql: 'DELETE FROM va_reconstructions WHERE year=?', args: [year] }],
      detail: { discardedSteps: steps.length },
    };
  }
  if (action === 'reconstruct_finish') {
    working.automaticPaused = true;
    return {
      state: working,
      ops: [{ sql: 'DELETE FROM va_reconstructions WHERE year=?', args: [year] }],
      detail: { steps: steps.length, choices: working.choices.length },
    };
  }
  if (action === 'reconstruct_back') {
    const previous = steps.pop();
    if (!previous) throw new ApiError('No hay pasos que deshacer en la reconstrucción');
    Object.assign(working, JSON.parse(decodePayload(previous)), {
      preferences: state.preferences,
      automaticPaused: true,
    });
  } else {
    // Each step is compressed on its own; legacy plain steps stay readable.
    steps.push(encodePayload(snapshot(working)));
    if (action === 'reconstruct_step') {
      if (!body.personId) throw new ApiError('Indica para quién reconstruyes');
      vaChoose(working, body.personId, dates(body.dates), quotas, blocked[body.personId] ?? new Set(), at);
    } else if (action === 'reconstruct_skip') {
      if (
        working.status !== 'running' ||
        typeof body.reason !== 'string' ||
        !body.reason.trim() ||
        body.reason.length > 500
      )
        throw new ApiError('Indica un motivo para saltar el turno');
      vaNext(working, at);
    } else if (action === 'reconstruct_auto') {
      working.automaticPaused = false;
      // Apply exactly the current person's list, never silently drain the queue.
      const applied = vaAutomatic(working, quotas, blocked, at, 1);
      working.automaticPaused = true;
      if (!applied.length) throw new ApiError('Las preferencias del turno no se pueden aplicar todavía');
    }
  }
  return {
    state,
    ops: [
      {
        sql: 'UPDATE va_reconstructions SET working_json=?,steps_json=? WHERE year=?',
        args: [snapshot(working), JSON.stringify(steps), year],
      },
    ],
    detail: { steps: steps.length, personId: body.personId, dates: body.dates, reason: body.reason },
  };
}
