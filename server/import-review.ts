import { importJoints, validateImportOrder } from '../domain/import-order.mjs';
import { currentTurn, defer, type ElectionState } from '../domain/election.ts';
import { calculate, type Award } from '../domain/vacations.ts';
import { occupancyOf } from '../domain/policy.ts';
import type { Config } from '../domain/calendar.ts';
import type { RosterRow } from './roster.ts';
import type { ImportFinding, ImportReview, SelectionStep } from '../domain/import-review-types.ts';

export async function reviewImport(
  source: { year: number; team: string; jointGroups?: string[][]; jointTurns?: { round: number; codes: string[] }[] },
  rows: RosterRow[],
  config: Config,
  version: number,
): Promise<ImportReview> {
  const sequence = validateImportOrder(source) as SelectionStep[];
  const members = rows.map((row) => ({ ...row, id: row.code }));
  const awards: Award[] = [];
  const turnAwards: Award[] = [];
  const findings: ImportFinding[] = [];
  const state: ElectionState = {
    status: 'active',
    order: rows.map((r) => r.code),
    cursor: 0,
    credits: {},
    source: 'Orden inicial declarado en la plantilla importada',
    allowDeferral: sequence.some((s) => s.deferred),
  };
  // A permanent group, or an agreement for one round only, as live elections record them.
  const joints = importJoints(source);
  state.jointGroups = joints.groups;
  state.jointAgreements = joints.turns.map((t: { round: number; codes: string[] }) => ({
    round: t.round,
    members: t.codes,
    actor: 'importación',
    at: new Date(0).toISOString(),
  }));
  const scoresComplete = rows.every((r) => Number.isFinite(config.previousScores?.[r.code]));
  if (scoresComplete) {
    state.order.sort((a, b) => config.previousScores![a] - config.previousScores![b]);
    // Equal scores rotate using the same round sequence as live elections. The
    // declared roster resolves the initial draw; we never invent a random draw.
    // Only complete scores give contiguous groups: partial ones keep the roster order.
    const groups = new Map<number, string[]>();
    for (const code of state.order) {
      const score = config.previousScores![code];
      groups.set(score, [...(groups.get(score) ?? []), code]);
    }
    state.tieGroups = [...groups.values()].filter((g) => g.length > 1);
  } else if (sequence.length)
    findings.push({
      step: 1,
      ...sequence[0],
      message:
        'Faltan puntuaciones anteriores: no se puede verificar la prioridad inicial; se contrasta el orden de plantilla declarado',
    });
  const rules = occupancyOf(source);
  const context = () => ({ year: source.year, team: source.team, config, members, awards, requests: [] });
  // Replays the declared steps through the live election's own turns, so a deferral,
  // a double turn after it and a joint turn import exactly as they would be chosen.
  let i = 0;
  while (i < sequence.length) {
    const step = sequence[i];
    const add = (message: string, at = i) => findings.push({ step: at + 1, ...sequence[at], message });
    let batch = [step];
    try {
      const turn = currentTurn({ ...context(), awards: turnAwards }, state);
      const need = turn.needed || 1;
      const expected = `corresponde ${turn.participants.join('+') || 'fin de elección'} (${need} ciclo(s)) en ronda ${turn.round}`;
      if (step.deferred) {
        if (turn.memberId !== step.code || turn.participants.length !== 1 || turn.round !== step.round) {
          add('Aplazamiento fuera de turno: ' + expected);
          state.cursor = turn.state.cursor + 1;
        } else {
          try {
            Object.assign(state, defer({ ...context(), awards: turnAwards }, state, step.code));
          } catch (e) {
            add(e instanceof Error ? e.message : String(e));
            state.cursor = turn.state.cursor + 1;
          }
        }
        i++;
        continue;
      }
      const candidate = sequence.slice(i, i + need);
      const fits =
        candidate.length === need &&
        candidate.every((s) => !s.deferred && s.round === turn.round && turn.participants.includes(s.code)) &&
        turn.participants.every((id) => candidate.filter((s) => s.code === id).length === turn.requiredByMember[id]);
      if (fits) batch = candidate;
      else add('Fuera de turno: ' + expected);
      // Walk the normative sequence independently of the proposed allocation:
      // an out-of-order entry must not silently skip a slot and cause false
      // findings against the unrelated controllers who follow it.
      Object.assign(state, turn.state, { cursor: turn.state.cursor + 1 });
      for (const id of turn.participants) state.credits[id] = 0;
      for (const s of fits ? batch : [{ code: turn.memberId, date: step.date }])
        if (s.code) turnAwards.push({ id: String(turnAwards.length), member_id: s.code, cycle_date: s.date! });
    } catch (e) {
      add(e instanceof Error ? e.message : String(e));
      // Advance anyway so one failed step does not repeat its finding on every later step.
      state.cursor += 1;
    }
    for (const [k, s] of batch.entries()) {
      const at = i + k;
      const candidate = { member_id: s.code, cycle_date: s.date! };
      if (rules) {
        const check = rules.evaluateCandidate(rules.state(context(), members, awards), [candidate], {
          maxChecks: Math.max(1, Math.floor(rules.budgets.commit / Math.max(1, sequence.length))),
          exact: false,
        });
        for (const issue of [...check.issues, ...check.warnings]) add(issue.message, at);
      } else {
        const check = calculate(
          source.year,
          source.team,
          config,
          members,
          [],
          [...awards, { ...candidate, id: String(at) }],
        );
        for (const issue of check.issues) add(issue, at);
      }
      // Occupancy follows the submitted choices even if the turn check disagrees.
      awards.push({ ...candidate, id: String(at) });
    }
    i += batch.length;
  }
  const final = calculate(source.year, source.team, config, members, [], awards);
  const report = { version, selections: awards.length, sequence, findings, blockingIssues: final.issues };
  // Binds confirmation to input, configuration and version, including labels
  // and nicks. A new preview is mandatory after any change or concurrent write.
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify({ source, config, report })),
  );
  const reviewToken = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  return { ...report, reviewToken };
}
