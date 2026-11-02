import type { Repository } from './repository.ts';
import type { Service } from './service.ts';
import { ApiError } from './errors.ts';
import { liteSummary } from './lite.ts';
import { individualCalendarRanges, type PersonCalendar } from './individual-calendar-pdf.ts';
import { VA_TEAM, ordinaryCampaign } from './teams.ts';

/**
 * One person's known vacations of the year, from the campaign asked for and its live
 * counterpart: the ordinary campaign gives the rotation, holidays and ordinary periods; the
 * VA campaign the VA days. Each comes from its visible projection, read with the caller's
 * own permissions: a reader who may not see the other campaign gets this one alone.
 */
export async function personCalendar(
  service: Service,
  repo: Repository,
  cid: string,
  code: string,
): Promise<PersonCalendar> {
  const own = await campaign(service, cid, code);
  if (!own) throw new ApiError('Selecciona un controlador válido de la campaña', 400);
  const va = own.team === VA_TEAM;
  // The live campaign of the other kind, same year, where this person is a member.
  // A simulation shows itself alone: nothing of the real campaigns is mixed into it.
  const [other] =
    own.personId && !own.simulation
      ? await repo.all<{ id: string; code: string }>(
          `SELECT c.id,m.code FROM campaigns c JOIN campaign_members m ON m.campaign_id=c.id
         WHERE c.scope_key='live' AND c.year=? AND m.person_id=? AND ${va ? ordinaryCampaign('c') : 'c.team_id=?'}
         LIMIT 1`,
          va ? [own.year, own.personId] : [own.year, own.personId, VA_TEAM],
        )
      : [];
  // Only a refusal leaves the other part out; any other failure fails the PDF, never a partial one.
  const counterpart = other
    ? await campaign(service, other.id, other.code).catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 403) return null;
        throw e;
      })
    : null;
  const ordinary = va ? counterpart : own,
    vaPart = va ? own : counterpart;
  return {
    year: own.year,
    code,
    team: ordinary?.team ?? null,
    config: (ordinary ?? own).config,
    ordinary: ordinary?.ranges ?? [],
    va: vaPart?.ranges ?? [],
    generatedAt: own.generatedAt,
  };
}

async function campaign(service: Service, cid: string, code: string) {
  const summary = liteSummary(await service.view(cid));
  if (!summary.members.some((m) => m.code === code)) return null;
  const { config, members } = await service.load(cid);
  return {
    team: summary.team,
    year: summary.year,
    simulation: summary.simulation,
    config,
    personId: members.find((m: { code: string }) => m.code === code)?.person_id as string | undefined,
    ranges: individualCalendarRanges(summary, code),
    generatedAt: summary.generatedAt,
  };
}
