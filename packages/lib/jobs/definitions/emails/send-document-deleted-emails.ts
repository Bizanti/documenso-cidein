import { z } from 'zod';

import type { JobDefinition } from '../../client/_internal/job';

const SEND_DOCUMENT_DELETED_EMAILS_JOB_DEFINITION_ID = 'send.document.deleted.emails';

const SEND_DOCUMENT_DELETED_EMAILS_JOB_DEFINITION_SCHEMA = z.object({
  teamId: z.number(),
  documentName: z.string(),
  inviterName: z.string().optional(),
  inviterEmail: z.string(),
  /**
   * The document's email meta (sender, reply-to, language). Captured before the
   * envelope is hard-deleted so `getEmailContext` resolves the exact same
   * sender/reply-to/language the inline send used.
   */
  meta: z
    .object({
      emailId: z.string().nullable().optional(),
      emailReplyTo: z.string().nullable().optional(),
      language: z.string().optional(),
    })
    .nullable(),
  /**
   * The branding the envelope was pinned to, captured before it is
   * hard-deleted like `meta`. This job is enqueued after the envelope row is
   * gone, so the snapshot cannot be read at send time; callers that do not pass
   * it fall back to the team's live branding.
   */
  brandingSnapshot: z.unknown().optional(),
  recipients: z
    .object({
      email: z.string(),
      name: z.string(),
    })
    .array(),
});

export type TSendDocumentDeletedEmailsJobDefinition = z.infer<
  typeof SEND_DOCUMENT_DELETED_EMAILS_JOB_DEFINITION_SCHEMA
>;

export const SEND_DOCUMENT_DELETED_EMAILS_JOB_DEFINITION = {
  id: SEND_DOCUMENT_DELETED_EMAILS_JOB_DEFINITION_ID,
  name: 'Send Document Deleted Emails',
  version: '1.0.0',
  trigger: {
    name: SEND_DOCUMENT_DELETED_EMAILS_JOB_DEFINITION_ID,
    schema: SEND_DOCUMENT_DELETED_EMAILS_JOB_DEFINITION_SCHEMA,
  },
  handler: async ({ payload, io }) => {
    const handler = await import('./send-document-deleted-emails.handler');

    await handler.run({ payload, io });
  },
} as const satisfies JobDefinition<
  typeof SEND_DOCUMENT_DELETED_EMAILS_JOB_DEFINITION_ID,
  TSendDocumentDeletedEmailsJobDefinition
>;
