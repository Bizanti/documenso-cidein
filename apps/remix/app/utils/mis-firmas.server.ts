import { prisma } from '@documenso/prisma';
import { DocumentStatus, EnvelopeType, type SigningStatus } from '@prisma/client';

import { getSigningInboxSection, isActionableRecipient, NON_ACTIONABLE_RECIPIENT_ROLES } from './mis-firmas-rules';

export type SigningInboxDocument = {
  id: string;
  title: string;
  createdAt: Date;
  documentStatus: DocumentStatus;

  /**
   * The state of the current user's own signature on the document.
   */
  recipientStatus: SigningStatus;

  /**
   * Only ever set for documents the user is allowed to sign right now.
   */
  signingToken: string | null;

  senderName: string;
  senderEmail: string;
};

export type SigningInbox = {
  /** Documents waiting for the user's signature. */
  pending: SigningInboxDocument[];

  /** Documents assigned to the user whose signing turn has not arrived yet. */
  waiting: SigningInboxDocument[];

  /** Documents the user has already signed or rejected. */
  completed: SigningInboxDocument[];
};

/**
 * Find every document which has been shared with the given user as a signer and split them
 * into the three sections of the "My signatures" inbox.
 *
 * The classification itself lives in `mis-firmas-rules.ts`; this only loads the documents and
 * applies it. Only pending documents carry a signing token, so the rest of the list never
 * hands out signing access the user would not otherwise have.
 */
export const findSigningInbox = async ({ userId }: { userId: number }): Promise<SigningInbox> => {
  const user = await prisma.user.findFirstOrThrow({
    where: {
      id: userId,
    },
    select: {
      email: true,
    },
  });

  const envelopes = await prisma.envelope.findMany({
    where: {
      type: EnvelopeType.DOCUMENT,
      status: {
        not: DocumentStatus.DRAFT,
      },
      deletedAt: null,
      recipients: {
        some: {
          email: user.email,
          role: {
            notIn: NON_ACTIONABLE_RECIPIENT_ROLES,
          },
        },
      },
    },
    orderBy: {
      createdAt: 'desc',
    },
    select: {
      id: true,
      title: true,
      createdAt: true,
      status: true,
      user: {
        select: {
          name: true,
          email: true,
        },
      },
      documentMeta: {
        select: {
          signingOrder: true,
        },
      },
      recipients: {
        select: {
          id: true,
          email: true,
          role: true,
          signingOrder: true,
          signingStatus: true,
          token: true,
        },
      },
    },
  });

  const signingInbox: SigningInbox = {
    pending: [],
    waiting: [],
    completed: [],
  };

  for (const envelope of envelopes) {
    const recipient = envelope.recipients.find(
      (envelopeRecipient) => envelopeRecipient.email === user.email && isActionableRecipient(envelopeRecipient),
    );

    if (!recipient) {
      continue;
    }

    const section = getSigningInboxSection({
      documentStatus: envelope.status,
      signingOrder: envelope.documentMeta?.signingOrder,
      recipients: envelope.recipients,
      recipient,
    });

    if (section === 'none') {
      continue;
    }

    const document: SigningInboxDocument = {
      id: envelope.id,
      title: envelope.title,
      createdAt: envelope.createdAt,
      documentStatus: envelope.status,
      recipientStatus: recipient.signingStatus,
      signingToken: section === 'pending' ? recipient.token : null,
      senderName: envelope.user.name ?? envelope.user.email,
      senderEmail: envelope.user.email,
    };

    signingInbox[section].push(document);
  }

  return signingInbox;
};
