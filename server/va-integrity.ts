import { calendar, iso, serial, type Config } from '../domain/calendar.ts';
import type { PolicyExternal } from '../domain/occupancy.ts';
import type { Repository, Statement } from './repository.ts';
import { ApiError } from './errors.ts';
import { VA_TEAM, ordinaryCampaign } from './teams.ts';

/**
 * VA is chosen after the ordinary vacations, and only VA looks at them (ADR 0002 §3 bis):
 * a VA day never falls on the person's ordinary vacations. The VA policy checks it in
 * memory from the data loaded here; the SQL assertions below, in the same batch as every
 * write to the live VA campaign, guarantee it. Ordinary campaigns never look at VA.
 */

type CampaignRow = { id: string; year: number; team_id: string };
type Ordinary = CampaignRow & { json: string };

const liveOrdinary = (repo: Repository, years: number[]) =>
  repo.all<Ordinary>(
    `SELECT c.id,c.year,c.team_id,p.json FROM campaigns c JOIN parameters p ON p.campaign_id=c.id
     WHERE c.scope_key='live' AND ${ordinaryCampaign('c')} AND c.year IN (${years.map(() => '?').join(',')})`,
    years,
  );

/** Days held by each person in the ordinary live campaigns of the VA year and the year before. */
async function ordinaryDays(repo: Repository, year: number) {
  const blocked: Record<string, string[]> = {};
  // The last ordinary cycle of December can continue into the VA year.
  for (const c of await liveOrdinary(repo, [year - 1, year])) {
    const ends = new Map(calendar(c.year, c.team_id, JSON.parse(c.json) as Config).map((u) => [u.date, u.end]));
    const awards = await repo.all<{ person_id: string; cycle_date: string }>(
      'SELECT m.person_id,a.cycle_date FROM awards a JOIN campaign_members m ON m.id=a.member_id WHERE a.campaign_id=?',
      [c.id],
    );
    for (const a of awards) {
      const end = ends.get(a.cycle_date);
      if (!end) throw new ApiError('Una adjudicación ordinaria no pertenece al calendario; revisa ' + c.team_id);
      const days = (blocked[a.person_id] ??= []);
      for (let d = serial(a.cycle_date); d <= serial(end); d++) if (iso(d).startsWith(year + '-')) days.push(iso(d));
    }
  }
  return blocked;
}

/** What the campaign's policy needs from outside it. */
export async function policyExternal(repo: Repository, campaign: CampaignRow): Promise<PolicyExternal | undefined> {
  if (campaign.team_id !== VA_TEAM) return undefined;
  const quotas = Object.fromEntries(
    (
      await repo.all<{ date: string; places: number }>('SELECT date,places FROM va_quotas WHERE year=?', [
        campaign.year,
      ])
    ).map((r) => [r.date, r.places]),
  );
  return { quotas, blocked: await ordinaryDays(repo, campaign.year) };
}

function overlapAssertion(sql: string, args: unknown[]): Statement[] {
  const id = crypto.randomUUID();
  return [
    {
      sql: `INSERT INTO va_integrity_assertions(id,valid) VALUES(?,CASE WHEN (${sql}) THEN 1 ELSE 0 END)`,
      args: [id, ...args],
    },
    { sql: 'DELETE FROM va_integrity_assertions WHERE id=?', args: [id] },
  ];
}

/**
 * Assertions for a batch that writes adjudications or cycle boundaries (ADR 0002 §3 bis),
 * in both directions: no VA day over its HR places, and no VA day inside one of the same
 * person's live ordinary cycles, whichever campaign the batch changes (choices, undo,
 * reconstruction, imports, calendar configuration). VA of year Y is compared with the
 * ordinary campaigns of Y and Y−1, whose last December cycle can end in January.
 * Simulations are never asserted. Ordinary choices never read VA: this only refuses the
 * write that would leave both on the same day.
 */
export async function crossCampaignGuards(repo: Repository, statements: Statement[]): Promise<Statement[]> {
  if (
    !statements.some((st) =>
      /(?:INSERT INTO|UPDATE|DELETE FROM|REPLACE INTO)\s+(?:awards|parameters|campaign_members|campaigns)\b/i.test(
        st.sql,
      ),
    )
  )
    return [];
  const va = await repo.all<CampaignRow>("SELECT id,year,team_id FROM campaigns WHERE team_id=? AND scope_key='live'", [
    VA_TEAM,
  ]);
  const guards: Statement[] = [];
  for (const campaign of va) {
    if (statements.some((st) => st.args?.includes(campaign.id)))
      guards.push(
        ...overlapAssertion(
          `NOT EXISTS(SELECT 1 FROM awards a WHERE a.campaign_id=? GROUP BY a.cycle_date
           HAVING count(*) > coalesce((SELECT places FROM va_quotas q WHERE q.year=? AND q.date=a.cycle_date),0))`,
          [campaign.id, campaign.year],
        ),
      );
    for (const c of await liveOrdinary(repo, [campaign.year - 1, campaign.year])) {
      // A configuration change in this same batch moves the cycle ends: check the result.
      let config = c.json;
      for (const st of statements)
        if (/^UPDATE parameters SET json=/i.test(st.sql) && st.args?.[1] === c.id) config = String(st.args[0]);
      const cycles = calendar(c.year, c.team_id, JSON.parse(config) as Config);
      // Every calendar fits under D1's 100-bound-parameter limit.
      guards.push(
        ...overlapAssertion(
          `NOT EXISTS(SELECT 1 FROM awards a JOIN campaign_members m ON m.id=a.member_id
           JOIN awards x ON x.campaign_id=? JOIN campaign_members mx ON mx.id=x.member_id AND mx.person_id=m.person_id
           WHERE a.campaign_id=? AND x.cycle_date BETWEEN a.cycle_date AND
           CASE a.cycle_date ${cycles.map(() => 'WHEN ? THEN ?').join(' ')} END)`,
          [campaign.id, c.id, ...cycles.flatMap((d) => [d.date, d.end])],
        ),
      );
    }
  }
  return guards;
}
