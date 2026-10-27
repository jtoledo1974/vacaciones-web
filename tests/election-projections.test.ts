import test from 'node:test';
import assert from 'node:assert/strict';
import { Service } from '../server/service.ts';
import {
  projectElectionViewForController,
  projectElectionViewForManager,
  type ElectionProjectionData,
} from '../server/projections.ts';
import { SQLiteRepo } from './sqlite-repo.ts';

const scalar = true;
type Shape = boolean | Shape[] | { [field: string]: Shape };

/** Recursive whitelist; '*' represents an arbitrary key with a fixed value schema. */
function allowlisted(value: unknown, shape: Shape, path = 'election'): void {
  if (value === null || value === undefined) return;
  if (shape === scalar) {
    assert.ok(typeof value !== 'object', path + ': valor no escalar');
    return;
  }
  if (Array.isArray(shape)) {
    assert.ok(Array.isArray(value), path + ': se esperaba una lista');
    for (const [index, entry] of value.entries()) allowlisted(entry, shape[0], path + '[' + index + ']');
    return;
  }
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), path + ': se esperaba un objeto');
  const fields = shape as Record<string, Shape>;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const rule = Object.hasOwn(fields, key) ? fields[key] : fields['*'];
    assert.notEqual(rule, undefined, path + '.' + key + ': campo fuera de la lista pública');
    allowlisted(entry, rule, path + '.' + key);
  }
}

const problem: Shape = {
  code: scalar,
  message: scalar,
  period: scalar,
  cycle: scalar,
  actual: scalar,
  limit: scalar,
  certainty: scalar,
  evidence: scalar,
};
const state: Shape = {
  status: scalar,
  order: [scalar],
  cursor: scalar,
  credits: { '*': scalar },
  automaticPaused: scalar,
  source: scalar,
  allowDeferral: scalar,
  policyVersion: scalar,
  tieGroups: [[scalar]],
  pendingTieGroups: [[scalar]],
  tieResolutions: [{ order: [scalar], method: scalar, at: scalar, actor: scalar, anticipated: scalar }],
  jointGroups: [[scalar]],
  jointAgreements: [
    {
      round: scalar,
      members: [scalar],
      actor: scalar,
      at: scalar,
      cancelledBy: scalar,
      cancelledAt: scalar,
    },
  ],
  turnSince: { cursor: scalar, at: scalar },
};
const snapshot: Shape = {
  policyVersion: scalar,
  status: scalar,
  checked: scalar,
  stateKey: scalar,
  cycles: {
    '*': {
      cycle: scalar,
      period: scalar,
      occupied: scalar,
      localMaximum: scalar,
      status: scalar,
      additional: scalar,
      provenAdditional: scalar,
      possibleAdditionalUpperBound: scalar,
      slots: [{ position: scalar, status: scalar, memberId: scalar, reasons: [problem] }],
    },
  },
};
const viewShape: Shape = {
  state,
  turn: {
    memberId: scalar,
    needed: scalar,
    round: scalar,
    pendingTie: [scalar],
    participants: [scalar],
    requiredByMember: { '*': scalar },
    canDefer: scalar,
  },
  preferences: [
    {
      member_id: scalar,
      dates: [scalar],
      automatic: scalar,
      persistent: scalar,
      active: scalar,
      mode: scalar,
      waitMinutes: scalar,
      labels: { '*': scalar },
    },
  ],
  preferenceMemberIds: [scalar],
  myMemberId: scalar,
  canManage: scalar,
  available: [scalar],
  availabilityPending: [scalar],
  availabilityReasons: { '*': scalar },
  availabilityWarnings: { '*': [problem] },
  cycleAvailability: snapshot,
  occupancyPolicyVersion: scalar,
  policyPresentation: {
    periodNames: [scalar],
    permits: { '*': { name: scalar, suffix: scalar } },
    impactEvents: {
      '*': {
        highlight: scalar,
        cycles: scalar,
        line: scalar,
        lineByPeriod: { '*': scalar },
      },
    },
    staticReasons: [scalar],
    ownRightsReason: scalar,
    explanationId: scalar,
  },
  points: [{ member_id: scalar, cycles: scalar, points: scalar }],
  accounts: [],
  undo: scalar,
  undoSummary: scalar,
  redo: scalar,
  pendingAutomatic: scalar,
  automaticAhead: scalar,
  listPlan: {
    memberId: scalar,
    mode: scalar,
    waitMinutes: scalar,
    deadline: scalar,
    paused: scalar,
    dates: [scalar],
  },
  queue: scalar,
  chain: scalar,
  timeline: [
    {
      id: scalar,
      kind: scalar,
      round: scalar,
      memberIds: [scalar],
      choices: [{ member_id: scalar, cycle_date: scalar }],
      deferredTurns: scalar,
      method: scalar,
      order: [scalar],
      automatic: scalar,
    },
  ],
  reconstruction: { active: scalar },
};

