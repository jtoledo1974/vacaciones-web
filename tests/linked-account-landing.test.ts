import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Service, principal } from '../server/service.ts';
import { resolveLandingCampaign } from '../app/landing-campaign.ts';
import { SQLiteRepo } from './sqlite-repo.ts';

test('el correo ChatGPT vinculado por el administrador abre las vacaciones propias al iniciar sesión', async () => {
  const repo = new SQLiteRepo();
  const admin = new Service(repo, { id: 'chatgpt:admin', role: 'superadmin', teams: [] });
  await admin.init();
  const original = (await admin.list()).campaigns.find((campaign: any) =>
    campaign.scope_key === 'live' && campaign.team_id === 'B' && campaign.year === 2026);
  assert.ok(original);
  const campaign = await admin.view(original.id);
  await admin.election().mutate(original.id, {
    action: 'link_account',
    memberId: campaign.members[0].id,
    provider: 'chatgpt',
    subject: 'controlador@example.test',
    accountVersion: 0,
    version: campaign.campaign.version,
  });
  await admin.createCampaigns(2027, 2026);

  const identity = { provider: 'chatgpt' as const, subject: 'new-login-id',
    email: 'CONTROLADOR@EXAMPLE.TEST', emailVerified: true };
  const actor = await principal(repo, identity, '');
  const index = await new Service(repo, actor).list();
  const own2027 = index.campaigns.find((item: any) =>
    item.scope_key === 'live' && item.team_id === 'B' && item.year === 2027);
  assert.ok(own2027);
  assert.ok(index.myCampaignIds.includes(own2027.id));
  assert.deepEqual(resolveLandingCampaign(index, ''), { campaignId: own2027.id, year: 2027 });

  const unverified = await principal(repo, { ...identity, emailVerified: false }, '');
  const anonymousIndex = await new Service(repo, unverified).list();
  assert.deepEqual(anonymousIndex.myCampaignIds, []);
  assert.equal(resolveLandingCampaign(anonymousIndex, '').campaignId, null);
});
