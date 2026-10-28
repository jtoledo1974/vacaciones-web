import test from 'node:test';
import assert from 'node:assert/strict';
import { calculate } from '../domain/vacations.ts';
import { Service } from '../server/service.ts';
import { SQLiteRepo } from './sqlite-repo.ts';

const owner = { id: 'chatgpt:owner', role: 'superadmin' as const, teams: [] };
const anonymous = { id: null, role: 'viewer' as const, teams: [] };

/**
 * Freeze the public response contract. Every nested object in campaign,
 * members and result is checked: adding a field must trigger an explicit
 * privacy review instead of silently exposing a new database column.
 */
const scalar = true;
const campaignFields = {
  id: scalar,
  year: scalar,
  team_id: scalar,
  status: scalar,
  version: scalar,
  data_kind: scalar,
  scope_key: scalar,
  simulation_name: scalar,
};
const memberFields = { id: scalar, code: scalar };
const problemFields = {
  code: scalar,
  message: scalar,
  period: scalar,
  cycle: scalar,
  actual: scalar,
  limit: scalar,
  certainty: scalar,
  evidence: scalar,
};
const resultFields = {
  engineVersion: scalar,
  scoringVersion: scalar, // Public normative version only; no personal or saved-configuration data.
  occupancyPolicyVersion: scalar,
  cycles: [
    {
      date: scalar,
      end: scalar,
      score: scalar,
      period: scalar,
      correturnos: scalar,
      special: scalar,
      occupied: scalar,
      requested: scalar,
      min: scalar,
      base: scalar,
      max: scalar,
      available: scalar,
    },
  ],
  ordering: [],
  issues: [scalar],
  warnings: [scalar],
  policyWarnings: [problemFields],
  completionStatus: scalar,
  totals: {
    members: scalar,
    requested: scalar,
    awarded: scalar,
    necessary: scalar,
    base: scalar,
    conventionSummer: scalar,
    conventionWinter: scalar,
    usedSummer: scalar,
    counts: [scalar],
  },
};

function allowlisted(value: unknown, shape: unknown, path: string): void {
  if (shape === scalar) {
    assert.ok(value === null || typeof value !== 'object', path + ': se esperaba un valor escalar');
    return;
  }
  if (Array.isArray(shape)) {
    assert.ok(Array.isArray(value), path + ': se esperaba un array');
    if (shape.length === 0) assert.equal(value.length, 0, path + ': debe estar vacío');
    else value.forEach((entry, i) => allowlisted(entry, shape[0], path + '[' + i + ']'));
    return;
  }
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), path + ': se esperaba un objeto');
  const fields = shape as Record<string, unknown>;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    assert.ok(Object.hasOwn(fields, key), path + '.' + key + ': campo no incluido en la lista pública');
    allowlisted(child, fields[key], path + '.' + key);
  }
}
function checkPublic(view: { campaign: unknown; members: unknown; result: unknown }): void {
  allowlisted(view.campaign, campaignFields, 'campaign');
  allowlisted(view.members, [memberFields], 'members');
  allowlisted(view.result, resultFields, 'result');
}

async function setup() {
  const repo = new SQLiteRepo(),
    admin = new Service(repo, owner);
  await admin.init();
  const cid = (await admin.list()).campaigns.find((c: any) => c.team_id === 'C' && c.year === 2026).id as string;
  const viewer = new Service(repo, anonymous);
  return { repo, admin, viewer, cid };
}

