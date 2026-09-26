import { isCcRecipient, sortRecipientsForSigningOrder } from '@documenso/lib/utils/recipients';
import { prisma } from '@documenso/prisma';
import type { Recipient } from '@prisma/client';
import { DocumentSigningOrder, DocumentStatus, EnvelopeType, RecipientRole, SigningStatus } from '@prisma/client';

/**
 * The recipient fields required to work out where a signer sits in the signing order.
 */
type RecipientForSigningOrder = Pick<Recipient, 'id' | 'email' | 'role' | 'signingOrder' | 'signingStatus' | 'token'>;

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
 * Whether the recipient is the one who is allowed to sign at this point in time.
 *
 * Mirrors the server side rule used when a signing link is opened
 * (`getIsRecipientsTurnToSign`), but resolved against recipients which have already been
 * loaded so a list of documents can be classified without a query per row.
 */
const getIsRecipientTurn = ({
  recipients,
  recipient,
  signingOrder,
}: {
  recipients: RecipientForSigningOrder[];
  recipient: RecipientForSigningOrder;
  signingOrder: DocumentSigningOrder | null | undefined;
}) => {
  // Anything other than a sequential document lets every recipient sign in parallel.
  if (signingOrder !== DocumentSigningOrder.SEQUENTIAL) {
    return true;
  }

  const orderedRecipients = sortRecipientsForSigningOrder(recipients);

  const recipientIndex = orderedRecipients.findIndex((orderedRecipient) => orderedRecipient.id === recipient.id);

  if (recipientIndex === -1) {
    return false;
  }

  // CC recipients have no action to take, so they can never block the flow.
  return orderedRecipients.slice(0, recipientIndex).every((orderedRecipient) => {
    return isCcRecipient(orderedRecipient) || orderedRecipient.signingStatus === SigningStatus.SIGNED;
  });
};

/**
 * Find every document which has been shared with the given user as a signer and split them
 * into the three sections of the "My signatures" inbox.
 *
 * Only documents the user can act on carry a signing token, so the rest of the list never
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
            not: RecipientRole.CC,
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
      (envelopeRecipient) => envelopeRecipient.email === user.email && !isCcRecipient(envelopeRecipient),
    );

    if (!recipient) {
      continue;
    }

    const document: SigningInboxDocument = {
      id: envelope.id,
      title: envelope.title,
      createdAt: envelope.createdAt,
      documentStatus: envelope.status,
      recipientStatus: recipient.signingStatus,
      signingToken: null,
      senderName: envelope.user.name ?? envelope.user.email,
      senderEmail: envelope.user.email,
    };

    // Signing or rejecting is terminal for the recipient, so the document moves to the
    // history whatever happens to it afterwards.
    if (recipient.signingStatus !== SigningStatus.NOT_SIGNED) {
      signingInbox.completed.push(document);
      continue;
    }

    const isRecipientTurn = getIsRecipientTurn({
      recipients: envelope.recipients,
      recipient,
      signingOrder: envelope.documentMeta?.signingOrder,
    });

    if (isRecipientTurn) {
      signingInbox.pending.push({
        ...document,
        signingToken: recipient.token,
      });
      continue;
    }

    signingInbox.waiting.push(document);
  }

  return signingInbox;
};
