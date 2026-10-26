import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  nextSlot,
  turnsBefore,
  peopleAhead,
  turnsUntil,
  orderForRound,
  type SequenceInput,
} from '../domain/sequence.ts';
import {
  currentTurn,
  entitlementFor,
  validateElectionState,
  upgradeElectionState,
  withLiveEarlyChoices,
  ELECTION_STATE_FORMAT,
  type ElectionContext,
  type ElectionState,
} from '../domain/election.ts';
import { occupancyFor } from '../domain/policy.ts';
import { defaultConfig } from '../domain/defaults.ts';

const base = (over: Partial<ElectionState> = {}): ElectionState => ({
  status: 'active',
  order: ['A', 'B', 'C'],
  cursor: 0,
  credits: {},
  source: 'test',
  allowDeferral: true,
  ...over,
});
const awards = (counts: Record<string, number>) =>
  Object.entries(counts).flatMap(([id, n]) => Array.from({ length: n }, () => ({ member_id: id })));
const seq = (
  state: ElectionState,
  entitlements: Record<string, number>,
  counts: Record<string, number> = {},
): SequenceInput => ({
  state,
  awards: awards(counts),
  entitlement: (id) => entitlements[id],
  maxRounds: Math.max(...Object.values(entitlements)) + 4,
});
const who = (slots: { participants: string[]; pendingTie?: string[] }[] | null) =>
  slots?.map((s) => (s.pendingTie ? '?' + s.pendingTie.join('') : s.participants.join('+'))) ?? null;

test('derechos individuales distintos: quien ha terminado no ocupa hueco', () => {
  const entitlements = { A: 1, B: 2, C: 2 },
    counts = { A: 1, B: 1, C: 1 },
    state = base({ cursor: 3 });
  assert.deepEqual(nextSlot(seq(state, entitlements, counts)), {
    cursor: 4,
    round: 2,
    participants: ['B'],
    requiredByMember: { B: 1 },
  });
  assert.deepEqual(who(turnsBefore(seq(state, entitlements, counts), 'C')), ['B']);
  assert.equal(turnsBefore(seq(state, entitlements, counts), 'A'), null);
  // A partir de la ronda 2, solo B y C: C va delante de B en la ronda 3.
  assert.deepEqual(who(turnsBefore(seq(base({ cursor: 5 }), { A: 1, B: 3, C: 3 }, { A: 1, B: 1, C: 1 }), 'B')), ['C']);
  assert.deepEqual(who(turnsBefore(seq(base({ cursor: 5 }), { A: 1, B: 3, C: 3 }, { A: 1, B: 2, C: 1 }), 'B')), ['C']);
});

test('créditos dobles y triples, limitados a lo que queda', () => {
  const entitlements = { A: 4, B: 4, C: 4 };
  assert.deepEqual(nextSlot(seq(base({ credits: { A: 1 } }), entitlements)), {
    cursor: 0,
    round: 1,
    participants: ['A'],
    requiredByMember: { A: 2 },
  });
  assert.deepEqual(nextSlot(seq(base({ credits: { A: 2 } }), entitlements)), {
    cursor: 0,
    round: 1,
    participants: ['A'],
    requiredByMember: { A: 3 },
  });
  assert.deepEqual(nextSlot(seq(base({ credits: { A: 2 } }), entitlements, { A: 3 })), {
    cursor: 0,
    round: 1,
    participants: ['A'],
    requiredByMember: { A: 1 },
  });
  // A gasta sus dos créditos y termina en su primer hueco: no vuelve a aparecer delante de C.
  const slots = turnsBefore(seq(base({ cursor: 2, credits: { A: 2 } }), { A: 3, B: 1, C: 2 }, { B: 1, C: 1 }), 'B');
  assert.equal(slots, null);
  const ahead = turnsBefore(seq(base({ cursor: 1, credits: { A: 2 } }), { A: 3, B: 2, C: 3 }), 'C');
  assert.deepEqual(who(ahead), ['B']);
  const later = turnsBefore(seq(base({ cursor: 0, credits: { A: 2 } }), { A: 3, B: 2, C: 3 }, { C: 1 }), 'A');
  assert.deepEqual(later, []);
  const afterA = turnsBefore(seq(base({ cursor: 1, credits: { A: 2 } }), { A: 3, B: 2, C: 3 }, { A: 0, C: 3 }), 'A');
  assert.deepEqual(who(afterA), ['B']);
  assert.deepEqual(
    afterA!.map((s) => s.round),
    [1],
  );
});

