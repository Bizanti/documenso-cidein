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
 * Either a session with team access or one of the recipient tokens is required.
 * Passing `tokens` resolves a whole page of envelopes in a single request, which
 * is what the document tables use to avoid one query per row.
 */
export const getEnvelopeDownloadPoliciesRoute = procedure
  .input(ZGetEnvelopeDownloadPoliciesRequestSchema)
  .output(ZGetEnvelopeDownloadPoliciesResponseSchema)
  .query(async ({ input, ctx }) => {
    const { envelopeIds, token, tokens } = input;
    const userId = ctx.user?.id;

    // `token` is the single envelope variant of the same thing, kept for callers
    // that resolve one envelope at a time.
    const viewerTokens = Array.from(new Set(tokens ?? (token ? [token] : [])));

    if (viewerTokens.length === 0 && !userId) {
      throw new AppError(AppErrorCode.UNAUTHORIZED, {
        message: 'You must either provide a token or be logged in to fetch download policies.',
      });
    }

    const tokenWhereInput = viewerTokens.length
      ? [
          {
            recipients: {
              some: {
                token: { in: viewerTokens },
              },
            },
          },
          {
            qrToken: { in: viewerTokens },
          },
        ]
      : [];

    const envelopes = await prisma.envelope.findMany({
      where: {
        id: { in: envelopeIds },
        // Team access and token access are each sufficient on their own, so a
        // page mixing documents the viewer owns with documents they only reach
        // as a recipient resolves in one request.
        OR: [...(userId ? [{ team: buildTeamWhereQuery({ teamId: undefined, userId }) }] : []), ...tokenWhereInput],
      },
      select: {
        id: true,
        status: true,
        completedAt: true,
        teamId: true,
        qrToken: true,
        documentMeta: {
          select: {
            downloadWindowHours: true,
          },
        },
      },
    });

    const globalWindowHours = await getDownloadWindowHours();

    // Envelopes the viewer reaches through a recipient token. Those are resolved
    // with recipient permissions even when the request also carries a privileged
    // session, so the UI never offers a version the token download route would
    // reject.
    const tokenEnvelopeIds = new Set<string>();

    if (viewerTokens.length > 0) {
      envelopes.forEach((envelope) => {
        if (envelope.qrToken && viewerTokens.includes(envelope.qrToken)) {
          tokenEnvelopeIds.add(envelope.id);
        }
      });

      const tokenRecipients = await prisma.recipient.findMany({
        where: {
          envelopeId: { in: envelopes.map((envelope) => envelope.id) },
          token: { in: viewerTokens },
        },
        select: {
          envelopeId: true,
        },
      });

      for (const recipient of tokenRecipients) {
        tokenEnvelopeIds.add(recipient.envelopeId);
      }
    }

    const teamRoles = new Map<number, TeamMemberRole>();

    if (userId) {
      const teamIds = Array.from(
        new Set(envelopes.filter((envelope) => !tokenEnvelopeIds.has(envelope.id)).map((envelope) => envelope.teamId)),
      );

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
          role: tokenEnvelopeIds.has(envelope.id) ? null : (teamRoles.get(envelope.teamId) ?? null),
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
