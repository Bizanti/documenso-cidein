import type { Attachment } from 'nodemailer/lib/mailer';
import { describe, expect, it } from 'vitest';

import { isDocumentAttachment, resolveDocumentAttachments } from './document-attachments';

const documentAttachment: Attachment = {
  filename: 'document.pdf',
  content: Buffer.from('pdf'),
  contentType: 'application/pdf',
};

const brandingLogo: Attachment = {
  filename: 'logo.png',
  content: Buffer.from('png'),
  contentType: 'image/png',
  cid: 'branding-logo',
};

const pdfBrandingLogo: Attachment = {
  filename: 'logo.pdf',
  content: Buffer.from('pdf'),
  contentType: 'application/pdf',
  cid: 'branding-logo',
};

describe('isDocumentAttachment', () => {
  it('recognises the document pdf', () => {
    expect(isDocumentAttachment(documentAttachment)).toBe(true);
  });

  it('never treats an inline part as a document', () => {
    expect(isDocumentAttachment(brandingLogo)).toBe(false);
    expect(isDocumentAttachment(pdfBrandingLogo)).toBe(false);
  });

  it('ignores attachments which are not documents', () => {
    expect(isDocumentAttachment({ filename: 'notes.txt', content: 'hi' })).toBe(false);
  });
});

describe('resolveDocumentAttachments', () => {
  it('hands the attachments over when the addressee may receive them', () => {
    expect(resolveDocumentAttachments([documentAttachment], true)).toEqual([documentAttachment]);
  });

  it('withholds the documents while keeping the inline parts', () => {
    expect(resolveDocumentAttachments([documentAttachment, brandingLogo], false)).toEqual([brandingLogo]);
  });

  it('leaves an empty list alone', () => {
    expect(resolveDocumentAttachments([], false)).toEqual([]);
  });
});
