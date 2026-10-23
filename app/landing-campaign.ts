/**
 * Choose the campaign to show on the landing page. A shared link always wins
 * over the signed-in controller's default team.
 */
export type LandingCampaign = {
  id: string;
  team_id: string;
  year: number;
  scope_key: string;
};

export type LandingIndex = {
  campaigns: LandingCampaign[];
  myCampaignIds: string[];
};

export type LandingSelection = {
  campaignId: string | null;
  year: number;
};

export function resolveLandingCampaign(index: LandingIndex, search: string): LandingSelection {
  const params = new URLSearchParams(search);
  const live = index.campaigns.filter(campaign => campaign.scope_key === 'live');
  const yearParam = params.get('year');
  const parsedYear = yearParam === null ? NaN : Number(yearParam);
  const requestedYear = Number.isInteger(parsedYear) && parsedYear > 0 ? parsedYear : null;
  const defaultYear = live.length ? Math.max(...live.map(campaign => campaign.year)) : 2026;
  let selected: LandingCampaign | undefined;

  if (params.has('equipo')) {
    // An explicit team (including one from a shared link) must not be replaced.
    const team = params.get('equipo');
    const scenario = params.get('escenario');
    selected = (scenario
      ? index.campaigns.find(campaign => campaign.id === scenario && campaign.team_id === team
        && (requestedYear === null || campaign.year === requestedYear))
      : undefined)
      ?? live.filter(campaign => campaign.team_id === team
        && (requestedYear === null || campaign.year === requestedYear))
        .sort((a, b) => b.year - a.year)[0];
  } else if (!params.has('escenario')) {
    // The backend derives these IDs from the authenticated, linked account.
    const ids = new Set(index.myCampaignIds);
    const linked = live.filter(campaign => ids.has(campaign.id));
    const targetYear = requestedYear ?? (linked.length
      ? Math.max(...linked.map(campaign => campaign.year)) : null);
    const matches = linked.filter(campaign => campaign.year === targetYear);
    // Never guess when an identity belongs to multiple teams for this year.
    if (new Set(matches.map(campaign => campaign.team_id)).size === 1) {
      selected = matches[0];
    }
  }

  return { campaignId: selected?.id ?? null, year: selected?.year ?? requestedYear ?? defaultYear };
}
