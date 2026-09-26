import { prisma } from '@documenso/prisma';
import type { Role } from '@prisma/client';

import { AppError, AppErrorCode } from '../../errors/app-error';
import { logger } from '../../utils/logger';

export type TAuthorizationAccount = {
  id: number;
  email: string;
  roles: Role[];
};

/**
 * Resolve the account behind an email address when there is no session to read
 * it from: background jobs, queue handlers and the email senders which decide an
 * addressee's policy at send time.
 *
 * The contract is deliberately narrow, because it is used to authorize:
 *
 * - `null` means the lookup **confirmed** that no account exists. The subject is
 *   an external recipient, and only its recipient role policy applies.
 * - A failure to query the database (or an ambiguous answer, such as two
 *   accounts sharing the address) throws. It never resolves to a permissive
 *   value: a lookup which did not complete must not authorize anything, and the
 *   caller is expected to log the error and retry it under its own job policy.
 *
 * @throws {AppError} When the lookup could not be completed.
 */
export const resolveAccountForAuthorization = async (email: string): Promise<TAuthorizationAccount | null> => {
  const normalizedEmail = email.trim().toLowerCase();

  if (!normalizedEmail) {
    // Nothing to authorize against. Treated as an external recipient, which is
    // ruled by its recipient role alone.
    return null;
  }

  let accounts: TAuthorizationAccount[];

  try {
    accounts = await prisma.user.findMany({
      where: {
        email: {
          equals: normalizedEmail,
          mode: 'insensitive',
        },
      },
      select: {
        id: true,
        email: true,
        roles: true,
      },
      orderBy: {
        id: 'asc',
      },
    });
  } catch (error) {
    logger.error({
      msg: 'Failed to resolve the account behind an authorization check',
      email: normalizedEmail,
      err: error,
    });

    throw new AppError(AppErrorCode.UNKNOWN_ERROR, {
      message: 'Failed to resolve the account for authorization.',
    });
  }

  if (accounts.length === 0) {
    return null;
  }

  if (accounts.length > 1) {
    // The address maps to more than one account, so the policies which depend on
    // the account cannot be resolved. Fail closed rather than pick one.
    logger.error({
      msg: 'Ambiguous account resolution for an authorization check',
      email: normalizedEmail,
      accountIds: accounts.map((account) => account.id),
    });

    throw new AppError(AppErrorCode.UNKNOWN_ERROR, {
      message: 'Failed to resolve the account for authorization.',
    });
  }

  return accounts[0];
};
