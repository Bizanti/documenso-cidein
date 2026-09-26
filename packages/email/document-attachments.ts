import type { Attachment } from 'nodemailer/lib/mailer';

/**
 * Whether an attachment carries a document.
 *
 * Inline parts (the pinned branding logo, referenced through `cid`) are never
 * documents, and only the document PDFs are subject to the attachment policy.
 */
export const isDocumentAttachment = (attachment: Attachment) =>
  attachment.contentType === 'application/pdf' && !attachment.cid;

/**
 * The attachments a message may actually carry.
 *
 * Applied at send time, once the addressee of the message is known: the policy
 * which decides `mayReceiveDocuments` is resolved per addressee, because a
 * document may only travel to an account which is allowed to download it.
 */
export const resolveDocumentAttachments = (attachments: Attachment[], mayReceiveDocuments: boolean): Attachment[] => {
  if (mayReceiveDocuments) {
    return attachments;
  }

  return attachments.filter((attachment) => !isDocumentAttachment(attachment));
};
