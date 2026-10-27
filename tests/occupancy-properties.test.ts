import assert from 'node:assert/strict';
import test from 'node:test';
import { occupancyFor, resetOccupancyCaches } from '../domain/policy.ts';
import { availabilityStateKey2027 } from '../domain/availability-2027.ts';
import type { PolicyState, PolicyAward } from '../domain/occupancy.ts';
import realThirds from './policy-2027-tercer-cupo-real.json' with { type: 'json' };

const rules = occupancyFor(2027)!;
const maxChecks = 10000;
const seed = 1152027;

/** Small reproducible campaigns, with valid prefixes and arbitrary restrictions.
 * Failures print the seed and case; no wall-clock randomness or dependencies. */
function generatedStates(): PolicyState[] {
  let value = seed;
  const random = (n: number) => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    return value % n;
  };
  const states: PolicyState[] = [];
  for (let i = 0; i < 32; i++) {
    const state: PolicyState = {
      cycles: Array.from({ length: 6 + random(3) }, (_, c) => ({
        date: 'c' + c,
        period: (c % 3) as 0 | 1 | 2,
        maximum: 2 + random(3),
        fourthExcluded: random(4) === 0,
      })),
      members: Array.from({ length: 3 + random(3) }, (_, m) => ({ id: 'm' + m, entitlement: 3 + random(3) })),
      awards: [],
    };
    if (i % 3 === 0) state.summerTotal = 2 * state.members.length;
    const completion = rules.canComplete(state, { maxChecks, exact: true });
    if (completion.status === 'possible') {
      assert.ok(completion.witness);
      assert.ok(rules.evaluateFinal({ ...state, awards: completion.witness }).valid);
      state.awards = completion.witness.filter(() => random(3) !== 0);
    }
    if (i % 2 === 0) {
      for (let a = 0, n = 1 + random(8); a < n; a++) {
        state.awards.push({
          member_id: state.members[random(state.members.length)].id,
          cycle_date: state.cycles[random(state.cycles.length)].date,
        });
      }
    }
    states.push(state);
  }
  return states;
}

function choices(state: PolicyState): PolicyAward[] {
  return state.members.flatMap((member) =>
    state.cycles.map((cycle) => ({ member_id: member.id, cycle_date: cycle.date })),
  );
}

test('propiedad: añadir adjudicaciones nunca repara un estado demostrado imposible', () => {
  let impossible = 0;
  for (const [i, state] of generatedStates().entries()) {
    resetOccupancyCaches();
    if (rules.canComplete(state, { maxChecks, exact: true }).status !== 'impossible') continue;
    impossible++;
    for (const choice of choices(state)) {
      const next = { ...state, awards: [...state.awards, choice] };
      assert.equal(rules.canComplete(next, { maxChecks, exact: true }).status, 'impossible', `seed=${seed}, case=${i}`);
    }
  }
  assert.ok(impossible >= 8, 'the generated cases must exercise impossibility');
});

test('propiedad: toda elección permitida lleva un testigo final válido, también en lotes', () => {
  let allowed = 0;
  let batches = 0;
  for (const [i, state] of generatedStates().entries()) {
    resetOccupancyCaches();
    const singles = choices(state).map((choice) => [choice]);
    const completion = rules.canComplete(state, { maxChecks });
    const candidates = [...singles, ...(completion.witness?.length ? [completion.witness.slice(0, 2)] : [])];
    for (const selected of candidates) {
      const result = rules.evaluateCandidate(state, selected, { maxChecks });
      if (!result.allowed) continue;
      allowed++;
      if (selected.length > 1) batches++;
      assert.equal(result.completion.status, 'possible');
      assert.ok(result.completion.witness);
      assert.ok(
        rules.evaluateFinal({ ...state, awards: [...state.awards, ...selected, ...result.completion.witness] }).valid,
        `seed=${seed}, case=${i}`,
      );
    }
  }
  assert.ok(allowed > 20);
  assert.ok(batches > 0);
});

