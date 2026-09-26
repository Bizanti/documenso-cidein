import { prisma } from '@documenso/prisma';
import type { User } from '@prisma/client';

import { isValidRoleCombination } from '../../constants/roles';
import { AppError, AppErrorCode } from '../../errors/app-error';
import { isSignOnly } from '../../utils/is-sign-only';

/**
 * A profile which may only sign the documents shared with it (SIGN_ONLY) is a
 * restriction rather than a permission, so it is mutually exclusive with the
 * USER and ADMIN roles. Any other combination is inconsistent data, and
 * inconsistent data must never be allowed to write: the restriction wins.
 */
export const isRestrictedAccount = (account: Pick<User, 'roles'>) =>
  !isValidRoleCombination(account.roles) || isSignOnly(account);

/**
 * The canonical guard for every server side write an account performs on its own
 * behalf. It is the negation of {@link isRestrictedAccount}, spelled out so the
 * allowed case is the one being asserted at each call site.
 */
export const isAllowedToManageDocuments = (account: Pick<User, 'roles'>) => !isRestrictedAccount(account);

export const RESTRICTED_ACCOUNT_MESSAGE =
  'This account is restricted to signing documents which have been shared with it, and cannot perform this action.';

export const RESTRICTED_ACCOUNT_DOWNLOAD_MESSAGE =
  'This account is restricted to signing documents which have been shared with it, and cannot download documents.';

/**
 * Refuse a document management action for a sign only (or otherwise restricted)
 * account.
 *
 * Reads the roles it is given instead of a session: callers must hand over roles
 * which came from the database, and must never hand over a roles value which was
 * cached in the session, a token or the client.
 *
 * @throws {AppError} `FORBIDDEN` (HTTP 403) when the account is restricted.
 */
export const assertCanManageDocuments = (account: Pick<User, 'roles'> | null | undefined) => {
  // A missing account is a failure to authorize, never an implicit allow.
  if (!account || isRestrictedAccount(account)) {
    throw new AppError(AppErrorCode.FORBIDDEN, {
      message: RESTRICTED_ACCOUNT_MESSAGE,
      statusCode: 403,
    });
  }

  return account;
};

/**
 * The roles of an account, read fresh from the database.
 *
 * The fresh read is the point: an authorization decision must never depend on a
 * roles value which was resolved earlier in the request (or in a previous one),
 * because a role change has to take effect on the very next authorization.
 *
 * Returns `null` when no such account exists, which callers must treat as a
 * failure to authorize rather than as an unrestricted account.
 */
export const getAccountRolesById = async ({ userId }: { userId: number }) =>
  prisma.user.findUnique({
    where: {
      id: userId,
    },
    select: {
      roles: true,
    },
  });

/**
 * Refuse a document management action for the given account id, resolving its
 * roles with a fresh database read.
 *
 * @throws {AppError} `FORBIDDEN` (HTTP 403) when the account is restricted.
 */
export const assertCanManageDocumentsById = async ({ userId }: { userId: number }) => {
  assertCanManageDocuments(await getAccountRolesById({ userId }));
};

/**
 * Refuse a download or export for the given account id, resolving its roles with
 * a fresh database read.
 *
 * Reads and the signing viewer are untouched: this closes the routes which hand
 * out a copy, and the account restriction is checked in the same fresh way as the
 * write closure.
 *
 * @throws {AppError} `FORBIDDEN` (HTTP 403) when the account is restricted.
 */
export const assertAccountAllowedToDownloadById = async ({ userId }: { userId: number }) => {
  const account = await getAccountRolesById({ userId });

  if (!account || isRestrictedAccount(account)) {
    throw new AppError(AppErrorCode.FORBIDDEN, {
      message: RESTRICTED_ACCOUNT_DOWNLOAD_MESSAGE,
      statusCode: 403,
    });
  }
};

/**
 * Procedure prefixes which a restricted account may still reach, because they
 * only manage the account itself: its own session, credentials, passkeys and
 * profile. Everything else that mutates state is a document management action,
 * directly (documents, envelopes, folders, recipients, fields, templates) or
 * indirectly (teams, organisations, API tokens, webhooks, administration).
 */
export const SELF_SERVICE_PROCEDURE_PREFIXES = ['auth.', 'profile.'] as const;

/**
 * Whether a procedure path is subject to the sign only write closure.
 *
 * The default is to guard: a path is only exempt when it belongs to the self
 * service prefixes above, so a router added later is closed rather than open.
 */
export const isDocumentManagementProcedurePath = (procedurePath: string) =>
  !SELF_SERVICE_PROCEDURE_PREFIXES.some((prefix) => procedurePath.startsWith(prefix));
