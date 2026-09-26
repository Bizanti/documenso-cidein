import type { SessionUser } from '@documenso/auth/server/lib/session/session';
import { isSignOnly } from '@documenso/lib/utils/is-sign-only';

/**
 * Where a sign only account lands whenever it reaches a route it is not allowed to use.
 */
export const SIGN_ONLY_HOME = '/mis-firmas';

/**
 * The only paths a sign only account may reach.
 *
 * Everything else — the team area, the organisation area and the rest of the settings — is
 * out of bounds so a manually typed administrative URL cannot be used to reach it.
 */
const SIGN_ONLY_ALLOWED_PATHS = [SIGN_ONLY_HOME, '/inbox', '/sign', '/settings/profile', '/settings/security'];

/**
 * The account menu links to the support page of the organisation the user is in, which is
 * the single organisation scoped page a sign only account is allowed to reach.
 */
const isOrganisationSupportPath = (pathname: string) => /^\/o\/[^/]+\/support\/?$/.test(pathname);

/**
 * Whether a sign only account is allowed to load the given path.
 *
 * Only the listed paths are allowed, so unknown and future routes are blocked by default.
 */
export const isSignOnlyPathAllowed = (pathname: string) => {
  const isAllowedPath = SIGN_ONLY_ALLOWED_PATHS.some(
    (allowedPath) => pathname === allowedPath || pathname.startsWith(`${allowedPath}/`),
  );

  return isAllowedPath || isOrganisationSupportPath(pathname);
};

/**
 * The path a sign only account should be redirected to, or `null` when it may stay where it is.
 *
 * Returned rather than thrown so the same rule can be used from middleware and from loaders.
 */
export const getSignOnlyRedirectTarget = (user: SessionUser | null, pathname: string) => {
  if (!user || !isSignOnly(user) || isSignOnlyPathAllowed(pathname)) {
    return null;
  }

  return SIGN_ONLY_HOME;
};
