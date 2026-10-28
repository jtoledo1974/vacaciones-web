import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importRoster } from './import-helper.ts';
import { Service } from '../server/service.ts';
import { SQLiteRepo } from './sqlite-repo.ts';

const owner = { id: 'chatgpt:owner', role: 'superadmin' as const, teams: [] };

test('pending automatic steps end once immediate lists have chosen early, though the view conceals them', async () => {
  const s = new Service(new SQLiteRepo(), owner);
  await s.init();
  const cid = (await s.list()).campaigns.find(
    (c: { team_id: string; year: number }) => c.team_id === 'C' && c.year === 2026,
  ).id;
  let d = await s.view(cid);
  d = await importRoster(s, cid, {
    action: 'import_roster',
    version: d.campaign.version,
    source: {
      format: 'vacaciones-roster-v1',
      team: 'C',
      year: 2026,
      copySelections: false,
      rows: ['QA_A', 'QA_B', 'QA_C', 'QA_D'].map((code) => ({ code, label: code, seniority: '' })),
    },
  });
  d = await s.mutate(cid, {
    action: 'config',
    version: d.campaign.version,
    config: {
      ...d.config,
      previousScores: { QA_A: 10, QA_B: 20, QA_C: 30, QA_D: 40 },
      previousScoresSource: 'Puntuaciones de ensayo verificadas',
    },
  });
  const dates = d.result.cycles.map((c: { date: string }) => c.date);
  // As the HTTP route does: write, then answer with the (concealed) view.
  const election = async (body: object) => {
    await s.election().mutate(cid, { ...body, version: (await s.load(cid)).campaign.version });
    return s.view(cid, { skipAvailabilityForPendingAutomatic: true });
  };
  // QA_A chooses by hand; QA_B and QA_C, ahead of QA_D, keep immediate lists.
  for (const person of [1, 2])
    await election({
      action: 'preferences',
      memberId: d.members[person].id,
      dates: [dates[person + 4]],
      persistent: true,
    });
  let next = await election({ action: 'start', rulesConfirmed: true, allowDeferral: true });
  let steps = 0;
  for (; steps < 10 && next.election.pendingAutomatic; steps++) next = await election({ action: 'advance' });
  assert.equal(steps, 2, 'one early choice per list, then nothing left to advance');
  assert.equal((await s.load(cid)).awards.length, 2);
});
