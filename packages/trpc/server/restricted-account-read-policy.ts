import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { getAccountRolesById, isRestrictedAccount } from '@documenso/lib/server-only/auth/document-authorization';

/**
 * Refuse a read performed by a restricted account which is not part of what a
 * signer needs.
 *
 * A sign only account is limited to signing the documents shared with it, so the
 * team and organisation surfaces are closed to it on the read side as well as on
 * the write side: without this closure a restricted account invited as a member
 * of a team could still list and open its team's documents by calling the read
 * routes directly, or by manipulating identifiers on the API.
 *
 * The answer is a 403 rather than an empty list, so "you may not read this" is
 * never confused with "there is nothing to read".
 */
export const RESTRICTED_ACCOUNT_READ_MESSAGE =
  'This account is restricted to signing documents which have been shared with it, and cannot read the documents or the team data of others.';

/**
 * Query prefixes which only manage the account itself: its own session,
 * credentials, passkeys, profile and security settings. They are the read
 * counterpart of the self service prefixes the write closure keeps open.
 */
export const RESTRICTED_ACCOUNT_SELF_SERVICE_QUERY_PREFIXES = ['auth.', 'profile.'] as const;

/**
 * Query prefixes which belong to the signing flow: the "My signatures" inbox and
 * the unread count the app header shows on every page.
 *
 * Both routes resolve the documents through the recipients of the requesting
 * account, so they only ever hand back documents which were shared with it.
 */
export const RESTRICTED_ACCOUNT_SIGNING_QUERY_PREFIXES = ['document.inbox.'] as const;

/**
 * Individual queries a restricted account still needs, which no prefix covers.
 *
 * - `team.email.get` resolves the team email of the requesting account's own
 *   email address and returns null when there is none, which is what the profile
 *   settings page and the account menu read.
 * - `document.getEnvelopeDownloadPolicies` is mounted on `procedure` rather than
 *   on `authenticatedProcedure`, so it never reaches the guard. It is listed here
 *   to keep the allowlist complete, and because the route resolves its own team
 *   access and reports a restricted account as unable to download instead of
 *   handing it a copy.
 */
export const RESTRICTED_ACCOUNT_ALLOWED_QUERY_PATHS = [
  'team.email.get',
  'document.getEnvelopeDownloadPolicies',
] as const;

const RESTRICTED_ACCOUNT_ALLOWED_QUERY_PREFIXES = [
  ...RESTRICTED_ACCOUNT_SELF_SERVICE_QUERY_PREFIXES,
  ...RESTRICTED_ACCOUNT_SIGNING_QUERY_PREFIXES,
];

/**
 * Whether a restricted account may read a procedure.
 *
 * The default is to guard: a path is only allowed when it is named here, or when
 * it belongs to the self service or signing prefixes above, so a router added
 * later is closed rather than open.
 */
export const isRestrictedAccountAllowedToReadProcedurePath = (procedurePath: string) => {
  if (RESTRICTED_ACCOUNT_ALLOWED_QUERY_PREFIXES.some((prefix) => procedurePath.startsWith(prefix))) {
    return true;
  }

  return (RESTRICTED_ACCOUNT_ALLOWED_QUERY_PATHS as readonly string[]).includes(procedurePath);
};

/**
 * Refuse a read for the given account id, resolving its roles with a fresh
 * database read.
 *
 * The fresh read is the point, exactly as it is on the write side: a role change
 * has to take effect on the very next request instead of surviving inside a
 * session which was created while the account was still unrestricted.
 *
 * @throws {AppError} `FORBIDDEN` (HTTP 403) when the account is restricted.
 */
export const assertRestrictedAccountCanReadById = async ({ userId }: { userId: number }) => {
  const account = await getAccountRolesById({ userId });

  // A missing account is a failure to authorize, never an implicit allow.
  if (!account || isRestrictedAccount(account)) {
    throw new AppError(AppErrorCode.FORBIDDEN, {
      message: RESTRICTED_ACCOUNT_READ_MESSAGE,
      statusCode: 403,
    });
  }
};
