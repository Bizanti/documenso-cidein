import { msg } from '@lingui/core/macro';
import type { RecipientRole } from '@prisma/client';
import { z } from 'zod';

import { getRecipientRoleCapabilities } from '../utils/recipients';

/**
 * Recipients the signed document can be delivered to.
 *
 * Controlled signers never receive the completed document, so a document that
 * only has controlled signers cannot be resent to anyone.
 */
export const getRecipientsThatReceiveCompletedDocument = <T extends { role: RecipientRole }>(recipients: T[]): T[] =>
  recipients.filter((recipient) => getRecipientRoleCapabilities(recipient.role).receivesCompletedPdf);

/**
 * Validation messages hold the Lingui message id, not the English copy: the
 * catalogs are keyed by those ids and the id is resolved when rendering (see
 * `FormMessage`).
 */
export const ZDocumentResendSignedFormSchema = z.object({
  recipients: z.array(z.number()).min(1, {
    message: msg`You must select at least one recipient`.id,
  }),
  message: z.string().max(5000).optional(),
});

export type TDocumentResendSignedFormSchema = z.infer<typeof ZDocumentResendSignedFormSchema>;
