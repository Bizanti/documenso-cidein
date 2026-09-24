import type { SentMessageInfo, Transport } from 'nodemailer';
import type Mail from 'nodemailer/lib/mailer';
import type MailMessage from 'nodemailer/lib/mailer/mail-message';
import { Resend } from 'resend';

import { normalizeMailHeaders } from './normalize-headers';

const VERSION = '1.0.0';

export const RESEND_ERROR_CODES_BY_KEY = {
  missing_required_field: 422,
  invalid_idempotency_key: 400,
  invalid_idempotent_request: 409,
  concurrent_idempotent_requests: 409,
  invalid_access: 422,
  invalid_parameter: 422,
  invalid_region: 422,
  rate_limit_exceeded: 429,
  missing_api_key: 401,
  invalid_api_Key: 403,
  invalid_from_address: 403,
  validation_error: 403,
  not_found: 404,
  method_not_allowed: 405,
  application_error: 500,
  internal_server_error: 500,
} as const;

interface ResendAttachment {
  filename: string;
  /** The file's bytes, base64-encoded. */
  content: string;
  /** Optional content type, otherwise derived from the filename. */
  contentType?: string;
  /**
   * Set to embed the file inline, referenced from the HTML as `cid:<contentId>`.
   * The API field is `content_id`.
   */
  contentId?: string;
}

interface ResendTransportOptions {
  apiKey: string;
}

/**
 * Transport for sending email via the Resend SDK.
 *
 * Kept in this package instead of pulling `@documenso/nodemailer-resend`: that
 * adapter dropped the `cid` of an attachment and encoded its `content` as text,
 * so the inline branding logo of an envelope arrived without the identifier the
 * HTML points at, holding the bytes of the base64 text rather than the image.
 */
export class ResendTransport implements Transport<SentMessageInfo> {
  public name = 'ResendMailTransport';
  public version = VERSION;

  private _client: Resend;

  public static makeTransport(options: Partial<ResendTransportOptions>) {
    return new ResendTransport(options);
  }

  constructor(options: Partial<ResendTransportOptions>) {
    const { apiKey = '' } = options;

    this._client = new Resend(apiKey);
  }

  public send(mail: MailMessage, callback: (_err: Error | null, _info: SentMessageInfo) => void) {
    if (!mail.data.to || !mail.data.from) {
      return callback(new Error('Missing required fields "to" or "from"'), null);
    }

    const replyTo = this.toResendAddresses(mail.data.replyTo);

    this._client.emails
      .send({
        subject: mail.data.subject ?? '',
        from: this.toResendFromAddress(mail.data.from),
        to: this.toResendAddresses(mail.data.to),
        cc: this.toResendAddresses(mail.data.cc),
        bcc: this.toResendAddresses(mail.data.bcc),
        replyTo: replyTo.length > 0 ? replyTo : undefined,
        headers: normalizeMailHeaders(mail.data.headers),
        html: mail.data.html?.toString() || '',
        text: mail.data.text?.toString() || '',
        attachments: this.toResendAttachments(mail.data.attachments),
      })
      .then((response) => {
        if (response.error) {
          // The SDK names errors this table does not carry, which have no status
          // of their own and are reported as a server error.
          const statusCode =
            RESEND_ERROR_CODES_BY_KEY[response.error.name as keyof typeof RESEND_ERROR_CODES_BY_KEY] ?? 500;

          throw new Error(`[${statusCode}]: ${response.error.name} ${response.error.message}`);
        }

        callback(null, response.data);
      })
      .catch((error) => {
        callback(error, null);
      });
  }

  private toResendAddresses(addresses: Mail.Options['to']) {
    if (!addresses) {
      return [];
    }

    if (typeof addresses === 'string') {
      return [addresses];
    }

    if (Array.isArray(addresses)) {
      return addresses.map((address) => {
        if (typeof address === 'string') {
          return address;
        }

        return address.address;
      });
    }

    return [addresses.address];
  }

  private toResendFromAddress(address: Mail.Options['from']): string {
    if (!address) {
      return '';
    }

    if (Array.isArray(address)) {
      return this.toResendFromAddress(address[0]);
    }

    if (typeof address === 'string') {
      return address;
    }

    return `${address.name} <${address.address}>`;
  }

  /**
   * Converts the message attachments to the shape the Resend API accepts.
   *
   * The API carries attachments as base64 `content` and embeds them inline when
   * they set `contentId` — the only form in which a `cid:` reference in the HTML
   * resolves. The pinned branding logo of an envelope travels that way, so both
   * the identifier and the decoded bytes have to survive this conversion.
   *
   * Nothing else may be handed to the SDK: it serializes the payload with
   * `JSON.stringify`, so the bytes have to be base64 text by then.
   */
  private toResendAttachments(attachments: Mail.Options['attachments']): ResendAttachment[] {
    return (attachments ?? []).map((attachment) => {
      if (!attachment.filename || !attachment.content) {
        throw new Error('Attachment is missing filename or content');
      }

      const contentBase64 = this.toBase64Content(attachment);

      if (!contentBase64) {
        throw new Error('Attachment content must be a string or a buffer');
      }

      return {
        filename: attachment.filename,
        content: contentBase64,
        ...(attachment.contentType ? { contentType: attachment.contentType } : {}),
        ...(attachment.cid ? { contentId: attachment.cid } : {}),
      };
    });
  }

  /**
   * The attachment bytes, base64-encoded.
   *
   * A string `content` is the text of the file unless `encoding` says how it was
   * encoded, which is the form the base64 branding logo arrives in.
   */
  private toBase64Content(attachment: Mail.Attachment): string | null {
    const { content, encoding } = attachment;

    if (Buffer.isBuffer(content)) {
      return content.toString('base64');
    }

    if (typeof content === 'string') {
      return Buffer.from(content, encoding === 'base64' ? 'base64' : undefined).toString('base64');
    }

    return null;
  }
}
