/** Daily VA election. This engine has no ordinary cycles or ordinary scores. */
export type VaParticipant = {
  id: string;
  code: string;
  label: string;
  team: string;
  controllerNumber: number;
  seniority: string;
  days: number;
};
export type VaPreference = { dates: string[]; mode: 'manual' | 'immediate' | 'after_wait'; waitMinutes: number };
export type VaChoice = { personId: string; date: string; round: number; at: string };
export type VaElection = {
  format: 'va-election-v1';
  year: number;
  status: 'preparation' | 'running' | 'paused' | 'round_complete' | 'completed';
  round: 1 | 2;
  people: VaParticipant[];
  queue: string[];
  cursor: number;
  choices: VaChoice[];
  preferences: Record<string, VaPreference>;
  turnStartedAt: string | null;
  pausedAt: string | null;
  deferrals: Record<string, string>;
  deferredTargets: Record<string, string>;
  source: { title: string; sha256: string };
  automaticPaused?: boolean;
};
export const vaBalance = (state: VaElection, id: string) =>
  (state.people.find((p) => p.id === id)?.days ?? 0) - state.choices.filter((c) => c.personId === id).length;
export const vaTurn = (state: VaElection) => state.queue[state.cursor] ?? null;
export function vaNext(state: VaElection, at: string) {
  state.cursor++;
  while (state.cursor < state.queue.length && vaBalance(state, state.queue[state.cursor]) === 0) state.cursor++;
  state.turnStartedAt = at;
  if (state.cursor >= state.queue.length) {
    state.status = state.round === 1 ? 'round_complete' : 'completed';
    state.turnStartedAt = null;
    if (state.round === 1) vaStartRound(state, 2, at);
  }
}
export function vaStartRound(state: VaElection, round: 1 | 2, at: string) {
  if ((round === 1 && state.status !== 'preparation') || (round === 2 && state.status !== 'round_complete'))
    throw new Error('La ronda todavía no se puede abrir');
  state.round = round;
  state.queue = state.people.filter((p) => vaBalance(state, p.id) > 0).map((p) => p.id);
  state.cursor = -1;
  state.status = 'running';
  state.deferrals = {};
  state.deferredTargets = {};
  vaNext(state, at);
}
export function vaAvailable(state: VaElection, quotas: Record<string, number>, date: string) {
  return (quotas[date] ?? 0) - state.choices.filter((c) => c.date === date).length;
}
export function vaChoose(
  state: VaElection,
  personId: string,
  dates: string[],
  quotas: Record<string, number>,
  blocked: Set<string>,
  at: string,
) {
  if (state.status !== 'running' || vaTurn(state) !== personId) throw new Error('No es el turno de esa persona');
  const limit = state.round === 1 ? Math.min(1, vaBalance(state, personId)) : vaBalance(state, personId);
  if (!dates.length || dates.length !== limit || new Set(dates).size !== dates.length)
    throw new Error(
      state.round === 1
        ? 'En la primera ronda debes elegir exactamente un día'
        : 'En la segunda ronda debes elegir todos los días de tu saldo: ' + limit + ' días distintos',
    );
  for (const date of dates) {
    if (blocked.has(date)) throw new Error('El ' + date + ' coincide con vacaciones ordinarias');
    if (state.choices.some((c) => c.personId === personId && c.date === date))
      throw new Error('El ' + date + ' ya está elegido por esa persona');
    if (vaAvailable(state, quotas, date) <= 0) throw new Error('El ' + date + ' ya está completo');
  }
  state.choices.push(...dates.map((date) => ({ personId, date, round: state.round, at })));
  vaNext(state, at);
}
/** Partial automatic choices never silently waive a remaining balance. */
export function vaAutomatic(
  state: VaElection,
  quotas: Record<string, number>,
  blocked: Record<string, Set<string>>,
  at: string,
  maxTurns = state.people.length * 2,
) {
  const applied: { personId: string; dates: string[]; round: number }[] = [];
  for (let i = 0; i < maxTurns && state.status === 'running' && !state.automaticPaused; i++) {
    const id = vaTurn(state)!;
    const pref = state.preferences[id];
    if (!pref || pref.mode === 'manual') break;
    if (pref.mode === 'after_wait' && Date.parse(at) < Date.parse(state.turnStartedAt!) + pref.waitMinutes * 60_000)
      break;
    const limit = state.round === 1 ? 1 : vaBalance(state, id);
    const dates = pref.dates
      .filter(
        (date) =>
          !blocked[id]?.has(date) &&
          !state.choices.some((c) => c.personId === id && c.date === date) &&
          vaAvailable(state, quotas, date) > 0,
      )
      .slice(0, limit);
    if (dates.length !== limit) break;
    const round = state.round;
    vaChoose(state, id, dates, quotas, blocked[id] ?? new Set(), at);
    applied.push({ personId: id, dates, round });
  }
  return applied;
}
