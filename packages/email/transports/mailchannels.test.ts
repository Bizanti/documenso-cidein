import { createTransport } from 'nodemailer';
import type Mail from 'nodemailer/lib/mailer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MailChannelsTransport } from './mailchannels';

const ENDPOINT = 'https://mailchannels.test/tx/v1/send';
const API_KEY = 'test-api-key';

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

type MailChannelsAttachmentBody = {
  type: string;
  filename: string;
  content: string;
  content_id?: string;
};

type MailChannelsBody = {
  html?: string;
  attachments?: MailChannelsAttachmentBody[];
};

/** Runs a send through the transport with the HTTP request stubbed out. */
const captureRequestBody = async (attachments: Mail.Attachment[]) => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));

  vi.stubGlobal('fetch', fetchMock);

  const transporter = createTransport(MailChannelsTransport.makeTransport({ apiKey: API_KEY, endpoint: ENDPOINT }));

  await transporter.sendMail({
    from: { name: 'Sender', address: 'sender@test.documenso.com' },
    to: 'signer@test.documenso.com',
    subject: 'Sign this',
    text: 'Sign this',
    html: LOGO_HTML,
    attachments,
  });

  const [url, request] = fetchMock.mock.calls[0] as [string, { body: string; headers: Record<string, string> }];

  return { url, headers: request.headers, body: JSON.parse(request.body) as MailChannelsBody };
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MailChannelsTransport', () => {
  describe('inline branding logo', () => {
    it('posts the logo as content_id with its bytes base64-encoded', async () => {
      const { url, headers, body } = await captureRequestBody([LOGO_ATTACHMENT]);

      const [logo] = body.attachments ?? [];

      expect(url).toBe(ENDPOINT);
      expect(headers['X-Auth-Token']).toBe(API_KEY);
      expect(logo).toEqual({
        type: 'image/png',
        filename: 'branding-logo.png',
        content: LOGO_BYTES.toString('base64'),
        content_id: LOGO_CONTENT_ID,
      });
    });

    it('posts the content id the HTML references', async () => {
      const { body } = await captureRequestBody([LOGO_ATTACHMENT]);

      const [logo] = body.attachments ?? [];
      const referencedContentId = /cid:([^"]+)/.exec(LOGO_HTML)?.[1];

      expect(referencedContentId).toBe(LOGO_CONTENT_ID);
      expect(logo.content_id).toBe(referencedContentId);
      expect(Buffer.from(logo.content, 'base64')).toEqual(LOGO_BYTES);
    });

    it('sends the attachments the sender already had alongside the logo', async () => {
      const { body } = await captureRequestBody([DOCUMENT_ATTACHMENT, LOGO_ATTACHMENT]);

      expect(body.attachments).toEqual([
        {
          type: 'application/pdf',
          filename: 'signed-document.pdf',
          content: DOCUMENT_BYTES.toString('base64'),
        },
        {
          type: 'image/png',
          filename: 'branding-logo.png',
          content: LOGO_BYTES.toString('base64'),
          content_id: LOGO_CONTENT_ID,
        },
      ]);
    });
  });
});
