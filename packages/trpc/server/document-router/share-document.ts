import { createOrGetShareLink } from '@documenso/lib/server-only/share/create-or-get-share-link';

import { authenticatedProcedure } from '../trpc';
import { ZShareDocumentRequestSchema, ZShareDocumentResponseSchema } from './share-document.types';

// Note: Sharing a document is an owner/team action. Recipients are no longer
// offered it, so a recipient token is ignored and the link is created for the
// authenticated session user.
export const shareDocumentRoute = authenticatedProcedure
  .input(ZShareDocumentRequestSchema)
  .output(ZShareDocumentResponseSchema)
  .mutation(async ({ input, ctx }) => {
    const { documentId } = input;

    ctx.logger.info({
      input: {
        documentId,
      },
    });

    return await createOrGetShareLink({ documentId, userId: ctx.user.id });
  });
