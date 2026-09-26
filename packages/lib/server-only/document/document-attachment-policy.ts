import type { RecipientRole } from '@prisma/client';

import { logger } from '../../utils/logger';
import { resolveAccountForAuthorization } from '../auth/resolve-account-for-authorization';
import { canDownloadDocument } from './download-policy';

export type CanAttachDocumentPdfOptions = {
  /**
   * The addressee of the email. The decision is taken on this address' own
   * account, never on the sender's.
   */
  email: string;

  /**
   * The recipient role when the addressee is a recipient of the envelope.
   */
  recipientRole?: RecipientRole | null;
};

/**
 * Whether the document may be attached to an email addressed to `email`, decided
 * at send time.
 *
 * The policy is the download policy of the addressee: a controlled signer never
 * receives the document, and neither does a sign only account - which matters for
 * an account which owned documents before being restricted. An addressee with no
 * account is an external recipient and is ruled by its recipient role alone.
 *
 * Failures never resolve to allow. When the account lookup cannot be completed
 * the attachment is dropped and the error logged, so the send still happens but
 * without the document; a caller which would rather retry should call
 * {@link resolveAccountForAuthorization} itself and let the failure escape.
 */
export const canAttachDocumentPdfToAddressee = async ({
  email,
  recipientRole,
}: CanAttachDocumentPdfOptions): Promise<boolean> => {
  if (recipientRole && !canDownloadDocument({ recipient: { role: recipientRole } })) {
    return false;
  }

  try {
    const account = await resolveAccountForAuthorization(email);

    return canDownloadDocument({ account: account ? { roles: account.roles } : null });
  } catch (error) {
    logger.error({
      msg: 'Refusing to attach a document because the addressee account could not be resolved',
      email,
      err: error,
    });

    return false;
  }
};

/**
 * The subset of the given addresses which may receive the document as an
 * attachment at send time.
 */
export const filterAddresseesAllowedToReceiveDocumentPdf = async (emails: string[]): Promise<string[]> => {
  const decisions = await Promise.all(
    emails.map(async (email) => ({
      email,
      canReceiveDocument: await canAttachDocumentPdfToAddressee({ email }),
    })),
  );

  return decisions.filter((decision) => decision.canReceiveDocument).map((decision) => decision.email);
};
