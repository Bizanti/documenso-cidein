import { createTeam } from '@documenso/lib/server-only/team/create-team';

import { documentManagementProcedure } from '../trpc';
import { ZCreateTeamRequestSchema, ZCreateTeamResponseSchema } from './create-team.types';

export const createTeamRoute = documentManagementProcedure
  // .meta(createOrganisationGroupMeta)
  .input(ZCreateTeamRequestSchema)
  .output(ZCreateTeamResponseSchema)
  .mutation(async ({ input, ctx }) => {
    const { teamName, teamUrl, organisationId, inheritMembers } = input;
    const { user } = ctx;

    ctx.logger.info({
      input: {
        organisationId,
      },
    });

    return await createTeam({
      userId: user.id,
      teamName,
      teamUrl,
      organisationId,
      inheritMembers,
    });
  });
