/** The reserved team of the yearly VA campaign (ADR 0002). */
export { VA_TEAM } from '../domain/policy-va.ts';
import { VA_TEAM } from '../domain/policy-va.ts';
/** Creates the reserved team on first use, so empty installs and restores never collide on it. */
export const ensureVaTeam = {
  sql: "INSERT OR IGNORE INTO teams(id,name,version,kind) VALUES(?,'Vacaciones de antigüedad',1,'va')",
  args: [VA_TEAM],
};
/** Ids of the ordinary teams, as a subquery. */
export const ORDINARY_TEAMS = "SELECT id FROM teams WHERE kind='ordinary'";
/** SQL condition: the campaign (optionally aliased) belongs to an ordinary team. */
export const ordinaryCampaign = (alias = '') => `${alias ? alias + '.' : ''}team_id IN (${ORDINARY_TEAMS})`;