test('turnos conjuntos: un único hueco con varias personas, en la posición del último', () => {
  const entitlements = { A: 2, B: 2, C: 2, D: 2 };
  const state = base({ order: ['A', 'B', 'C', 'D'], jointGroups: [['A', 'C']] });
  assert.deepEqual(nextSlot(seq(state, entitlements)), {
    cursor: 1,
    round: 1,
    participants: ['B'],
    requiredByMember: { B: 1 },
  });
  assert.deepEqual(nextSlot(seq({ ...state, cursor: 2, credits: { C: 1 } }, entitlements)), {
    cursor: 2,
    round: 1,
    participants: ['A', 'C'],
    requiredByMember: { A: 1, C: 2 },
  });
  assert.deepEqual(who(turnsBefore(seq(state, entitlements), 'D')), ['B', 'A+C']);
  assert.deepEqual(turnsBefore(seq(state, entitlements), 'A')!.length, 1);
  // Un acuerdo vale solo para su ronda.
  const agreed = base({
    order: ['A', 'B', 'C', 'D'],
    cursor: 2,
    jointAgreements: [{ round: 2, members: ['B', 'D'], actor: 'x', at: 't' }],
  });
  assert.deepEqual(who(turnsBefore(seq(agreed, entitlements), 'C')), []);
  // En la ronda 2, B elige junto a D, en la posición de D: C va antes.
  assert.deepEqual(who(turnsBefore(seq(agreed, entitlements), 'B')), ['C', 'D', 'A', 'C']);
  assert.deepEqual(who(turnsBefore(seq({ ...agreed, cursor: 4 }, entitlements), 'D')), ['A', 'C']);
  // Quien ya terminó no participa en el turno conjunto.
  assert.deepEqual(nextSlot(seq({ ...state, cursor: 2 }, entitlements, { A: 2 })), {
    cursor: 2,
    round: 1,
    participants: ['C'],
    requiredByMember: { C: 1 },
  });
});

test('empates pendientes: bloquean el hueco y cortan la secuencia', () => {
  const entitlements = { A: 2, B: 2, C: 2, D: 2 };
  const state = base({ order: ['A', 'B', 'C', 'D'], tieGroups: [['B', 'C']], pendingTieGroups: [['B', 'C']] });
  assert.deepEqual(nextSlot(seq({ ...state, cursor: 1 }, entitlements)), {
    cursor: 1,
    round: 1,
    participants: [],
    requiredByMember: {},
    pendingTie: ['B', 'C'],
  });
  assert.deepEqual(who(turnsBefore(seq(state, entitlements), 'D')), ['A', '?BC']);
  assert.deepEqual(who(turnsBefore(seq(state, entitlements), 'C')), ['A', '?BC']);
  assert.deepEqual(turnsBefore(seq(state, entitlements), 'A'), []);
  // Si los empatados ya han terminado, el empate no detiene a nadie.
  assert.deepEqual(who(turnsBefore(seq(state, entitlements, { B: 2, C: 2 }), 'D')), ['A']);
});

test('cambio de ronda: la ronda no es frontera y los empates resueltos rotan', () => {
  const entitlements = { A: 3, B: 3, C: 3 };
  const ahead = turnsBefore(seq(base({ cursor: 2 }), entitlements), 'B');
  assert.deepEqual(who(ahead), ['C', 'A']);
  assert.deepEqual(
    ahead!.map((s) => [s.cursor, s.round]),
    [
      [2, 1],
      [3, 2],
    ],
  );
  const tied = base({ cursor: 2, tieGroups: [['A', 'B']] });
  assert.deepEqual(orderForRound(tied, 1), ['B', 'A', 'C']);
  assert.deepEqual(who(turnsBefore(seq(tied, entitlements), 'A')), ['C', 'B']);
});

test('miembros terminados: elección completa, o quien ya no vuelve a elegir', () => {
  const entitlements = { A: 2, B: 2, C: 2 };
  assert.deepEqual(nextSlot(seq(base({ cursor: 5 }), entitlements, { A: 2, B: 2, C: 2 })), { complete: true });
  assert.equal(turnsBefore(seq(base({ cursor: 5 }), entitlements, { A: 2, B: 2, C: 2 }), 'A'), null);
  assert.equal(turnsBefore(seq(base(), entitlements, { B: 2 }), 'B'), null);
  assert.deepEqual(who(turnsBefore(seq(base(), entitlements, { B: 2 }), 'C')), ['A']);
  assert.throws(() => nextSlot({ ...seq(base(), entitlements), maxRounds: 0 }), /No se ha podido avanzar/);
});

