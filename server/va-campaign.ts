import type { Principal } from './permissions.ts';
import { requireVaAdmin } from './permissions.ts';
import type { Repository, Statement } from './repository.ts';
import type { Service } from './service.ts';
import { ApiError } from './errors.ts';
import { VA_TEAM, ensureVaTeam } from './teams.ts';
import { vaCensusRows } from './va-census.ts';
import { defaultConfig } from '../domain/defaults.ts';

type Body = { action?: string; people?: unknown; source?: { title?: unknown; sha256?: unknown }; reviewToken?: string };

async function digest(value: unknown) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The live VA campaign of a year has started: it has an election state or any award. */
const STARTED = `EXISTS(SELECT 1 FROM election_states s WHERE s.campaign_id=?) OR EXISTS(SELECT 1 FROM awards a WHERE a.campaign_id=?)`;

/**
 * The year's VA campaign from HR's census, in HR's order (ADR 0002, phase 4): a normal
 * campaign of the reserved team `va`, one per year, whose members keep the days they are
 * entitled to, frozen here. It can be loaded again until the campaign starts; then the
 * census is fixed, like the quotas. VA ignores the stored configuration: it is the year's
 * default only so that generic views find one.
 */
export async function loadVaCampaign(service: Service, repo: Repository, actor: Principal, year: number, body: Body) {
  requireVaAdmin(actor);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new ApiError('Año no válido');
  if (!['preview', 'apply'].includes(body.action ?? '')) throw new ApiError('Usa preview o apply');
  const ids = body.people;
  if (
    !Array.isArray(ids) ||
    !ids.length ||
    ids.length > 500 ||
    ids.some((p) => typeof p !== 'string') ||
    new Set(ids).size !== ids.length
  )
    throw new ApiError('Indica los identificadores de personas en el orden de RRHH, sin duplicados');
  const source = body.source;
  if (
    typeof source?.title !== 'string' ||
    !source.title.trim() ||
    source.title.length > 160 ||
    typeof source.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(source.sha256)
  )
    throw new ApiError('Indica el título y SHA-256 de la fuente del censo');
  const census = await vaCensusRows(repo, year);
  const people = (ids as string[]).map((id) => {
    const row = census.find((r) => r.personId === id);
    if (!row || row.status !== 'entitled') throw new ApiError('Persona sin datos validados o sin derecho: ' + id);
    return {
      personId: id,
      team: row.team,
      code: row.code,
      label: row.label,
      seniority: row.seniority!,
      days: row.days,
    };
  });
  const omitted = census
    .filter((r) => r.status === 'entitled' && !ids.includes(r.personId))
    .map((r) => ({ personId: r.personId, team: r.team, code: r.code }));
  const [campaign] = await repo.all<{ id: string; version: number }>(
    "SELECT id,version FROM campaigns WHERE team_id=? AND year=? AND scope_key='live'",
    [VA_TEAM, year],
  );
  if (campaign && (await repo.all(`SELECT 1 WHERE ${STARTED}`, [campaign.id, campaign.id])).length)
    throw new ApiError('La campaña de VA de ese año ya se ha iniciado: el censo no se puede cambiar', 409);
  const report = { year, people, omitted, source: { title: source.title.trim(), sha256: source.sha256 } };
  // The review binds the census read too: a master change since the preview asks for another.
  const reviewToken = await digest({ report, census, version: campaign?.version ?? 0 });
  if (body.action === 'preview') return { ...report, reviewToken };
  if (body.reviewToken !== reviewToken) throw new ApiError('Revisa de nuevo el censo antes de aplicarlo', 409);
  const cid = campaign?.id ?? crypto.randomUUID(),
    at = new Date().toISOString(),
    token = crypto.randomUUID();
  const ops: Statement[] = campaign
    ? [
        { sql: 'UPDATE campaigns SET version=version+1 WHERE id=? AND version=?', args: [cid, campaign.version] },
        {
          sql: `INSERT INTO transaction_assertions(id) VALUES(CASE WHEN changes()=1 AND NOT (${STARTED}) THEN ? ELSE NULL END)`,
          args: [cid, cid, token],
        },
        { sql: 'DELETE FROM transaction_assertions WHERE id=?', args: [token] },
        { sql: 'DELETE FROM preferences WHERE campaign_id=?', args: [cid] },
        { sql: 'DELETE FROM campaign_members WHERE campaign_id=?', args: [cid] },
      ]
    : [
        ensureVaTeam,
        {
          sql: "INSERT INTO campaigns(id,team_id,year,status,version,data_kind,created_at) VALUES(?,?,?,'open',1,'real',?)",
          args: [cid, VA_TEAM, year, at],
        },
        {
          sql: 'INSERT INTO parameters(campaign_id,json,version) VALUES(?,?,1)',
          args: [cid, JSON.stringify(defaultConfig(year))],
        },
        service.audit('create_campaign', { id: cid, team_id: VA_TEAM }, null, { year }),
      ];
  people.forEach((p, position) =>
    ops.push({
      sql: 'INSERT INTO campaign_members(id,campaign_id,person_id,code,label,seniority,position,entitlement,version) VALUES(?,?,?,?,?,?,?,?,1)',
      args: [crypto.randomUUID(), cid, p.personId, p.code, p.label, p.seniority, position, p.days],
    }),
  );
  ops.push(
    service.audit('import_roster', { id: cid, team_id: VA_TEAM }, null, {
      source: report.source,
      order: people.map((p) => p.personId),
      omitted: omitted.length,
    }),
  );
  await service.commit(ops);
  return { ...report, campaignId: cid, applied: true };
}
