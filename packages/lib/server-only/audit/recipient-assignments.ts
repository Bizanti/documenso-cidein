import { prisma } from '@documenso/prisma';
import { DocumentStatus } from '@prisma/client';

/**
 * The envelope statuses which no longer hold a live signing assignment.
 */
const CLOSED_ENVELOPE_STATUSES: DocumentStatus[] = [
  DocumentStatus.COMPLETED,
  DocumentStatus.REJECTED,
  DocumentStatus.CANCELLED,
];

export type CountActiveRecipientAssignmentsOptions = {
  email: string;
};

/**
 * Count the live signing assignments held by an email address.
 *
 * Signing assignments are keyed by the recipient email until recipients are
 * linked to an account by id, so they are the evidence used to review an
 * administrative email change: moving the inbox of an account while assignments
 * are still live would move those signing requests with it.
 */
export const countActiveRecipientAssignments = async ({ email }: CountActiveRecipientAssignmentsOptions) => {
  return await prisma.recipient.count({
    where: {
      email: {
        equals: email,
        mode: 'insensitive',
      },
      documentDeletedAt: null,
      envelope: {
        deletedAt: null,
        status: {
          notIn: CLOSED_ENVELOPE_STATUSES,
        },
      },
    },
  });
};
