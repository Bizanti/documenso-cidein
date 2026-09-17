import { resendSignedDocument } from '@documenso/lib/server-only/document/resend-signed-document';

import { ZGenericSuccessResponse } from '../schema';
import { authenticatedProcedure } from '../trpc';
import {
  resendSignedDocumentMeta,
  ZResendSignedDocumentRequestSchema,
  ZResendSignedDocumentResponseSchema,
} from './resend-signed-document.types';

export const resendSignedDocumentRoute = authenticatedProcedure
  .meta(resendSignedDocumentMeta)
  .input(ZResendSignedDocumentRequestSchema)
  .output(ZResendSignedDocumentResponseSchema)
  .mutation(async ({ input, ctx }) => {
    const { teamId } = ctx;
    const { documentId, recipients, message } = input;

    ctx.logger.info({
      input: {
        documentId,
        recipients,
      },
    });

    await resendSignedDocument({
      userId: ctx.user.id,
      teamId,
      id: {
        type: 'documentId',
        id: documentId,
      },
      recipientIds: recipients,
      message,
      requestMetadata: ctx.metadata,
    });

    return ZGenericSuccessResponse;
  });
