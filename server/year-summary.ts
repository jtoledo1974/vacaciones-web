import { calendar, type Config } from '../domain/calendar.ts';
import { ApiError } from './errors.ts';
import { requireSuper, type Principal } from './permissions.ts';
import type { Repository } from './repository.ts';

type Campaign = { id: string; team_id: string; year: number; status: string; kind: string };
export type YearSummaryDay = {
  date: string;
  vacation: number;
  va: number;
  available: number;
  /** Cycles of the previous year may reach this day and are not known. */
  incomplete: boolean;
};

const addDays = (date: string, days: number) =>
  new Date(Date.parse(date + 'T12:00:00Z') + days * 864e5).toISOString().slice(0, 10);

function yearDays(year: number) {
  const out: string[] = [];
  for (let d = year + '-01-01'; d.startsWith(String(year)); d = addDays(d, 1)) out.push(d);
  return out;
}

/**
 * Per day of a year, across all teams: people on ordinary vacation, on VA and available.
 * Only totals leave this function. The workforce is the members of the ordinary campaigns:
 * someone only in the VA census counts as VA but is never subtracted from the available.
 */
export async function yearSummary(repo: Repository, actor: Principal, requested: number | null) {
  requireSuper(actor);
  const campaigns = (await repo.all(
    `SELECT c.id,c.team_id,c.year,c.status,t.kind FROM campaigns c JOIN teams t ON t.id=c.team_id
     WHERE c.scope_key='live' AND c.data_kind<>'demo'`,
  )) as Campaign[];
  const ordinary = campaigns.filter((c) => c.kind === 'ordinary');
  const years = [...new Set(ordinary.map((c) => c.year))].sort((a, b) => b - a);
  const year = requested ?? years[0] ?? null;
  if (year === null) return { year: null, years, staff: 0, missingTeams: [], openTeams: [], vaOpen: false, days: [] };
  if (!years.includes(year)) throw new ApiError('No hay campañas reales de ese año', 404);

  const current = ordinary.filter((c) => c.year === year),
    previous = ordinary.filter((c) => c.year === year - 1),
    va = campaigns.find((c) => c.kind === 'va' && c.year === year);
  const ids = [...current, ...previous, ...(va ? [va] : [])].map((c) => c.id);
  const marks = ids.map(() => '?').join(',');
  const [memberRows, awardRows, parameterRows, teamRows] = await repo.batch([
    { sql: `SELECT id,campaign_id,person_id FROM campaign_members WHERE campaign_id IN (${marks})`, args: ids },
    { sql: `SELECT campaign_id,member_id,cycle_date FROM awards WHERE campaign_id IN (${marks})`, args: ids },
    { sql: `SELECT campaign_id,json FROM parameters WHERE campaign_id IN (${marks})`, args: ids },
    { sql: "SELECT id FROM teams WHERE kind='ordinary' ORDER BY id", args: [] },
  ]);
  const members = memberRows.results as { id: string; campaign_id: string; person_id: string }[],
    awards = awardRows.results as { campaign_id: string; member_id: string; cycle_date: string }[],
    configs = new Map(parameterRows.results.map((p) => [p.campaign_id, JSON.parse(p.json) as Config]));
  const personOf = new Map(members.map((m) => [m.id, m.person_id]));
  const currentIds = new Set(current.map((c) => c.id));
  const staff = new Set(members.filter((m) => currentIds.has(m.campaign_id)).map((m) => m.person_id));

  const dates = yearDays(year);
  const onVacation = new Map(dates.map((d) => [d, new Set<string>()])),
    onVa = new Map(dates.map((d) => [d, new Set<string>()])),
    incomplete = new Set<string>();
  const withAwards = new Set(awards.map((a) => a.campaign_id));

  for (const campaign of [...current, ...previous]) {
    const config = configs.get(campaign.id);
    if (!config) continue;
    const cycles = calendar(campaign.year, campaign.team_id, config);
    const ends = new Map(cycles.map((c) => [c.date, c.end]));
    for (const award of awards) {
      if (award.campaign_id !== campaign.id) continue;
      const person = personOf.get(award.member_id) ?? award.member_id;
      const end = ends.get(award.cycle_date) ?? addDays(award.cycle_date, config.cycleLength - 1);
      for (let d = award.cycle_date; d <= end; d = addDays(d, 1)) {
        const day = onVacation.get(d);
        if (!day) continue;
        day.add(person);
        // A carry-over we cannot match to this year's workforce leaves the day unreliable.
        if (campaign.year !== year && !staff.has(person)) incomplete.add(d);
      }
    }
    // Before a team's first cycle only last year's campaign says who is away, and only
    // once closed: an open one can still award December cycles that reach January.
    if (
      campaign.year === year &&
      !previous.some((p) => p.team_id === campaign.team_id && p.status === 'closed' && withAwards.has(p.id))
    ) {
      const first = cycles[0]?.date ?? dates[0];
      for (const d of dates) if (d < first) incomplete.add(d);
    }
  }
  if (va)
    for (const award of awards)
      if (award.campaign_id === va.id)
        onVa.get(award.cycle_date)?.add(personOf.get(award.member_id) ?? award.member_id);

  const days: YearSummaryDay[] = dates.map((date) => {
    const away = new Set([...onVacation.get(date)!, ...onVa.get(date)!].filter((p) => staff.has(p)));
    return {
      date,
      vacation: onVacation.get(date)!.size,
      va: onVa.get(date)!.size,
      available: staff.size - away.size,
      incomplete: incomplete.has(date),
    };
  });
  const present = new Set(current.map((c) => c.team_id));
  return {
    year,
    years,
    staff: staff.size,
    missingTeams: teamRows.results.map((t) => t.id as string).filter((t) => !present.has(t)),
    openTeams: current
      .filter((c) => c.status !== 'closed')
      .map((c) => c.team_id)
      .sort(),
    vaOpen: !!va && va.status !== 'closed',
    days,
  };
}