test('peopleAhead y turnsUntil siguen a turnsBefore: derechos, créditos, conjuntos y empates', () => {
  const state = base({
    order: ['A', 'B', 'C', 'D'],
    jointGroups: [['A', 'B']],
    tieGroups: [['C', 'D']],
    pendingTieGroups: [['C', 'D']],
  });
  const four = { A: 2, B: 2, C: 2, D: 2 };
  // El turno conjunto es uno con dos personas, y el empate pendiente corta la cuenta.
  assert.deepEqual(peopleAhead(seq(state, four), 'D'), ['A', 'B', 'C', 'D']);
  assert.equal(turnsUntil(seq(state, four), 'D'), 2);
  // Derecho individual: A tenía uno solo y ya lo eligió, así que no ocupa hueco en la ronda 2.
  assert.deepEqual(peopleAhead(seq(base({ cursor: 3 }), { A: 1, B: 2, C: 2 }, { A: 1, B: 1, C: 1 }), 'C'), ['B']);
  assert.equal(turnsUntil(seq(base({ cursor: 3 }), { A: 1, B: 2, C: 2 }, { A: 1, B: 1, C: 1 }), 'C'), 1);
  // Créditos doble y triple: A recupera de una vez sus turnos aplazados y deja de aparecer antes.
  for (const credit of [1, 2]) {
    const entitlements = { A: 3, B: 3, C: 3 };
    const ahead = peopleAhead(seq(base({ cursor: 0, credits: { A: credit } }), entitlements), 'A');
    assert.deepEqual(ahead, []);
    const later = peopleAhead(seq(base({ cursor: 1, credits: { A: credit } }), entitlements), 'A');
    assert.deepEqual(later, ['B', 'C']);
    // Si A elige 1 + crédito ciclos en la ronda 2, en la ronda 3 solo le queda lo que falte.
    const third = peopleAhead(seq(base({ cursor: 4 }), entitlements, { A: 1 + credit, B: 1, C: 1 }), 'A');
    assert.deepEqual(third, credit === 2 ? null : ['B', 'C']);
  }
  assert.equal(peopleAhead(seq(base(), { A: 2, B: 2, C: 2 }), 'Z'), null);
  assert.equal(turnsUntil(seq(base(), { A: 2, B: 2, C: 2 }, { C: 2 }), 'C'), null);
});

const early = (memberId: string, cursor: number, awardId = 'early-' + memberId + cursor, n = 3) => ({
  memberId,
  round: Math.floor(cursor / n) + 1,
  cursor,
  awardId,
  at: '2027-01-10T10:00:00Z',
});

test('earlyChoices: el hueco elegido por adelantado cuenta como jugado', () => {
  const entitlements = { A: 2, B: 2, C: 2 };
  // B eligió por adelantado el ciclo de su hueco de la ronda 1 (cursor 1): ese hueco se salta.
  const state = base({ earlyChoices: [early('B', 1)] });
  assert.deepEqual(nextSlot(seq({ ...state, cursor: 1 }, entitlements, { A: 1, B: 1 })), {
    cursor: 2,
    round: 1,
    participants: ['C'],
    requiredByMember: { C: 1 },
  });
  // Sin la entrada, se le volvería a pedir esa elección en su posición.
  assert.deepEqual(nextSlot(seq(base({ cursor: 1 }), entitlements, { A: 1, B: 1 })).participants, ['B']);
  // En la ronda 2 B vuelve a elegir con normalidad.
  assert.deepEqual(nextSlot(seq({ ...state, cursor: 4 }, entitlements, { A: 2, B: 1, C: 1 })).participants, ['B']);
  assert.deepEqual(who(turnsBefore(seq(state, entitlements, { B: 1 }), 'C')), ['A']);
});

test('earlyChoices con créditos descuenta needed en lugar de saltar el hueco', () => {
  const entitlements = { A: 3, B: 3, C: 3 };
  // B aplazó una vez (crédito 1) y adelantó uno de los dos ciclos que le tocan en el cursor 4.
  const state = base({ cursor: 4, credits: { B: 1 }, earlyChoices: [early('B', 4)] });
  assert.deepEqual(nextSlot(seq(state, entitlements, { A: 2, B: 1, C: 1 })), {
    cursor: 4,
    round: 2,
    participants: ['B'],
    requiredByMember: { B: 1 },
  });
  // Con dos adelantados no queda nada que pedirle en ese hueco.
  const both = { ...state, earlyChoices: [early('B', 4, 'x'), early('B', 4, 'y')] };
  assert.deepEqual(nextSlot(seq(both, entitlements, { A: 2, B: 2, C: 1 })).participants, ['C']);
});