test('propiedad: disponibilidad existencial, candidatos y legalChoices son coherentes', () => {
  let available = 0;
  let blocked = 0;
  for (const [i, state] of generatedStates().entries()) {
    resetOccupancyCaches();
    const snapshot = rules.availability(state, { maxChecks, exact: true });
    const byDate = new Map(state.cycles.map((c) => [c.date, [] as ReturnType<typeof rules.evaluateCandidate>[]]));
    for (const member of state.members) {
      const legal = rules.legalChoices(state, member.id, {
        budget: { total: maxChecks * state.cycles.length, perCandidate: maxChecks },
      });
      assert.equal(legal.legal.length + legal.unknown.length + Object.keys(legal.illegal).length, state.cycles.length);
      for (const cycle of state.cycles) {
        const candidate = rules.evaluateCandidate(state, [{ member_id: member.id, cycle_date: cycle.date }], {
          maxChecks,
        });
        byDate.get(cycle.date)!.push(candidate);
        assert.equal(
          legal.legal.includes(cycle.date),
          candidate.allowed,
          `seed=${seed}, case=${i}, member=${member.id}, cycle=${cycle.date}`,
        );
        assert.equal(legal.unknown.includes(cycle.date), candidate.completion.status === 'indeterminate');
      }
    }
    if (snapshot.status === 'invalid') continue;
    // A slot is existential across controllers. It does not promise that any
    // particular member can take it, or that all available slots fit together.
    for (const cycle of Object.values(snapshot.cycles)) {
      const slot = cycle.slots[cycle.occupied];
      if (!slot) continue;
      const candidates = byDate.get(cycle.cycle)!;
      if (slot.status === 'available') {
        available++;
        assert.ok(
          candidates.some((c) => c.allowed),
          `seed=${seed}, case=${i}, cycle=${cycle.cycle}`,
        );
      } else if (slot.status === 'blocked') {
        blocked++;
        assert.ok(candidates.every((c) => c.completion.status === 'impossible'));
      }
    }
  }
  assert.ok(available > 0);
  assert.ok(blocked > 0);
});

test('propiedad: cachés frías y calientes conservan las pruebas y los límites', () => {
  for (const [i, state] of generatedStates().entries()) {
    resetOccupancyCaches();
    const cold = rules.availability(state, { maxChecks, exact: true });
    const partial = rules.partialAssessment(state, { maxChecks });
    const proof = rules.canComplete(state, { maxChecks, exact: true });
    const hot = rules.availability(state, { maxChecks, exact: true });
    assert.deepEqual(hot, cold, `seed=${seed}, case=${i}`);
    assert.deepEqual(rules.partialAssessment(state, { maxChecks }), partial);
    // Reusing a validated certificate may save checks or turn indeterminate
    // into possible. It must never invalidate a proof or certify an impossibility.
    const warmed = rules.canComplete(state, { maxChecks: 0, exact: true });
    if (proof.status === 'possible') {
      assert.equal(warmed.status, 'possible');
      assert.ok(rules.evaluateFinal({ ...state, awards: [...state.awards, ...warmed.witness!] }).valid);
    } else assert.notEqual(warmed.status, 'possible');
    resetOccupancyCaches();
    assert.deepEqual(rules.availability(state, { maxChecks, exact: true }), cold);
    assert.deepEqual(rules.partialAssessment(state, { maxChecks }), partial);
  }
});

test('un certificado caliente puede resolver indeterminate como possible; reset restaura la búsqueda fría', () => {
  const state = realThirds as PolicyState;
  resetOccupancyCaches();
  assert.equal(rules.canComplete(state, { maxChecks: 0, exact: true }).status, 'indeterminate');
  assert.equal(rules.canComplete(state, { maxChecks, exact: true }).status, 'possible');
  const warm = rules.canComplete(state, { maxChecks: 0, exact: true });
  assert.equal(warm.status, 'possible');
  assert.ok(rules.evaluateFinal({ ...state, awards: [...state.awards, ...warm.witness!] }).valid);
  resetOccupancyCaches();
  assert.equal(rules.canComplete(state, { maxChecks: 0, exact: true }).status, 'indeterminate');
});

