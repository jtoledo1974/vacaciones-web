import type { Repository, Statement } from './repository.ts';
import { electionStateStatement } from './election-service.ts';
import { ApiError } from './errors.ts';
export async function cloneSimulation(
  repo: Repository,
  d: any,
  name: string,
): Promise<{ id: string; statements: Statement[] }> {
  if (typeof name !== 'string' || !name.trim() || name.length > 60 || /[\r\n\t]/.test(name))
    throw new ApiError('Nombre de simulación entre 1 y 60 caracteres');
  const cid = crypto.randomUUID(),
    scope = crypto.randomUUID(),
    token = crypto.randomUUID(),
    map = new Map(d.members.map((m: any) => [m.id, crypto.randomUUID()]));
  const statements: Statement[] = [
    {
      sql: 'INSERT INTO transaction_assertions(id) VALUES(CASE WHEN (SELECT version FROM campaigns WHERE id=?)=? THEN ? ELSE NULL END)',
      args: [d.campaign.id, d.campaign.version, token],
    },
    { sql: 'DELETE FROM transaction_assertions WHERE id=?', args: [token] },
    {
      sql: "INSERT INTO campaigns(id,team_id,year,scope_key,simulation_name,status,version,data_kind,created_at) VALUES(?,?,?,?,?,'open',1,'simulation',?)",
      args: [cid, d.campaign.team_id, d.campaign.year, scope, name.trim(), new Date().toISOString()],
    },
    { sql: 'INSERT INTO parameters(campaign_id,json,version) VALUES(?,?,1)', args: [cid, JSON.stringify(d.config)] },
  ];
  for (const member of d.members)
    statements.push({
      sql: 'INSERT INTO campaign_members(id,campaign_id,person_id,code,label,seniority,position,version) VALUES(?,?,?,?,?,?,?,1)',
      args: [map.get(member.id), cid, member.person_id, member.code, member.label, member.seniority, member.position],
    });
  const state = (await repo.all('SELECT json FROM election_states WHERE campaign_id=?', [d.campaign.id]))[0];
  if (state) {
    const original = JSON.parse(state.json);
    if (original.order.every((id: string) => map.has(id)))
      statements.push(
        electionStateStatement(cid, {
          ...original,
          status: 'paused',
          order: original.order.map((id: string) => map.get(id)),
          tieGroups: original.tieGroups?.map((g: string[]) => g.map((id) => map.get(id))),
          pendingTieGroups: original.tieGroups?.map((g: string[]) => g.map((id) => map.get(id))),
          jointGroups: original.jointGroups?.map((g: string[]) => g.map((id) => map.get(id))),
          jointAgreements: original.jointAgreements?.map((a: any) => ({
            ...a,
            members: a.members.map((id: string) => map.get(id)),
          })),
          tieResolutions: [],
          credits: {},
          cursor: 0,
        }),
      );
  }
  // Preferences in the real campaign are private. Every simulation starts with empty lists.
  return { id: cid, statements };
}