test('earlyChoices en un turno conjunto: quien ya eligió sale del grupo', () => {
  const entitlements = { A: 2, B: 2, C: 2 },
    state = base({ jointGroups: [['A', 'B']], earlyChoices: [early('A', 1)] });
  // El turno conjunto se juega en el hueco de B (cursor 1), donde cuenta lo adelantado por A.
  assert.deepEqual(nextSlot(seq(state, entitlements, { A: 1 })), {
    cursor: 1,
    round: 1,
    participants: ['B'],
    requiredByMember: { B: 1 },
  });
});

test('validateElectionState revisa earlyChoices y el formato', () => {
  const members = ['A', 'B', 'C'].map((id) => ({ id })) as any;
  validateElectionState(base({ earlyChoices: [early('B', 4)], format: 1 }), members);
  for (const bad of [
    [early('Z', 1)],
    [{ ...early('B', 4), round: 1 }],
    [{ ...early('B', 4), awardId: '' }],
    [{ ...early('B', 4), at: 'ayer' }],
    [early('B', 1, 'x'), early('C', 2, 'x')],
    {},
  ])
    assert.throws(
      () => validateElectionState(base({ earlyChoices: bad as any }), members),
      /Elecciones anticipadas no válidas/,
    );
  assert.throws(() => validateElectionState(base({ format: 2 }), members), /Formato/);
});

test('upgradeElectionState lee como versión 1 los estados guardados sin formato', () => {
  // Un estado de election_states anterior a esta versión, tal cual se guardaba.
  const legacy = JSON.parse(
    '{"status":"active","order":["A","B","C"],"cursor":4,"credits":{"B":1},"source":"sorteo","allowDeferral":true,' +
      '"tieGroups":[["B","C"]],"turnSince":{"cursor":4,"at":"2027-01-10T10:00:00.000Z"}}',
  );
  const upgraded = upgradeElectionState(legacy)!;
  assert.equal(upgraded.format, ELECTION_STATE_FORMAT);
  assert.deepEqual({ ...upgraded, format: undefined }, { ...legacy, format: undefined });
  assert.equal(upgradeElectionState(null), null);
  assert.equal(upgradeElectionState(undefined), null);
  assert.deepEqual(upgradeElectionState(upgraded), upgraded);
  assert.throws(() => upgradeElectionState({ ...legacy, format: 99 }), /no admitido/);
  // Un snapshot de audit (election-undo-v1) guarda el estado con la misma forma.
  const members = ['A', 'B', 'C'].map((id) => ({ id })) as any;
  validateElectionState(upgraded, members);
});

test('withLiveEarlyChoices quita las entradas cuya adjudicación ya no existe', () => {
  const state = base({ earlyChoices: [early('B', 1, 'a1'), early('C', 2, 'a2')] });
  assert.deepEqual(
    withLiveEarlyChoices(state, [{ id: 'a2' }]).earlyChoices!.map((e) => e.awardId),
    ['a2'],
  );
  assert.equal(withLiveEarlyChoices(base(), []).earlyChoices, undefined);
});

// The scan of currentTurn as it was before domain/sequence.ts, verbatim.
function legacyCurrentTurn(ctx: ElectionContext, input: ElectionState) {
  const count = (id: string) => ctx.awards.filter((a) => a.member_id === id).length;
  const state = structuredClone(input);
  validateElectionState(state, ctx.members);
  const n = state.order.length;
  const round = Math.floor(state.cursor / n) + 1;
  if (state.status !== 'active')
    return {
      state,
      memberId: null,
      needed: 0,
      round,
      participants: [] as string[],
      requiredByMember: {} as Record<string, number>,
    };
  if (ctx.members.every((m) => count(m.id) >= entitlementFor(ctx, m.id))) {
    const rules = occupancyFor(ctx.year);
    if (rules) {
      const evaluation = rules.evaluateFinal(rules.state(ctx, ctx.members, ctx.awards));
      if (!evaluation.valid)
        throw new Error('No se puede finalizar la elección: ' + evaluation.issues.map((i) => i.message).join('; '));
    }
    state.status = 'complete';
    return {
      state,
      memberId: null,
      needed: 0,
      round,
      participants: [] as string[],
      requiredByMember: {} as Record<string, number>,
    };
  }
  for (let scanned = 0; scanned < n * (ctx.config.cyclesPerPerson + 4); scanned++) {
    const currentRound = Math.floor(state.cursor / n);
    const inRound = orderForRound(state, currentRound),
      id = inRound[state.cursor % n];
    const remaining = entitlementFor(ctx, id) - count(id);
    if (remaining === 0) {
      state.cursor++;
      continue;
    }
    const pendingTie = (state.pendingTieGroups ?? []).find((group) => group.includes(id));
    if (pendingTie)
      return {
        state,
        memberId: null,
        needed: 0,
        round: currentRound + 1,
        participants: [] as string[],
        requiredByMember: {} as Record<string, number>,
        pendingTie,
      };
    const joint = [
      ...(state.jointGroups ?? []),
      ...(state.jointAgreements ?? [])
        .filter((a) => !a.cancelledAt && a.round === currentRound + 1)
        .map((a) => a.members),
    ].find((g) => g.includes(id));
    const participants = joint
      ? inRound.filter((person) => joint.includes(person) && count(person) < entitlementFor(ctx, person))
      : [id];
    if (participants[participants.length - 1] !== id) {
      state.cursor++;
      continue;
    }
    const requiredByMember = Object.fromEntries(
      participants.map((person) => [
        person,
        Math.min(1 + (state.credits[person] ?? 0), entitlementFor(ctx, person) - count(person)),
      ]),
    );
    return {
      state,
      memberId: id,
      needed: Object.values(requiredByMember).reduce((a, b) => a + b, 0),
      round: currentRound + 1,
      participants,
      requiredByMember,
    };
  }
  throw new Error('No se ha podido avanzar la elección');
}

