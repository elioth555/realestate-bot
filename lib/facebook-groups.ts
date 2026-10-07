/**
 * Public Facebook groups scanned by a Facebook refresh. Read only by app/actions/facebook.ts;
 * never import from client components.
 * Add one canonical group URL per line, e.g. https://www.facebook.com/groups/123456789012345
 * Public groups only — no cookies are sent, so private/closed groups return nothing.
 */
export const FACEBOOK_GROUP_URLS: readonly string[] = [
  'https://www.facebook.com/groups/938644249820363',
]
