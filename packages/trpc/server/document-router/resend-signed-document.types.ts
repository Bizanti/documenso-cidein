import { z } from 'zod';
import { ZSuccessResponseSchema } from '../schema';
import type { TrpcRouteMeta } from '../trpc';

export const resendSignedDocumentMeta: TrpcRouteMeta = {
  openapi: {
    method: 'POST',
    path: '/document/resend-signed',
    summary: 'Resend signed document',
    description:
      'Delivers the completed document to the provided recipients again, with an audit log entry for each delivery and a copy to the team members holding the SGC privileges. The response reports whether any email was actually sent.',
    tags: ['Document'],
  },
};

export const ZResendSignedDocumentRequestSchema = z.object({
  documentId: z.number(),
  recipients: z.array(z.number()).min(1).describe('The IDs of the recipients to resend the signed document to.'),
  message: z.string().max(5000).optional().describe('An optional message to include in the email.'),
});

export type TResendSignedDocumentRequest = z.infer<typeof ZResendSignedDocumentRequestSchema>;

/**
 * Why a resend of a signed document delivered no email.
 *
 * - `EMAILS_DISABLED`: the organisation (or the requesting user) is prevented from sending emails.
 * - `NO_SENDABLE_RECIPIENTS`: none of the selected recipients has an address that can be delivered to.
 */
export const ZResendSignedDocumentSkipReason = z.enum(['EMAILS_DISABLED', 'NO_SENDABLE_RECIPIENTS']);

export type TResendSignedDocumentSkipReason = z.infer<typeof ZResendSignedDocumentSkipReason>;

export const ZResendSignedDocumentResponseSchema = ZSuccessResponseSchema.extend({
  sent: z.boolean().describe('Whether the signed document was emailed to at least one recipient.'),
  reason: ZResendSignedDocumentSkipReason.optional().describe('Why no email was sent, when `sent` is false.'),
});

export type TResendSignedDocumentResponse = z.infer<typeof ZResendSignedDocumentResponseSchema>;
