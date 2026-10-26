import { strict as assert } from 'node:assert';
import test from 'node:test';
import { requiresAccountLinkNotice, type CampaignAccessContext } from '../app/campaign-access-state.ts';

const linked: CampaignAccessContext = {
  sessionLoaded: true,
  authenticated: true,
  isLive: true,
  canManage: false,
  hasMember: true,
  inPreview: false,
};

test('el controlador vinculado entra en la campaña sin aviso de acceso', () => {
  assert.equal(requiresAccountLinkNotice(linked), false);
});

test('la cuenta ChatGPT autenticada sin controlador requiere una decisión explícita', () => {
  assert.equal(requiresAccountLinkNotice({ ...linked, hasMember: false }), true);
});

test('la consulta anónima, los administradores, las simulaciones y las vistas previas no muestran el aviso', () => {
  for (const fields of [
    { authenticated: false, hasMember: false },
    { sessionLoaded: false, hasMember: false },
    { canManage: true, hasMember: false },
    { isLive: false, hasMember: false },
    { inPreview: true, hasMember: false },
  ])
    assert.equal(requiresAccountLinkNotice({ ...linked, ...fields }), false);
});
