/** The reserved team of the yearly VA campaign (ADR 0002). */
export const VA_TEAM = 'va';
/** Ids of the ordinary teams, as a subquery. */
export const ORDINARY_TEAMS = "SELECT id FROM teams WHERE kind='ordinary'";
/** SQL condition: the campaign (optionally aliased) belongs to an ordinary team. */
export const ordinaryCampaign = (alias = '') => `${alias ? alias + '.' : ''}team_id IN (${ORDINARY_TEAMS})`;
