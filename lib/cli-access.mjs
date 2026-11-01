/**
 * Whether the browser principal may delegate its existing administrative rights to a CLI.
 * This is only an entry gate: every API operation resolves current rights again.
 * @param {{ id?: string | null, role?: string, teams?: string[] } | null | undefined} actor
 */
export function canAuthorizeCli(actor) {
  return Boolean(
    actor?.id &&
      (actor.role === 'superadmin' ||
        (actor.role === 'team_admin' && Array.isArray(actor.teams) && actor.teams.length > 0)),
  );
}
