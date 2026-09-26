import { isCcRecipient, sortRecipientsForSigningOrder } from '@documenso/lib/utils/recipients';
import type { Recipient } from '@prisma/client';
import { DocumentSigningOrder, DocumentStatus, RecipientRole, SigningStatus } from '@prisma/client';

/**
 * The recipient fields needed to place a recipient in the signing order.
 */
export type SigningInboxRecipient = Pick<Recipient, 'id' | 'email' | 'role' | 'signingOrder' | 'signingStatus'>;

/**
 * The section of the inbox a document belongs to, if any.
 */
export type SigningInboxSection = 'pending' | 'waiting' | 'completed' | 'none';

/**
 * The roles which never have an action to take on a document.
 *
 * This inbox only lists documents which are waiting for the user's signature or which carry a
 * signature the user already gave, and neither is true of a viewer or a CC: they are never
 * asked to sign and they never produce a signature, so they have nothing to do here.
 *
 * `getRecipientRoleCapabilities().canSign` is deliberately not the filter — it only covers the
 * roles which fill in a signature field, while approvers and assistants are actionable too.
 */
export const NON_ACTIONABLE_RECIPIENT_ROLES: RecipientRole[] = [RecipientRole.CC, RecipientRole.VIEWER];

/**
 * Whether the recipient is one the inbox can list at all.
 */
export const isActionableRecipient = (recipient: Pick<Recipient, 'role'>) => {
  return !NON_ACTIONABLE_RECIPIENT_ROLES.includes(recipient.role);
};

/**
 * Whether the recipient is the one who is allowed to sign at this point in time.
 *
 * Mirrors the server side rule used when a signing link is opened
 * (`getIsRecipientsTurnToSign`), but resolved against recipients which have already been
 * loaded so a list of documents can be classified without a query per row.
 */
export const getIsRecipientTurn = ({
  recipients,
  recipient,
  signingOrder,
}: {
  recipients: SigningInboxRecipient[];
  recipient: SigningInboxRecipient;
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
 * Decide which section of the "My signatures" inbox a document belongs to.
 *
 * A recipient which already signed or rejected the document belongs to the history, whatever
 * happens to the document afterwards. A document which can no longer be signed belongs
 * nowhere: the recipient has no action left to take and no signature of their own to report,
 * so it is left out instead of being offered as something to act on.
 */
export const getSigningInboxSection = ({
  documentStatus,
  signingOrder,
  recipients,
  recipient,
}: {
  documentStatus: DocumentStatus;
  signingOrder: DocumentSigningOrder | null | undefined;
  recipients: SigningInboxRecipient[];
  recipient: SigningInboxRecipient;
}): SigningInboxSection => {
  if (recipient.signingStatus !== SigningStatus.NOT_SIGNED) {
    return 'completed';
  }

  if (documentStatus !== DocumentStatus.PENDING) {
    return 'none';
  }

  return getIsRecipientTurn({ recipients, recipient, signingOrder }) ? 'pending' : 'waiting';
};
