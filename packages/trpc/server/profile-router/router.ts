import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { assertCanManageDocumentsById } from '@documenso/lib/server-only/auth/document-authorization';
import type { SetAvatarImageOptions } from '@documenso/lib/server-only/profile/set-avatar-image';
import { setAvatarImage } from '@documenso/lib/server-only/profile/set-avatar-image';
import { deleteUser } from '@documenso/lib/server-only/user/delete-user';
import { findUserSecurityAuditLogs } from '@documenso/lib/server-only/user/find-user-security-audit-logs';
import { submitSupportTicket } from '@documenso/lib/server-only/user/submit-support-ticket';
import { updateProfile } from '@documenso/lib/server-only/user/update-profile';

import { authenticatedProcedure, router } from '../trpc';
import {
  ZFindUserSecurityAuditLogsSchema,
  ZSetProfileImageMutationSchema,
  ZSubmitSupportTicketMutationSchema,
  ZUpdateProfileMutationSchema,
} from './schema';

export const profileRouter = router({
  findUserSecurityAuditLogs: authenticatedProcedure
    .input(ZFindUserSecurityAuditLogsSchema)
    .query(async ({ input, ctx }) => {
      return await findUserSecurityAuditLogs({
        userId: ctx.user.id,
        ...input,
      });
    }),

  updateProfile: authenticatedProcedure.input(ZUpdateProfileMutationSchema).mutation(async ({ input, ctx }) => {
    const { name, signature } = input;

    await updateProfile({
      userId: ctx.user.id,
      name,
      signature,
      requestMetadata: ctx.metadata.requestMetadata,
    });
  }),

  deleteAccount: authenticatedProcedure.mutation(async ({ ctx }) => {
    ctx.logger.info({
      input: {
        userId: ctx.user.id,
      },
    });

    await deleteUser({
      id: ctx.user.id,
    });
  }),

  setProfileImage: authenticatedProcedure.input(ZSetProfileImageMutationSchema).mutation(async ({ input, ctx }) => {
    const { bytes, teamId, organisationId } = input;

    ctx.logger.info({
      input: {
        teamId,
        organisationId,
      },
    });

    let target: SetAvatarImageOptions['target'] = {
      type: 'user',
    };

    if (teamId) {
      target = {
        type: 'team',
        teamId,
      };
    }

    if (organisationId) {
      target = {
        type: 'organisation',
        organisationId,
      };
    }

    // `profile.*` is self service for a restricted account, so the shared write
    // closure lets this route through: the avatar of the account itself belongs
    // to the account. The avatar of a team or an organisation does not, because
    // it is shared with every member, so that target is closed here even when
    // the account kept the membership role which would otherwise allow it.
    if (target.type !== 'user') {
      await assertCanManageDocumentsById({ userId: ctx.user.id });
    }

    return await setAvatarImage({
      userId: ctx.user.id,
      target,
      bytes,
      requestMetadata: ctx.metadata,
    });
  }),

  submitSupportTicket: authenticatedProcedure
    .input(ZSubmitSupportTicketMutationSchema)
    .mutation(async ({ input, ctx }) => {
      const { subject, message, organisationId, teamId } = input;

      const userId = ctx.user.id;

      const parsedTeamId = teamId ? Number(teamId) : null;

      if (typeof parsedTeamId === 'number') {
        if (Number.isNaN(parsedTeamId) || parsedTeamId <= 0) {
          throw new AppError(AppErrorCode.INVALID_BODY, {
            message: 'Invalid team ID provided',
          });
        }
      }

      return await submitSupportTicket({
        subject,
        message,
        userId,
        organisationId,
        teamId: parsedTeamId,
      });
    }),
});
