import {
  choose,
  chooseJoint,
  currentTurn,
  entitlementFor,
  type ElectionContext,
  type ElectionState,
  type JointChoice,
} from './election.ts';
import { occupancyFor, type RuleProblem } from './policy.ts';
import type { AvailabilitySnapshot, PermitCount } from './occupancy.ts';

/**
 * A controller's private what-if: hypothetical turns played on top of the real
 * election. It never reads anybody's preference list; the only inputs are the
 * public awards and order, and the turns the controller types in.
 *
 * Each step records the election cursor at which it was taken. Real decisions
 * replace simulated ones in order: steps before the real cursor are dropped,
 * and the rest must replay exactly from the real state, or the whole
 * simulation is no longer valid.
 */
export type SimulationStep = { cursor: number; entries: JointChoice[] };
export type PersonalScenario = { steps: SimulationStep[] };
export const MAX_SIMULATION_STEPS = 40;

type Replayed = { ctx: ElectionContext; state: ElectionState; prefixes: ElectionContext['awards'][] };
export type Reconciled =
  | { valid: true; steps: SimulationStep[]; replaced: number; replay: Replayed }
  | { valid: false; replaced: number; error: string };

const award = (member_id: string, cycle_date: string, i: number) => ({ id: 'simulated-' + i, member_id, cycle_date });

/** Apply one turn exactly as the real election would (same validation). */
export function applyStep(
  ctx: ElectionContext,
  state: ElectionState,
  entries: JointChoice[],
): { ctx: ElectionContext; state: ElectionState; step: SimulationStep } {
  const turn = currentTurn(ctx, state);
  if (!turn.memberId)
    throw new Error(
      turn.pendingTie
        ? 'Hay un empate pendiente de sorteo: la simulación no puede seguir.'
        : 'La elección no tiene más turnos.',
    );
  const result =
    turn.participants.length > 1
      ? chooseJoint(ctx, state, entries)
      : (() => {
          if (entries.length !== 1 || entries[0].member_id !== turn.memberId)
            throw new Error('No es el turno de ese controlador');
          return choose(ctx, state, turn.memberId, entries[0].dates);
        })();
  const offset = ctx.awards.length;
  return {
    ctx: {
      ...ctx,
      awards: [...ctx.awards, ...result.choices.map((c, i) => award(c.member_id, c.cycle_date, offset + i))],
    },
    state: result.state,
    step: {
      cursor: turn.state.cursor,
      entries: turn.participants.map((id) => ({
        member_id: id,
        dates: result.choices.filter((c) => c.member_id === id).map((c) => c.cycle_date),
      })),
    },
  };
}

/** Replace steps already overtaken by real decisions and replay the rest. */
export function reconcileScenario(ctx: ElectionContext, real: ElectionState, scenario: PersonalScenario): Reconciled {
  const start = currentTurn(ctx, real).state;
  const remaining = scenario.steps.filter((step) => step.cursor >= start.cursor);
  const replaced = scenario.steps.length - remaining.length;
  let simCtx = ctx,
    simState = start;
  const prefixes: ElectionContext['awards'][] = [ctx.awards];
  for (const step of remaining) {
    try {
      const turn = currentTurn(simCtx, simState);
      if (turn.state.cursor !== step.cursor)
        return { valid: false, replaced, error: 'El turno simulado ya no coincide con el orden real.' };
      const next = applyStep(simCtx, simState, step.entries);
      simCtx = next.ctx;
      simState = next.state;
      prefixes.push(simCtx.awards);
    } catch (error: any) {
      return { valid: false, replaced, error: error?.message ?? 'Paso simulado no válido' };
    }
  }
  return { valid: true, steps: remaining, replaced, replay: { ctx: simCtx, state: simState, prefixes } };
}

export type BlockedCycle = {
  cycle: string;
  status: 'blocked' | 'indeterminate';
  reasons: RuleProblem[];
  /** Index of the simulated step after which the cycle became blocked; null if already blocked in reality. */
  causedBy: number | null;
};
/** Guide v1.3: per period a pool of extracupos (EC3, or EC4 used as fourth
 * place or as EC3) and, separately, the cycles that may reach four people. */
export type { PermitCount };
export type PersonalEvaluation = {
  availability: AvailabilitySnapshot;
  blocked: BlockedCycle[];
  permits: PermitCount[];
  /** Cycles still to choose for the controller, in the simulated state. */
  remaining: number;
};

/** The next place of a cycle is what the controller would take. */
function nextPlace(snapshot: AvailabilitySnapshot, date: string) {
  const c = snapshot.cycles[date];
  if (!c) return null;
  return c.occupied >= c.slots.length
    ? {
        status: 'blocked' as const,
        reasons: [
          { code: 'CYCLE_FULL', message: 'Todas las plazas del ciclo están ocupadas.', period: c.period, cycle: date },
        ],
      }
    : c.slots[c.occupied];
}
const blockedIn = (snapshot: AvailabilitySnapshot, date: string) => nextPlace(snapshot, date)?.status === 'blocked';

/**
 * What the simulated turns leave for `me`. Availability only shrinks as
 * awards are added, so the first prefix in which a cycle is blocked is found
 * by bisection over the replayed prefixes.
 */
export function evaluateScenario(
  replay: Replayed,
  me: string,
  options: { maxChecks?: number } = {},
): PersonalEvaluation {
  const { ctx } = replay;
  const rules = occupancyFor(ctx.year);
  if (!rules) throw new Error('El simulador personal requiere un motor de ocupación');
  const policy = (awards: ElectionContext['awards']) => rules.state(ctx, ctx.members, awards);
  const snapshots = new Map<number, AvailabilitySnapshot>();
  const at = (i: number) => {
    if (!snapshots.has(i))
      snapshots.set(i, rules.availability(policy(replay.prefixes[i]), { maxChecks: options.maxChecks }));
    return snapshots.get(i)!;
  };
  const last = replay.prefixes.length - 1,
    final = at(last);
  const mine = new Set(ctx.awards.filter((a) => a.member_id === me).map((a) => a.cycle_date));
  const blocked: BlockedCycle[] = [];
  for (const date of Object.keys(final.cycles)) {
    if (mine.has(date)) continue;
    const place = nextPlace(final, date);
    if (!place || place.status === 'available' || place.status === 'occupied') continue;
    let causedBy: number | null = null;
    if (place.status === 'blocked' && !blockedIn(at(0), date)) {
      let low = 0,
        high = last; // blocked at high, not at low
      while (high - low > 1) {
        const mid = (low + high) >> 1;
        if (blockedIn(at(mid), date)) high = mid;
        else low = mid;
      }
      causedBy = high - 1;
    }
    blocked.push({ cycle: date, status: place.status, reasons: place.reasons, causedBy });
  }
  const remaining = Math.max(0, entitlementFor(ctx, me) - mine.size);
  return { availability: final, blocked, permits: rules.permitReport(policy(ctx.awards)), remaining };
}
