import { z } from 'zod';
import { ZSuccessResponseSchema } from '../schema';
import type { TrpcRouteMeta } from '../trpc';

export const resendSignedDocumentMeta: TrpcRouteMeta = {
  openapi: {
    method: 'POST',
    path: '/document/resend-signed',
    summary: 'Resend signed document',
    description:
      'Delivers the completed document to the provided recipients again, with an audit log entry for each delivery and a copy to the team members holding the SGC privileges.',
    tags: ['Document'],
  },
};

export const ZResendSignedDocumentRequestSchema = z.object({
  documentId: z.number(),
  recipients: z.array(z.number()).min(1).describe('The IDs of the recipients to resend the signed document to.'),
  message: z.string().max(5000).optional().describe('An optional message to include in the email.'),
});

export type TResendSignedDocumentRequest = z.infer<typeof ZResendSignedDocumentRequestSchema>;

export const ZResendSignedDocumentResponseSchema = ZSuccessResponseSchema;

export type TResendSignedDocumentResponse = z.infer<typeof ZResendSignedDocumentResponseSchema>;
