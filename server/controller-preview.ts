import { ApiError } from './errors.ts';
import { requireSuper, type Principal } from './permissions.ts';
import type { Repository } from './repository.ts';

/** Resolve a controller by code after verifying the real session is a superadmin. */
export async function resolveControllerPreview(
  repo: Repository, realActor: Principal, campaignId: string, requestedCode: string,
): Promise<{ actor: Principal; code: string; writable: boolean }> {
  requireSuper(realActor);
  const code = requestedCode.trim();
  if (!code || code.length > 80 || /[\x00-\x1f/?#&]/.test(code))
    throw new ApiError('Código de controlador no válido', 400);
  const campaign = (await repo.all('SELECT id, scope_key FROM campaigns WHERE id=?', [campaignId]))[0];
  if (!campaign) throw new ApiError('Campaña no encontrada', 404);
  const matches = await repo.all(
    'SELECT id,code FROM campaign_members WHERE campaign_id=? AND UPPER(code)=UPPER(?)',
    [campaignId, code],
  );
  if (matches.length !== 1) throw new ApiError('Controlador no encontrado o ambiguo en esta campaña', 404);
  const writable = campaign.scope_key !== 'live';
  const member = matches[0];
  return {
    actor: {
      id: realActor.id, role: 'viewer', teams: [],
      preview: { campaignId, memberId: member.id, code: member.code, writable },
    },
    code: member.code, writable,
  };
}
