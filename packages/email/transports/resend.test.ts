import { Readable } from 'node:stream';
import { createTransport } from 'nodemailer';
import type Mail from 'nodemailer/lib/mailer';
import type MailMessage from 'nodemailer/lib/mailer/mail-message';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ResendTransport } from './resend';

/** A 1x1 PNG: the bytes a pinned branding logo carries. */
const LOGO_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);
const LOGO_CONTENT_ID = 'branding-logo-039058c6f2c0cb49';
const LOGO_ATTACHMENT: Mail.Attachment = {
  filename: 'branding-logo.png',
  content: LOGO_BYTES.toString('base64'),
  encoding: 'base64',
  contentType: 'image/png',
  cid: LOGO_CONTENT_ID,
};

const DOCUMENT_BYTES = Buffer.from('%PDF-1.7 signed document');
const DOCUMENT_ATTACHMENT: Mail.Attachment = {
  filename: 'signed-document.pdf',
  content: DOCUMENT_BYTES,
  contentType: 'application/pdf',
};

const LOGO_HTML = `<p>Signed</p><img src="cid:${LOGO_CONTENT_ID}" alt="logo" />`;

const MAIL: Mail.Options = {
  from: { name: 'Sender', address: 'sender@test.documenso.com' },
  to: 'signer@test.documenso.com',
  subject: 'Sign this',
  text: 'Sign this',
  html: LOGO_HTML,
};

/** The attachment as the transport hands it to the Resend SDK. */
type ResendAttachmentPayload = {
  filename: string;
  content: string;
  contentType?: string;
  contentId?: string;
};

type ResendPayload = {
  html: string;
  attachments: ResendAttachmentPayload[];
};

/** The attachment as the SDK serializes it for the Resend API. */
type ResendApiAttachment = {
  filename: string;
  content: string;
  content_type?: string;
  content_id?: string;
};

type ResendApiBody = {
  html: string;
  attachments: ResendApiAttachment[];
};

/** Runs a send through the transport with the Resend client replaced by a spy. */
const captureClientPayload = async (mailData: Mail.Options): Promise<ResendPayload> => {
  const send = vi.fn().mockResolvedValue({ data: { id: 'fake-id' }, error: null });

  const transport = new ResendTransport({ apiKey: 'test-api-key' });

  (transport as unknown as { _client: { emails: { send: typeof send } } })._client = { emails: { send } };

  await new Promise<void>((resolve, reject) => {
    transport.send({ data: mailData } as unknown as MailMessage, (err) => (err ? reject(err) : resolve()));
  });

  return send.mock.calls[0][0] as ResendPayload;
};

/** Runs a send through the SDK with the API request stubbed out. */
const captureApiRequest = async (mailData: Mail.Options) => {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ id: 'fake-id' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );

  vi.stubGlobal('fetch', fetchMock);

  const transporter = createTransport(ResendTransport.makeTransport({ apiKey: 'test-api-key' }));

  await transporter.sendMail(mailData);

  const [url, request] = fetchMock.mock.calls[0] as [string, { body: string }];

  return { url, body: JSON.parse(request.body) as ResendApiBody };
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ResendTransport', () => {
  describe('inline branding logo', () => {
    it('hands the SDK the content id the HTML references and the logo bytes', async () => {
      const payload = await captureClientPayload({ ...MAIL, attachments: [LOGO_ATTACHMENT] });

      const [logo] = payload.attachments;
      const referencedContentId = /cid:([^"]+)/.exec(payload.html)?.[1];

      expect(referencedContentId).toBe(LOGO_CONTENT_ID);
      expect(logo.contentId).toBe(referencedContentId);
      expect(Buffer.from(logo.content, 'base64')).toEqual(LOGO_BYTES);
    });

    it('posts the logo under content_id with its bytes as base64', async () => {
      const { url, body } = await captureApiRequest({ ...MAIL, attachments: [LOGO_ATTACHMENT] });

      const [logo] = body.attachments;

      expect(url).toBe('https://api.resend.com/emails');
      expect(logo.content_id).toBe(LOGO_CONTENT_ID);
      expect(logo.content).toBe(LOGO_BYTES.toString('base64'));
      expect(Buffer.from(logo.content, 'base64')).toEqual(LOGO_BYTES);
    });

    it('sends the attachments the sender already had alongside the logo', async () => {
      const payload = await captureClientPayload({
        ...MAIL,
        attachments: [DOCUMENT_ATTACHMENT, LOGO_ATTACHMENT],
      });

      expect(payload.attachments).toEqual([
        {
          filename: 'signed-document.pdf',
          content: DOCUMENT_BYTES.toString('base64'),
          contentType: 'application/pdf',
        },
        {
          filename: 'branding-logo.png',
          content: LOGO_BYTES.toString('base64'),
          contentType: 'image/png',
          contentId: LOGO_CONTENT_ID,
        },
      ]);
    });

    it('rejects an attachment whose content is not a string or a buffer', async () => {
      await expect(
        captureClientPayload({
          ...MAIL,
          attachments: [{ filename: 'stream.txt', content: Readable.from('content') }],
        }),
      ).rejects.toThrowError('Attachment content must be a string or a buffer');
    });
  });
});
