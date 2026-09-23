import { env } from '@documenso/lib/utils/env';
import type { SentMessageInfo, Transport } from 'nodemailer';
import type { Address, Attachment } from 'nodemailer/lib/mailer';
import type MailMessage from 'nodemailer/lib/mailer/mail-message';

import { normalizeMailHeaders } from './normalize-headers';

const VERSION = '1.0.0';

type NodeMailerAddress = string | Address | Array<string | Address> | undefined;

interface MailChannelsAddress {
  email: string;
  name?: string;
}

interface MailChannelsAttachment {
  type: string;
  filename: string;
  /** The file's bytes, base64-encoded. */
  content: string;
  /** Set to embed the file inline, referenced from the HTML as `cid:<content_id>`. */
  content_id?: string;
}

interface MailChannelsTransportOptions {
  apiKey: string;
  endpoint: string;
}

/**
 * Transport for sending email through MailChannels via Cloudflare Workers.
 *
 * Optionally allows specifying a custom endpoint and API key so you can setup a worker
 * to proxy requests to MailChannels with added security.
 *
 * @see https://blog.cloudflare.com/sending-email-from-workers-with-mailchannels/
 */
export class MailChannelsTransport implements Transport<SentMessageInfo> {
  public name = 'CloudflareMailTransport';
  public version = VERSION;

  private _options: MailChannelsTransportOptions;

  public static makeTransport(options: Partial<MailChannelsTransportOptions>) {
    return new MailChannelsTransport(options);
  }

  constructor(options: Partial<MailChannelsTransportOptions>) {
    const { apiKey = '', endpoint = 'https://api.mailchannels.net/tx/v1/send' } = options;

    this._options = {
      apiKey,
      endpoint,
    };
  }

  public send(mail: MailMessage, callback: (_err: Error | null, _info: SentMessageInfo) => void) {
    if (!mail.data.to || !mail.data.from) {
      return callback(new Error('Missing required fields "to" or "from"'), null);
    }

    const mailTo = this.toMailChannelsAddresses(mail.data.to);
    const mailCc = this.toMailChannelsAddresses(mail.data.cc);
    const mailBcc = this.toMailChannelsAddresses(mail.data.bcc);

    const [from] = this.toMailChannelsAddresses(mail.data.from);
    const [replyTo] = this.toMailChannelsAddresses(mail.data.replyTo);

    if (!from) {
      return callback(new Error('Missing required field "from"'), null);
    }

    const attachments = this.toMailChannelsAttachments(mail.data.attachments);

    const requestHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this._options.apiKey) {
      requestHeaders['X-Auth-Token'] = this._options.apiKey;
    }

    fetch(this._options.endpoint, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify({
        from: from,
        reply_to: replyTo,
        headers: normalizeMailHeaders(mail.data.headers),
        subject: mail.data.subject,
        personalizations: [
          {
            to: mailTo,
            cc: mailCc.length > 0 ? mailCc : undefined,
            bcc: mailBcc.length > 0 ? mailBcc : undefined,
            dkim_domain: env('NEXT_PRIVATE_MAILCHANNELS_DKIM_DOMAIN') || undefined,
            dkim_selector: env('NEXT_PRIVATE_MAILCHANNELS_DKIM_SELECTOR') || undefined,
            dkim_private_key: env('NEXT_PRIVATE_MAILCHANNELS_DKIM_PRIVATE_KEY') || undefined,
          },
        ],
        content: [
          {
            type: 'text/plain',
            value: mail.data.text?.toString('utf-8') ?? '',
          },
          {
            type: 'text/html',
            value: mail.data.html?.toString('utf-8') ?? '',
          },
        ],
        ...(attachments.length > 0 ? { attachments } : {}),
      }),
    })
      .then((res) => {
        if (res.status >= 200 && res.status <= 299) {
          return callback(null, {
            messageId: '',
            envelope: {
              from: mail.data.from,
              to: mail.data.to,
            },
            accepted: mail.data.to,
            rejected: [],
            pending: [],
          });
        }

        res
          .json()
          .then((data) => callback(new Error(`MailChannels error: ${data.message}`), null))
          .catch((err) => callback(err, null));
      })
      .catch((err) => {
        return callback(err, null);
      });
  }

  /**
   * Converts a nodemailer address(s) to an array of MailChannel compatible address.
   */
  private toMailChannelsAddresses(address: NodeMailerAddress): Array<MailChannelsAddress> {
    if (!address) {
      return [];
    }

    if (typeof address === 'string') {
      return [{ email: address }];
    }

    if (Array.isArray(address)) {
      return address.map((address) => {
        if (typeof address === 'string') {
          return { email: address };
        }

        return {
          email: address.address,
          name: address.name,
        };
      });
    }

    return [
      {
        email: address.address,
        name: address.name,
      },
    ];
  }

  /**
   * Converts the message attachments to MailChannels content parts.
   *
   * MailChannels carries attachments as base64 `content` entries, and embeds
   * them inline when they set a `content_id` — the only form in which a `cid:`
   * reference in the HTML resolves. The pinned branding logo of an envelope
   * travels that way, so dropping attachments would leave those emails with a
   * broken logo.
   *
   * Entries this cannot express (a stream, a file path) are dropped: this
   * transport has never carried those.
   */
  private toMailChannelsAttachments(attachments: Attachment[] | undefined): MailChannelsAttachment[] {
    return (attachments ?? []).flatMap((attachment) => {
      const { content } = attachment;

      const contentBase64 =
        typeof content === 'string' && attachment.encoding === 'base64'
          ? content
          : Buffer.isBuffer(content)
            ? content.toString('base64')
            : null;

      if (!contentBase64) {
        return [];
      }

      return [
        {
          type: attachment.contentType ?? 'application/octet-stream',
          filename: typeof attachment.filename === 'string' ? attachment.filename : 'attachment',
          content: contentBase64,
          ...(attachment.cid ? { content_id: attachment.cid } : {}),
        },
      ];
    });
  }
}