test('las cachés congelan todo el resultado sin congelar las entradas; reset elimina ambas entradas', () => {
  const state = generatedStates().find((s) => rules.canComplete(s, { maxChecks }).status === 'possible')!;
  resetOccupancyCaches();
  const input = structuredClone(state);
  const partial = rules.partialAssessment(state, { maxChecks });
  const snapshot = rules.availability(state, { maxChecks });
  function assertFrozen(node: unknown): void {
    if (node === null || typeof node !== 'object') return;
    assert.ok(Object.isFrozen(node));
    for (const child of Object.values(node)) assertFrozen(child);
  }
  assertFrozen(partial);
  assertFrozen(snapshot);
  assert.throws(() => partial.warnings.push({ code: 'POISON', message: 'poison' }), TypeError);
  assert.throws(() => {
    partial.completion.status = 'impossible';
  }, TypeError);
  assert.throws(() => {
    snapshot.cycles.c0.slots[0].status = 'blocked';
  }, TypeError);
  assert.throws(() => snapshot.cycles.c0.slots[0].reasons.push({ code: 'POISON', message: 'poison' }), TypeError);
  if (partial.completion.witness?.length)
    assert.throws(() => {
      partial.completion.witness![0].member_id = 'poison';
    }, TypeError);
  assert.ok(!Object.isFrozen(state));
  assert.ok(state.awards.every((a) => !Object.isFrozen(a)));
  assert.deepEqual(state, input);
  assert.strictEqual(rules.partialAssessment(state, { maxChecks }), partial);
  assert.strictEqual(rules.availability(state, { maxChecks }), snapshot);
  resetOccupancyCaches();
  assert.notStrictEqual(rules.partialAssessment(state, { maxChecks }), partial);
  assert.notStrictEqual(rules.availability(state, { maxChecks }), snapshot);
});

test('la clave precalculada evita releer/serializar el estado en aciertos de ambas cachés', () => {
  const state = generatedStates()[1];
  resetOccupancyCaches();
  const stateKey = availabilityStateKey2027(state);
  const snapshot = rules.availability(state, { maxChecks });
  const partial = rules.partialAssessment(state, { maxChecks });
  const unreadable = new Proxy(state, {
    get() {
      throw new Error('state serialized again');
    },
  });
  assert.strictEqual(rules.availability(unreadable, { maxChecks, stateKey }), snapshot);
  assert.strictEqual(rules.partialAssessment(unreadable, { maxChecks, stateKey }), partial);
  resetOccupancyCaches();
  assert.deepEqual(rules.availability(state, { maxChecks, stateKey }), snapshot);
  assert.deepEqual(rules.partialAssessment(state, { maxChecks, stateKey }), partial);
});

test('la clave distingue todos los hechos normativos y las cachés separan presupuesto y modo exacto', () => {
  const state = generatedStates()[1];
  const key = availabilityStateKey2027(state);
  const changes = [
    { ...state, summerTotal: 0 },
    { ...state, cycles: state.cycles.map((c, i) => (i === 0 ? { ...c, maximum: 1 } : c)) },
    { ...state, cycles: state.cycles.map((c, i) => (i === 0 ? { ...c, fourthExcluded: !c.fourthExcluded } : c)) },
    { ...state, members: state.members.map((m, i) => (i === 0 ? { ...m, entitlement: 1 } : m)) },
    { ...state, awards: [...state.awards, { member_id: 'm0', cycle_date: 'c0' }] },
  ];
  for (const changed of changes) {
    assert.notEqual(availabilityStateKey2027(changed), key);
    resetOccupancyCaches();
    rules.availability(state, { maxChecks });
    rules.partialAssessment(state, { maxChecks });
    const hot = rules.availability(changed, { maxChecks });
    const hotPartial = rules.partialAssessment(changed, { maxChecks });
    resetOccupancyCaches();
    assert.deepEqual(rules.availability(changed, { maxChecks }), hot);
    assert.deepEqual(rules.partialAssessment(changed, { maxChecks }), hotPartial);
  }
  resetOccupancyCaches();
  const snapshot = rules.availability(state, { maxChecks });
  assert.notStrictEqual(rules.availability(state, { maxChecks: 0 }), snapshot);
  assert.notStrictEqual(rules.availability(state, { maxChecks, exact: true }), snapshot);
  const partial = rules.partialAssessment(state, { maxChecks });
  assert.notStrictEqual(rules.partialAssessment(state, { maxChecks: 0 }), partial);
});
