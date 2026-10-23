import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveLandingCampaign, type LandingIndex } from '../app/landing-campaign.ts';

const index: LandingIndex = {
  campaigns: [
    { id: 'a26', team_id: 'A', year: 2026, scope_key: 'live' },
    { id: 'b26', team_id: 'B', year: 2026, scope_key: 'live' },
    { id: 'a27', team_id: 'A', year: 2027, scope_key: 'live' },
    { id: 'b27', team_id: 'B', year: 2027, scope_key: 'live' },
    { id: 'c27', team_id: 'C', year: 2027, scope_key: 'live' },
    { id: 'sim27', team_id: 'B', year: 2027, scope_key: 'simulation' },
  ],
  myCampaignIds: ['b26', 'b27'],
};

test('el controlador vinculado entra directamente en las vacaciones de su equipo y último año', () => {
  assert.deepEqual(resolveLandingCampaign(index, ''), { campaignId: 'b27', year: 2027 });
  assert.deepEqual(resolveLandingCampaign(index, '?year=2026'), { campaignId: 'b26', year: 2026 });
});

test('un enlace compartido a otro equipo tiene prioridad y deja cambiar de equipo', () => {
  assert.deepEqual(resolveLandingCampaign(index, '?equipo=A&year=2027'), { campaignId: 'a27', year: 2027 });
  assert.deepEqual(resolveLandingCampaign(index, '?equipo=A'), { campaignId: 'a27', year: 2027 });
  assert.deepEqual(resolveLandingCampaign(index, '?equipo=B&year=2027&escenario=sim27'), { campaignId: 'sim27', year: 2027 });
});

test('no se fuerza ningún equipo si no hay vinculación o no existe para el ejercicio solicitado', () => {
  assert.deepEqual(resolveLandingCampaign({ ...index, myCampaignIds: [] }, ''), { campaignId: null, year: 2027 });
  assert.deepEqual(resolveLandingCampaign(index, '?year=2028'), { campaignId: null, year: 2028 });
  assert.deepEqual(resolveLandingCampaign(index, '?equipo='), { campaignId: null, year: 2027 });
});

test('se evita elegir arbitrariamente si el usuario figura en dos equipos el mismo año', () => {
  assert.deepEqual(resolveLandingCampaign({ ...index, myCampaignIds: ['a27', 'b27'] }, ''), { campaignId: null, year: 2027 });
  assert.deepEqual(resolveLandingCampaign({ ...index, myCampaignIds: ['b26', 'c27'] }, ''), { campaignId: 'c27', year: 2027 });
});

test('las simulaciones no se usan como destino automático', () => {
  assert.deepEqual(resolveLandingCampaign({ ...index, myCampaignIds: ['sim27'] }, ''), { campaignId: null, year: 2027 });
  assert.deepEqual(resolveLandingCampaign(index, '?escenario=sim27'), { campaignId: null, year: 2027 });
});
