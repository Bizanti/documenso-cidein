import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { buildEnvelopeDownloadPolicy } from '@documenso/lib/server-only/document/download-policy';
import { getDownloadWindowHours } from '@documenso/lib/server-only/site-settings/get-download-window-hours';
import { getTeamById } from '@documenso/lib/server-only/team/get-team';
import { buildTeamWhereQuery } from '@documenso/lib/utils/teams';
import { prisma } from '@documenso/prisma';
import type { TeamMemberRole } from '@prisma/client';

import { procedure } from '../trpc';
import {
  ZGetEnvelopeDownloadPoliciesRequestSchema,
  ZGetEnvelopeDownloadPoliciesResponseSchema,
} from './get-envelope-download-policies.types';

/**
 * Resolves the download policy (expired window, allowed versions) for the given
 * envelopes for the current viewer, so the UI can show a locked state instead of
 * letting the download fail with a raw 403.
 *
 * Either a session with team access or a recipient token is required.
 */
export const getEnvelopeDownloadPoliciesRoute = procedure
  .input(ZGetEnvelopeDownloadPoliciesRequestSchema)
  .output(ZGetEnvelopeDownloadPoliciesResponseSchema)
  .query(async ({ input, ctx }) => {
    const { envelopeIds, token } = input;
    const userId = ctx.user?.id;

    if (!token && !userId) {
      throw new AppError(AppErrorCode.UNAUTHORIZED, {
        message: 'You must either provide a token or be logged in to fetch download policies.',
      });
    }

    const envelopes = await prisma.envelope.findMany({
      where: {
        id: { in: envelopeIds },
        ...(token
          ? {
              OR: [
                {
                  recipients: {
                    some: {
                      token,
                    },
                  },
                },
                {
                  qrToken: token,
                },
              ],
            }
          : {
              team: buildTeamWhereQuery({ teamId: undefined, userId: userId ?? -1 }),
            }),
      },
      select: {
        id: true,
        status: true,
        completedAt: true,
        teamId: true,
        documentMeta: {
          select: {
            downloadWindowHours: true,
          },
        },
      },
    });

    const globalWindowHours = await getDownloadWindowHours();

    const teamRoles = new Map<number, TeamMemberRole>();

    if (userId) {
      const teamIds = Array.from(new Set(envelopes.map((envelope) => envelope.teamId)));

      await Promise.all(
        teamIds.map(async (teamId) => {
          const team = await getTeamById({ userId, teamId }).catch(() => null);

          if (team) {
            teamRoles.set(teamId, team.currentTeamRole);
          }
        }),
      );
    }

    return {
      data: envelopes.map((envelope) => {
        const policy = buildEnvelopeDownloadPolicy({
          status: envelope.status,
          completedAt: envelope.completedAt,
          windowHours: envelope.documentMeta?.downloadWindowHours ?? globalWindowHours,
          role: teamRoles.get(envelope.teamId) ?? null,
        });

        return {
          envelopeId: envelope.id,
          downloadWindowHours: policy.downloadWindowHours,
          downloadWindowExpiresAt: policy.downloadWindowExpiresAt,
          isDownloadWindowExpired: policy.isDownloadWindowExpired,
          canDownloadSigned: policy.canDownloadSigned,
          canDownloadOriginal: policy.canDownloadOriginal,
        };
      }),
    };
  });