function fixture(): ElectionProjectionData {
  return {
    state: {
      status: 'active',
      order: ['alice', 'bob'],
      cursor: 0,
      credits: { alice: 1 },
      source: 'Fuente confidencial de las puntuaciones',
      allowDeferral: true,
      tieGroups: [['alice', 'bob']],
      pendingTieGroups: [],
      tieResolutions: [
        {
          order: ['alice', 'bob'],
          method: 'external',
          at: '2026-10-26T12:00:00Z',
          actor: 'admin-secreto',
          anticipated: true,
        },
      ],
      jointGroups: [['alice', 'bob']],
      jointAgreements: [
        {
          round: 2,
          members: ['alice', 'bob'],
          actor: 'autor-historico',
          at: '2026-10-26T12:00:00Z',
        },
      ],
      turnSince: { cursor: 0, at: '2026-10-26T12:00:00Z' },
    },
    turn: {
      memberId: 'alice',
      needed: 1,
      round: 1,
      pendingTie: null,
      participants: ['alice'],
      requiredByMember: { alice: 1 },
      canDefer: true,
    },
    preferences: [
      { member_id: 'alice', dates: ['2027-01-01'], automatic: true, labels: { '2027-01-01': 'Mi lista' } },
      { member_id: 'bob', dates: ['2027-02-01'], automatic: false, labels: { '2027-02-01': 'Otra lista privada' } },
    ],
    preferenceMemberIds: ['alice'],
    myMemberId: 'alice',
    available: ['2027-01-01'],
    availabilityPending: [],
    availabilityReasons: {},
    availabilityWarnings: {},
    cycleAvailability: null,
    occupancyPolicyVersion: null,
    policyPresentation: null,
    points: [{ member_id: 'alice', cycles: 0, points: 0 }],
    accounts: [{ principal_key: 'identidad-privada' }],
    undo: 'id-privado',
    undoSummary: null,
    redo: 'redo-privado',
    pendingAutomatic: false,
    automaticAhead: 0,
    listPlan: {
      memberId: 'alice',
      mode: 'immediate',
      waitMinutes: 0,
      deadline: null,
      paused: false,
      dates: ['2027-01-01'],
    },
    queue: null,
    chain: null,
    timeline: [
      {
        id: 'evento',
        kind: 'choice',
        round: 1,
        memberIds: ['alice'],
        choices: [{ member_id: 'alice', cycle_date: '2027-01-01' }],
        deferredTurns: 0,
        automatic: true,
      },
    ],
    reconstruction: { active: false },
  };
}

test('proyección pura: mantiene las claves existentes sin datos administrativos en la vista pública', () => {
  const data = fixture();
  const manager = projectElectionViewForManager(data);
  const controller = projectElectionViewForController(data);
  assert.deepEqual(manager.state, {
    ...data.state,
    source: data.state!.source,
    tieResolutions: data.state!.tieResolutions?.map((r) => ({ ...r, actor: r.actor })),
  });
  assert.equal(manager.canManage, true);
  assert.deepEqual(manager.accounts, data.accounts);
  assert.equal(manager.undo, 'id-privado');
  assert.deepEqual(manager.preferences, [data.preferences[0]]);
  assert.equal(controller.canManage, false);
  assert.deepEqual(controller.preferences, [data.preferences[0]]);
  assert.deepEqual(controller.accounts, []);
  assert.equal(controller.undo, null);
  assert.equal(controller.redo, null);
  assert.equal(controller.state!.source, undefined);
  assert.equal(controller.state!.tieResolutions![0].actor, undefined);
  assert.deepEqual(Object.keys(controller.state!).sort(), Object.keys(manager.state!).sort());
  assert.deepEqual(Object.keys(controller).sort(), Object.keys(manager).sort());
  // Actors of joint agreements were already visible: preserving them is explicit,
  // not an accidental spread of new state properties.
  assert.equal(controller.state!.jointAgreements?.[0].actor, 'autor-historico');
  allowlisted(controller, viewShape);
});

