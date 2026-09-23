import type { SendMailOptions, Transporter } from 'nodemailer';
import type { Attachment } from 'nodemailer/lib/mailer';

import type { TBrandingLogoAttachment } from '../envelope/branding-snapshot';

/**
 * The nodemailer part that carries a pinned branding logo: base64 is what ends
 * up in the MIME part anyway, and it keeps the attachment free of binary data
 * for the callers that pass it through a serializable payload. `cid` makes
 * nodemailer move it into a `multipart/related` node, which is what makes the
 * `cid:` reference in the rendered HTML resolve.
 */
export const toMailAttachment = (attachment: TBrandingLogoAttachment): Attachment => ({
  filename: attachment.filename,
  content: attachment.contentBase64,
  encoding: 'base64',
  contentType: attachment.contentType,
  cid: attachment.contentId,
});

/**
 * Wrap a transport so every message that renders the pinned logo carries its
 * bytes as an inline MIME part.
 *
 * `getEmailContext` hands the caller the transporter it must send through, so
 * injecting the part here is what keeps the pinned logo inside the message for
 * every sender of envelope emails — the ones in this package and the ones
 * outside it. The alternative, threading `attachments` through each call site,
 * would leave any sender that was not updated referencing a `cid:` the message
 * does not carry, i.e. a broken logo.
 *
 * The part is only added to messages that actually reference it: an email that
 * does not render the branding (a notification to a third party, say) must not
 * grow an invisible attachment.
 */
export const withBrandingLogoAttachment = (
  transporter: Transporter,
  attachment: TBrandingLogoAttachment,
): Transporter =>
  new Proxy(transporter, {
    get(target, property, receiver) {
      if (property === 'sendMail') {
        return (mail: SendMailOptions) => sendMailWithBrandingLogo(target, mail, attachment);
      }

      const value = Reflect.get(target, property, receiver);

      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

const sendMailWithBrandingLogo = (
  transporter: Transporter,
  mail: SendMailOptions,
  attachment: TBrandingLogoAttachment,
) => {
  if (!referencesLogo(mail, attachment.contentId)) {
    return transporter.sendMail(mail);
  }

  return transporter.sendMail({
    ...mail,
    attachments: [...(mail.attachments ?? []), toMailAttachment(attachment)],
  });
};

/**
 * Whether the message body references the logo part. The HTML is the renderer's
 * output and the text is its plain-text twin, so either can carry the reference.
 */
const referencesLogo = (mail: SendMailOptions, contentId: string) => {
  const reference = `cid:${contentId}`;

  return [mail.html, mail.text].some((part) => {
    if (typeof part === 'string') {
      return part.includes(reference);
    }

    return Buffer.isBuffer(part) && part.includes(reference);
  });
};
