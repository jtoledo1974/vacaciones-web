/** Personal access is distinct from public calendar visibility and from authentication. */
export type CampaignAccessContext = {
  sessionLoaded: boolean;
  authenticated: boolean;
  isLive: boolean;
  canManage: boolean;
  hasMember: boolean;
  inPreview: boolean;
};

/** A signed-in visitor without a controller grant must explicitly choose public browsing. */
export function requiresAccountLinkNotice(context: CampaignAccessContext): boolean {
  return (
    context.sessionLoaded &&
    context.authenticated &&
    context.isLive &&
    !context.canManage &&
    !context.hasMember &&
    !context.inPreview
  );
}