test('la vista administrativa y la pública mantienen exactamente el contrato anterior', async () => {
  const { repo, admin, viewer, cid } = await setup();
  let state = await admin.view(cid);
  const memberId = state.members[0].id,
    date = state.result.cycles[0].date;
  state = await admin.mutate(cid, { action: 'request', version: state.campaign.version, memberId, slot: 1, date });
  state = await admin.mutate(cid, { action: 'award', version: state.campaign.version, memberId, date });
  const data = await admin.load(cid),
    current = await admin.view(cid);
  const entry = await admin.vacationUndo(cid, data.campaign.version);
  const legacyResult = calculate(
    data.campaign.year,
    data.campaign.team_id,
    data.config,
    data.members,
    data.requests,
    data.awards,
  );
  assert.deepEqual(current, {
    ...data,
    election: current.election,
    undo: entry && entry.action !== 'undo_vacations' ? { id: entry.id, action: entry.action } : null,
    redo: entry?.action === 'undo_vacations' ? { id: entry.id } : null,
    result: legacyResult,
    runs: data.runs.map((run: any) => ({ ...run, result_json: undefined })),
    editable: true,
    // Master dates are added beside the snapshot, read straight from people.
    masterSeniority: Object.fromEntries(
      (
        await repo.all(
          "SELECT m.id,p.seniority FROM campaign_members m JOIN people p ON p.id=m.person_id WHERE m.campaign_id=? AND p.seniority<>''",
          [cid],
        )
      ).map((p) => [p.id, p.seniority]),
    ),
  });

  const publicView = await viewer.view(cid);
  assert.deepEqual(publicView, {
    campaign: {
      id: cid,
      year: data.campaign.year,
      team_id: data.campaign.team_id,
      status: data.campaign.status,
      version: data.campaign.version,
      data_kind: data.campaign.data_kind,
      scope_key: data.campaign.scope_key,
      simulation_name: data.campaign.simulation_name,
    },
    members: data.members.map((member: any) => ({ id: member.id, code: member.code })),
    requests: [],
    awards: data.awards,
    result: { ...legacyResult, ordering: [] },
    config: null,
    runs: [],
    election: publicView.election,
    participating: !!publicView.election.myMemberId,
    editable: false,
    preview: undefined,
  });
  assert.deepEqual(
    Object.keys(publicView).sort(),
    [
      'campaign',
      'members',
      'requests',
      'awards',
      'result',
      'config',
      'runs',
      'election',
      'participating',
      'editable',
      'preview',
    ].sort(),
  );
  checkPublic(publicView);
});

test('la publicación conserva el snapshot anterior sin datos privados', async () => {
  const { repo, admin, viewer, cid } = await setup();
  let state = await admin.view(cid);
  const memberId = state.members[0].id,
    date = state.result.cycles[0].date;
  state = await admin.mutate(cid, { action: 'request', version: state.campaign.version, memberId, slot: 1, date });
  state = await admin.mutate(cid, { action: 'award', version: state.campaign.version, memberId, date });
  state = await admin.mutate(cid, { action: 'calculate', version: state.campaign.version });
  state = await admin.mutate(cid, { action: 'publish', version: state.campaign.version, runId: state.runs[0].id });
  const data = await admin.load(cid),
    published = await viewer.publishedView(cid);
  assert.ok(published);
  const [run] = await repo.all('SELECT result_json FROM runs WHERE id=? AND campaign_id=?', [
    data.campaign.published_run_id,
    cid,
  ]);
  const snapshot = JSON.parse(run.result_json);
  assert.deepEqual(published, {
    campaign: { id: cid, year: data.campaign.year, team_id: data.campaign.team_id, status: 'published' },
    members: snapshot.members.map((m: any) => ({ id: m.id, code: m.code })),
    awards: snapshot.awards,
    result: { ...snapshot.result, ordering: [] },
  });
  assert.deepEqual(Object.keys(published).sort(), ['campaign', 'members', 'awards', 'result'].sort());
  allowlisted(published.campaign, { id: scalar, year: scalar, team_id: scalar, status: scalar }, 'campaign publicada');
  allowlisted(published.members, [memberFields], 'members publicados');
  allowlisted(published.result, resultFields, 'result publicado');
});

test('la lista blanca cubre la proyección 2027 y detecta fugas recursivas', async () => {
  const { admin, viewer, cid: originalCid } = await setup();
  const originalPublic = await viewer.view(originalCid);
  await admin.createCampaigns(2027, null, null);
  const cid = (await admin.list()).campaigns.find((c: any) => c.year === 2027 && c.team_id === 'C').id;
  const publicView = await viewer.view(cid);
  checkPublic(publicView);
  assert.equal(publicView.result.occupancyPolicyVersion !== undefined, true);
  assert.throws(
    () => allowlisted({ ...publicView.campaign, privateSettings: {} }, campaignFields, 'campaign'),
    /campo no incluido/,
  );
  assert.throws(
    () => allowlisted([{ ...originalPublic.members[0], privatePreferences: [] }], [memberFields], 'members'),
    /campo no incluido/,
  );
  assert.throws(
    () => allowlisted({ ...publicView.result, privateScores: [] }, resultFields, 'result'),
    /campo no incluido/,
  );
  const first = publicView.result.cycles[0];
  assert.throws(
    () => allowlisted({ ...publicView.result, cycles: [{ ...first, privateNote: 'secreto' }] }, resultFields, 'result'),
    /campo no incluido/,
  );
});