test('la proyección del controlador bloquea campos añadidos en profundidad', () => {
  const data = fixture();
  const poisoned = {
    ...data,
    state: {
      ...data.state!,
      privateFutureState: 'no-publicar',
      tieResolutions: [{ ...data.state!.tieResolutions![0], secretToken: 'secreto' }],
      jointAgreements: [{ ...data.state!.jointAgreements![0], secretToken: 'secreto' }],
    },
    preferences: [{ ...data.preferences[0], privateFuturePreference: 'no-publicar' }, data.preferences[1]],
    timeline: [{ ...data.timeline[0], privateAudit: 'no-publicar' }],
  } as ElectionProjectionData;
  const publicView = projectElectionViewForController(poisoned);
  allowlisted(publicView, viewShape);
  assert.ok(!JSON.stringify(publicView).includes('no-publicar'));
  assert.ok(!JSON.stringify(publicView).includes('secretToken'));
  assert.ok(!JSON.stringify(publicView).includes('Otra lista privada'));
  assert.throws(() => allowlisted({ ...publicView, privateAudit: true }, viewShape), /campo fuera de la lista pública/);
  assert.throws(
    () => allowlisted({ ...publicView, state: { ...publicView.state, privateAudit: 1 } }, viewShape),
    /campo fuera de la lista pública/,
  );
});

const owner = { id: 'chatgpt:owner', role: 'superadmin' as const, teams: [] };
const linked = {
  id: 'chatgpt:alice',
  emailKey: 'chatgpt-email:alice@example.test',
  role: 'viewer' as const,
  teams: [],
};

test('integración: anónimo, titular y responsable conservan visibilidad de preferencias', async () => {
  const repo = new SQLiteRepo(),
    admin = new Service(repo, owner);
  await admin.init();
  const cid = (await admin.list()).campaigns.find((campaign) => campaign.team_id === 'C' && campaign.year === 2026)!.id;
  const viewer = new Service(repo, { id: null, role: 'viewer' as const, teams: [] }),
    person = new Service(repo, linked);
  const empty = await viewer.view(cid);
  allowlisted(empty.election, viewShape);
  assert.equal(empty.election.state, null);
  let current = await admin.view(cid);
  current = await admin.mutate(cid, {
    action: 'import_roster',
    version: current.campaign.version,
    source: {
      format: 'vacaciones-roster-v1',
      team: 'C',
      year: 2026,
      copySelections: false,
      rows: [
        { code: 'AA', label: 'A', seniority: '' },
        { code: 'BB', label: 'B', seniority: '' },
        { code: 'CC', label: 'C', seniority: '' },
      ],
    },
  });
  current = await admin.mutate(cid, {
    action: 'config',
    version: current.campaign.version,
    config: {
      ...current.config,
      previousScores: { AA: 10, BB: 20, CC: 30 },
      previousScoresSource: 'Orden ficticio de pruebas validado',
    },
  });
  const [a, b] = current.members;
  const dates = current.result.cycles.map((cycle) => cycle.date);
  const execute = async (action: Record<string, unknown>) =>
    admin.election().mutate(cid, { ...action, version: (await admin.load(cid)).campaign.version });
  await execute({ action: 'preferences', memberId: a.id, dates: [dates[0]] });
  await execute({ action: 'preferences', memberId: b.id, dates: [dates[1]] });
  await execute({ action: 'link_account', memberId: a.id, subject: 'alice@example.test', accountVersion: 0 });
  await execute({ action: 'start', rulesConfirmed: true, allowDeferral: true });
  const manager = (await admin.view(cid)).election;
  const mine = (await person.view(cid)).election;
  const publicView = (await viewer.view(cid)).election;
  assert.equal(manager.canManage, true);
  assert.equal(manager.preferences.length, 2);
  assert.equal(mine.myMemberId, a.id);
  assert.deepEqual(
    mine.preferences.map((p) => p.member_id),
    [a.id],
  );
  assert.deepEqual(publicView.preferences, []);
  assert.equal(publicView.myMemberId, null);
  assert.equal(mine.state?.source, undefined);
  assert.equal(publicView.state?.source, undefined);
  assert.notEqual(manager.state?.source, undefined);
  allowlisted(mine, viewShape);
  allowlisted(publicView, viewShape);
  // Stable keys, including keys with undefined values, are required by clients.
  assert.deepEqual(Object.keys(mine).sort(), Object.keys(manager).sort());
});

test('integración: la vista de 2027 mantiene el esquema público de disponibilidad y normativa', async () => {
  const repo = new SQLiteRepo(),
    admin = new Service(repo, owner);
  await admin.init();
  await admin.createCampaigns(2027, null, null);
  const cid = (await admin.list()).campaigns.find((campaign) => campaign.team_id === 'C' && campaign.year === 2027)!.id;
  const view = await new Service(repo, { id: null, role: 'viewer' as const, teams: [] }).view(cid);
  assert.ok(view.election.cycleAvailability);
  assert.ok(view.election.policyPresentation);
  allowlisted(view.election, viewShape);
});
