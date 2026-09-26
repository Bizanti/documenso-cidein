import { invalidateUserSessions } from '@documenso/auth/server/lib/session/session';
import { getRolesAfterPromotion, validateRoleCombination } from '@documenso/lib/constants/roles';
import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { updateUser } from '@documenso/lib/server-only/admin/update-user';
import { countActiveRecipientAssignments } from '@documenso/lib/server-only/audit/recipient-assignments';
import { recordUserProfileChange } from '@documenso/lib/server-only/audit/user-profile-change';
import { isSignOnly } from '@documenso/lib/utils/is-sign-only';
import { prisma } from '@documenso/prisma';
import { Role } from '@prisma/client';

import { adminProcedure } from '../trpc';
import { ZUpdateUserRequestSchema, ZUpdateUserResponseSchema } from './update-user.types';

export const updateUserRoute = adminProcedure
  .input(ZUpdateUserRequestSchema)
  .output(ZUpdateUserResponseSchema)
  .mutation(async ({ input, ctx }) => {
    const { id, name, email, roles } = input;

    const actorUserId = ctx.user.id;
    const metadata = ctx.metadata.requestMetadata;

    ctx.logger.info({
      input: {
        id,
        roles,
      },
    });

    const targetUser = await prisma.user.findUnique({
      where: {
        id,
      },
      select: {
        id: true,
        email: true,
        roles: true,
      },
    });

    if (!targetUser) {
      throw new AppError(AppErrorCode.NOT_FOUND, {
        message: 'User not found',
      });
    }

    /**
     * Roles are only assigned by a platform administrator: this route runs
     * behind `adminProcedure` and is the only write path of `User.roles`.
     *
     * Only a valid profile combination can be stored, so a request carrying
     * SIGN_ONLY together with USER or ADMIN is rejected instead of writing an
     * account which holds the restricted profile and a permission at once.
     */
    const requestedRoles = roles === undefined ? undefined : validateRoleCombination(roles);

    /**
     * Promoting a restricted account replaces the sign only profile with the
     * user profile instead of accumulating it, and never grants the admin role
     * implicitly.
     */
    const nextRoles = requestedRoles === undefined ? undefined : getRolesAfterPromotion(requestedRoles);

    // Emails are stored lowercase, and the review of the live signing
    // assignments below matches on the stored address.
    const nextEmail = email === undefined ? undefined : email.toLowerCase();

    const isEmailChanging = nextEmail !== undefined && nextEmail !== targetUser.email;

    const isRestrictedAccount = isSignOnly(targetUser) || Boolean(nextRoles?.includes(Role.SIGN_ONLY));

    /**
     * A restricted account owns a single inbox: the signing assignments created
     * for it are keyed by the recipient email, so moving the account while
     * assignments are live would move those signing requests to another inbox.
     * The email of a restricted account is therefore only changed once the
     * assignments are resolved, which is recorded in the audit log below.
     */
    if (isEmailChanging && isRestrictedAccount) {
      const activeAssignments = await countActiveRecipientAssignments({ email: targetUser.email });

      if (activeAssignments > 0) {
        throw new AppError(AppErrorCode.INVALID_REQUEST, {
          message: `The account still holds ${activeAssignments} live signing assignment(s) for ${targetUser.email}. Resolve them before changing the email of a restricted account.`,
        });
      }
    }

    await updateUser({
      id,
      name,
      email: nextEmail,
      roles: nextRoles,
    });

    const { changedFields } = await recordUserProfileChange({
      actorUserId,
      targetUserId: id,
      previous: {
        roles: targetUser.roles,
        email: targetUser.email,
      },
      next: {
        roles: nextRoles ?? targetUser.roles,
        email: nextEmail ?? targetUser.email,
      },
      metadata,
    });

    /**
     * A profile change has to be effective on the next request, including the
     * sessions which are already open, so every session of the account is
     * invalidated: the account authenticates again and no request is resolved
     * from a session created before the change.
     */
    const revokedSessions = changedFields.includes('roles')
      ? await invalidateUserSessions({ userId: id, metadata })
      : 0;

    ctx.logger.info({
      actorUserId,
      targetUserId: id,
      changedFields,
      revokedSessions,
    });
  });