function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const outcome = (run: () => unknown) => {
  try {
    return { ok: run() };
  } catch (error) {
    return { error: (error as Error).message };
  }
};

test('currentTurn equivale al escaneo anterior en estados aleatorios', () => {
  const random = mulberry32(103),
    int = (max: number) => Math.floor(random() * (max + 1));
  const pick = <T>(items: T[]) => items[int(items.length - 1)];
  let compared = 0,
    slots = 0,
    ties = 0,
    joints = 0;
  for (let i = 0; i < 3000; i++) {
    const n = 2 + int(4),
      cycles = 2 + int(2),
      year = pick([2026, 2027]);
    const ids = Array.from({ length: n }, (_, k) => 'm' + k);
    const individual =
      year === 2027
        ? Object.fromEntries(
            ids.filter(() => random() < 0.4).map((id) => [id, { cycles: int(cycles + 1), authorization: 'test' }]),
          )
        : undefined;
    const config = {
      ...defaultConfig(year),
      cyclesPerPerson: cycles,
      ...(individual ? { individualEntitlements: individual } : {}),
    };
    const members = ids.map((id) => ({ id, code: id, seniority: '' }));
    const ctx: ElectionContext = { year, team: 'C', config, members, requests: [], awards: [] };
    const order = [...ids].sort(() => random() - 0.5);
    ctx.awards = ids.flatMap((id) =>
      Array.from({ length: int(entitlementFor(ctx, id)) }, (_, k) => ({
        id: id + k,
        member_id: id,
        cycle_date: '2027-0' + (k + 1) + '-01',
      })),
    );
    const state: ElectionState = {
      status: random() < 0.9 ? 'active' : 'paused',
      order,
      cursor: int(n * (cycles + 1)),
      credits: Object.fromEntries(ids.filter(() => random() < 0.3).map((id) => [id, int(2)])),
      source: 'test',
      allowDeferral: true,
    };
    if (n >= 3 && random() < 0.4) {
      const first = int(n - 2),
        size = 2 + int(Math.min(2, n - first - 2));
      const group = order.slice(first, first + size);
      state.tieGroups = [group];
      if (random() < 0.4) state.pendingTieGroups = [group];
    }
    if (random() < 0.4) {
      const group = [...ids].sort(() => random() - 0.5).slice(0, 2 + int(Math.min(1, n - 2)));
      state.jointGroups = [group];
    }
    if (random() < 0.3) {
      const used = new Set(state.jointGroups?.flat()),
        free = ids.filter((id) => !used.has(id));
      if (free.length >= 2)
        state.jointAgreements = [
          {
            round: 1 + int(cycles),
            members: free.slice(0, 2),
            actor: 'x',
            at: 't',
            ...(random() < 0.2 ? { cancelledAt: 't', cancelledBy: 'x' } : {}),
          },
        ];
    }
    const before = outcome(() => legacyCurrentTurn(ctx, state)),
      after = outcome(() => currentTurn(ctx, state));
    assert.deepEqual(
      after,
      before,
      JSON.stringify({ year, config: { cycles, individual }, state, awards: ctx.awards.length }),
    );
    compared++;
    const value = (before as any).ok;
    if (value?.memberId) slots++;
    if (value?.pendingTie) ties++;
    if (value?.participants?.length > 1) joints++;
  }
  // The sample does cover each branch of the scan.
  assert.equal(compared, 3000);
  assert.ok(slots > 500 && ties > 50 && joints > 50, JSON.stringify({ slots, ties, joints }));
});
