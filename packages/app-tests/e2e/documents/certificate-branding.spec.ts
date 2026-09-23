import fs from 'node:fs/promises';
import { encryptSecondaryData } from '@documenso/lib/server-only/crypto/encrypt';
import { mapSecondaryIdToDocumentId } from '@documenso/lib/utils/envelope';
import { getEnvelopeItemPdfUrl } from '@documenso/lib/utils/envelope-download';
import { prisma } from '@documenso/prisma';
import { seedPendingDocumentWithFullFields } from '@documenso/prisma/seed/documents';
import { seedUser } from '@documenso/prisma/seed/users';
import { createCanvas } from '@napi-rs/canvas';
import { expect, type Page, test } from '@playwright/test';
import { DocumentDataType, DocumentStatus, FieldType } from '@prisma/client';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import pixelMatch from 'pixelmatch';
import { PNG } from 'pngjs';

import { apiSignin } from '../fixtures/authentication';
import { signSignaturePad } from '../fixtures/signature';

/**
 * The certificate is stamped with the brand the envelope is pinned to, before
 * the PDF is sealed. These tests cover the pinned brand, the unbranded fallback
 * and the fact that the certificate no longer carries a verification QR.
 */
test.describe.configure({ mode: 'parallel', timeout: 120_000 });

const PDF_RENDER_SCALE = 2;

/** Colours chosen so they cannot occur anywhere in the certificate layout. */
const PINNED_BRAND_COLOUR = { r: 255, g: 0, b: 255 };
const LIVE_BRAND_COLOUR = { r: 0, g: 200, b: 255 };

const BRAND_LOGO_WIDTH = 160;
const BRAND_LOGO_HEIGHT = 40;

const BRANDING_LABEL = 'Signing certificate provided by';
const DOCUMENT_PAGE_SNIPPET = 'OPEN SOURCE PRINCIPLES WAIVER';

type Rgb = { r: number; g: number; b: number };

const createBrandLogo = async (colour: Rgb) => {
  const canvas = createCanvas(BRAND_LOGO_WIDTH, BRAND_LOGO_HEIGHT);
  const context = canvas.getContext('2d');
  context.fillStyle = `rgb(${colour.r}, ${colour.g}, ${colour.b})`;
  context.fillRect(0, 0, BRAND_LOGO_WIDTH, BRAND_LOGO_HEIGHT);

  return Buffer.from(await canvas.encode('png'));
};

const toBrandLogoReference = (logo: Buffer) =>
  JSON.stringify({ type: DocumentDataType.BYTES_64, data: logo.toString('base64') });

const publishOrganisationBranding = async ({
  organisationGlobalSettingsId,
  brandingLogo,
}: {
  organisationGlobalSettingsId: string;
  brandingLogo: string;
}) => {
  await prisma.organisationGlobalSettings.update({
    where: { id: organisationGlobalSettingsId },
    data: {
      brandingEnabled: true,
      brandingLogo,
    },
  });
};

const enableSigningCertificate = async (teamId: number) => {
  const teamSettings = await prisma.teamGlobalSettings.findFirstOrThrow({
    where: { team: { id: teamId } },
  });

  await prisma.teamGlobalSettings.update({
    where: { id: teamSettings.id },
    data: { includeSigningCertificate: true },
  });
};

const fetchEnvelopeItemPdf = async ({
  envelopeId,
  token,
  version,
}: {
  envelopeId: string;
  token: string;
  version: 'original' | 'signed';
}) => {
  const envelopeItem = await prisma.envelopeItem.findFirstOrThrow({ where: { envelopeId } });

  const url = getEnvelopeItemPdfUrl({
    type: 'download',
    envelopeItem,
    token,
    version,
  });

  const pdfData = await fetch(url).then(async (response) => await response.arrayBuffer());

  return new Uint8Array(pdfData);
};

/**
 * pdfjs takes ownership of the buffer it is handed and detaches it, so every
 * call must receive a copy: the raw byte range check and the pixel renders read
 * the same download.
 */
const loadPdfWithPdfjs = (pdfBytes: Uint8Array) => pdfjsLib.getDocument({ data: new Uint8Array(pdfBytes) }).promise;

const readPdfPageTexts = async (pdfBytes: Uint8Array) => {
  const pdf = await loadPdfWithPdfjs(pdfBytes);

  return await Promise.all(
    Array.from({ length: pdf.numPages }, async (_, index) => {
      const page = await pdf.getPage(index + 1);
      const content = await page.getTextContent();

      return content.items
        .map((item) => ('str' in item ? item.str : ''))
        .join('')
        .replace(/\s+/g, ' ')
        .trim();
    }),
  );
};

const renderPdfPages = async (pdfBytes: Uint8Array) => {
  const pdf = await loadPdfWithPdfjs(pdfBytes);

  return await Promise.all(
    Array.from({ length: pdf.numPages }, async (_, index) => {
      const page = await pdf.getPage(index + 1);
      const viewport = page.getViewport({ scale: PDF_RENDER_SCALE });
      const canvas = createCanvas(viewport.width, viewport.height);
      const canvasContext = canvas.getContext('2d');

      await page.render({
        // @ts-expect-error @napi-rs/canvas satisfies runtime requirements for pdfjs
        canvas,
        // @ts-expect-error @napi-rs/canvas satisfies runtime requirements for pdfjs
        canvasContext,
        viewport,
      }).promise;

      return Buffer.from(await canvas.encode('png'));
    }),
  );
};

const countColour = (image: Buffer, colour: Rgb, tolerance = 32) => {
  const { data, width, height } = PNG.sync.read(image);

  let count = 0;

  for (let index = 0; index < width * height; index++) {
    const offset = index * 4;

    if (
      Math.abs(data[offset] - colour.r) <= tolerance &&
      Math.abs(data[offset + 1] - colour.g) <= tolerance &&
      Math.abs(data[offset + 2] - colour.b) <= tolerance
    ) {
      count++;
    }
  }

  return count;
};

/** Number of pixels two renders of the same page disagree on. */
const countDifferentPixels = (first: Buffer, second: Buffer) => {
  const firstImage = PNG.sync.read(first);
  const secondImage = PNG.sync.read(second);

  const diff = new PNG({ width: firstImage.width, height: firstImage.height });

  return pixelMatch(
    new Uint8Array(firstImage.data),
    new Uint8Array(secondImage.data),
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    diff.data as unknown as Uint8Array,
    firstImage.width,
    firstImage.height,
    {
      threshold: 0.1,
    },
  );
};

/**
 * A QR code would cover roughly ten thousand pixels of the certificate page at
 * this render scale, so this budget still fails loudly if one is drawn again,
 * while absorbing the handful of pixels a background job can change (an audit
 * log row landing between the two downloads).
 */
const MAX_CERTIFICATE_PIXEL_DRIFT = 2000;

/**
 * Waits for the post-seal jobs (completion emails, audit rows) to stop writing
 * before the certificate is rendered twice and compared.
 */
const waitForAuditLogsToSettle = async (envelopeId: string) => {
  let previousCount = -1;

  await expect
    .poll(
      async () => {
        const count = await prisma.documentAuditLog.count({ where: { envelopeId } });

        const isSettled = count === previousCount;

        previousCount = count;

        return isSettled;
      },
      { timeout: 20_000 },
    )
    .toBe(true);
};

/**
 * Applying the brand happens before the seal, so the whole file — certificate
 * pages included — must sit inside the signature's byte range.
 */
const expectSignatureCoversWholeFile = (pdfBytes: Uint8Array) => {
  expect(pdfBytes.byteLength, 'the downloaded PDF must not be an empty buffer').toBeGreaterThan(0);

  const raw = Buffer.from(pdfBytes).toString('latin1');

  const byteRange = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/.exec(raw);

  expect(byteRange, 'the sealed document must carry a signature byte range').not.toBeNull();

  if (!byteRange) {
    return;
  }

  const [start1, length1, start2, length2] = byteRange.slice(1).map(Number);

  expect(start1).toBe(0);
  expect(start2 + length2).toBeGreaterThanOrEqual(raw.length - 4);
  expect(start2).toBeGreaterThan(length1);
  expect(raw.slice(byteRange.index, raw.length)).toContain('/Contents');
};

const signDocumentAndWaitForSeal = async ({
  page,
  envelopeId,
  recipient,
}: {
  page: Page;
  envelopeId: string;
  recipient: { token: string; fields: { id: number }[] };
}) => {
  await page.goto(`/sign/${recipient.token}`);

  await signSignaturePad(page);

  for (const field of recipient.fields) {
    await page.locator(`#field-${field.id}`).getByRole('button').click();

    await expect(page.locator(`#field-${field.id}`)).toHaveAttribute('data-inserted', 'true');
  }

  await page.getByRole('button', { name: 'Complete' }).click();
  await page.waitForTimeout(1000);
  await page.getByRole('button', { name: 'Sign' }).click({ force: true });
  await page.waitForURL(`/sign/${recipient.token}/complete`);

  await expect
    .poll(async () => {
      const envelope = await prisma.envelope.findFirstOrThrow({ where: { id: envelopeId } });

      return envelope.status;
    })
    .toBe(DocumentStatus.COMPLETED);
};

const downloadCertificateFromDocumentPage = async ({
  page,
  email,
  teamUrl,
  documentId,
}: {
  page: Page;
  email: string;
  teamUrl: string;
  documentId: number;
}) => {
  await apiSignin({
    page,
    email,
    redirectPath: `/t/${teamUrl}/documents/${documentId}/logs`,
  });

  const downloadButton = page.getByRole('button', { name: 'Download Certificate' });

  await expect(downloadButton).toBeEnabled();

  const downloadPromise = page.waitForEvent('download');

  await downloadButton.click();

  const download = await downloadPromise;
  const filePath = await download.path();

  if (!filePath) {
    throw new Error('The certificate download did not produce a file');
  }

  return new Uint8Array(await fs.readFile(filePath));
};

const certificatePageUrl = (documentId: number) => {
  const payload = encryptSecondaryData({
    data: documentId.toString(),
    expiresAt: Date.now() + 5 * 60 * 1000,
  });

  return `/__htmltopdf/certificate?d=${encodeURIComponent(payload)}`;
};

test('[CERTIFICATE_BRANDING]: a pinned brand is stamped into the sealed certificate', async ({ page }) => {
  const { user, team, organisation } = await seedUser();

  await publishOrganisationBranding({
    organisationGlobalSettingsId: organisation.organisationGlobalSettingsId,
    brandingLogo: toBrandLogoReference(await createBrandLogo(PINNED_BRAND_COLOUR)),
  });

  await enableSigningCertificate(team.id);

  const { document, recipients } = await seedPendingDocumentWithFullFields({
    owner: user,
    teamId: team.id,
    recipients: ['sealed-brand-certificate-signer@test.documenso.com'],
    fields: [FieldType.SIGNATURE],
  });

  const recipient = recipients[0];

  const originalPdf = await fetchEnvelopeItemPdf({
    envelopeId: document.id,
    token: recipient.token,
    version: 'original',
  });
  const originalPages = await readPdfPageTexts(originalPdf);

  await signDocumentAndWaitForSeal({ page, recipient, envelopeId: document.id });

  const sealedPdf = await fetchEnvelopeItemPdf({ envelopeId: document.id, token: recipient.token, version: 'signed' });

  // The page inventory is untouched: the document keeps its pages, and the
  // certificate is appended after them.
  const sealedPages = await readPdfPageTexts(sealedPdf);

  expect(sealedPages.length).toBe(originalPages.length + 1);
  expect(sealedPages[0]).toContain(DOCUMENT_PAGE_SNIPPET);

  // The brand is part of the signed bytes.
  expectSignatureCoversWholeFile(sealedPdf);

  const renderedPages = await renderPdfPages(sealedPdf);
  const certificatePage = renderedPages[renderedPages.length - 1];

  expect(countColour(certificatePage, PINNED_BRAND_COLOUR)).toBeGreaterThan(500);

  for (const documentPage of renderedPages.slice(0, -1)) {
    expect(countColour(documentPage, PINNED_BRAND_COLOUR)).toBe(0);
  }

  const certificateText = sealedPages[sealedPages.length - 1];

  expect(certificateText).toContain(BRANDING_LABEL);
  expect(certificateText).not.toMatch(/https?:\/\/|\/share\//);
});

test('[CERTIFICATE_BRANDING]: an unbranded certificate falls back to the Documenso mark', async ({ page }) => {
  const { user, team } = await seedUser();

  await enableSigningCertificate(team.id);

  const { document, recipients } = await seedPendingDocumentWithFullFields({
    owner: user,
    teamId: team.id,
    recipients: ['fallback-certificate-signer@test.documenso.com'],
    fields: [FieldType.SIGNATURE],
  });

  const recipient = recipients[0];

  const originalPdf = await fetchEnvelopeItemPdf({
    envelopeId: document.id,
    token: recipient.token,
    version: 'original',
  });
  const originalPages = await readPdfPageTexts(originalPdf);

  await signDocumentAndWaitForSeal({ page, recipient, envelopeId: document.id });

  const sealedPdf = await fetchEnvelopeItemPdf({ envelopeId: document.id, token: recipient.token, version: 'signed' });
  const sealedPages = await readPdfPageTexts(sealedPdf);

  expect(sealedPages.length).toBe(originalPages.length + 1);
  expect(sealedPages[0]).toContain(DOCUMENT_PAGE_SNIPPET);

  expectSignatureCoversWholeFile(sealedPdf);

  const renderedPages = await renderPdfPages(sealedPdf);

  for (const renderedPage of renderedPages) {
    expect(countColour(renderedPage, PINNED_BRAND_COLOUR)).toBe(0);
  }

  expect(sealedPages[sealedPages.length - 1]).toContain(BRANDING_LABEL);
});

/**
 * The certificate regenerated on demand must match the brand the document was
 * sealed with. It must also be free of the verification QR: changing the
 * envelope's `qrToken` cannot change a single pixel of the certificate.
 */
test('[CERTIFICATE_BRANDING]: the on-demand certificate keeps the pinned brand and no QR', async ({ page }) => {
  const { user, team, organisation } = await seedUser();

  await publishOrganisationBranding({
    organisationGlobalSettingsId: organisation.organisationGlobalSettingsId,
    brandingLogo: toBrandLogoReference(await createBrandLogo(PINNED_BRAND_COLOUR)),
  });

  await enableSigningCertificate(team.id);

  const { document, recipients } = await seedPendingDocumentWithFullFields({
    owner: user,
    teamId: team.id,
    recipients: ['on-demand-certificate-signer@test.documenso.com'],
    fields: [FieldType.SIGNATURE],
  });

  const recipient = recipients[0];

  await signDocumentAndWaitForSeal({ page, recipient, envelopeId: document.id });
  await waitForAuditLogsToSettle(document.id);

  // The live branding drifts after the seal: the regenerated certificate must
  // keep the brand the document was sealed with.
  await publishOrganisationBranding({
    organisationGlobalSettingsId: organisation.organisationGlobalSettingsId,
    brandingLogo: toBrandLogoReference(await createBrandLogo(LIVE_BRAND_COLOUR)),
  });

  const documentId = mapSecondaryIdToDocumentId(document.secondaryId);

  const firstCertificate = await downloadCertificateFromDocumentPage({
    page,
    email: user.email,
    teamUrl: team.url,
    documentId,
  });

  const firstCertificatePages = await renderPdfPages(firstCertificate);
  const firstCertificatePage = firstCertificatePages[firstCertificatePages.length - 1];

  expect(countColour(firstCertificatePage, PINNED_BRAND_COLOUR)).toBeGreaterThan(500);
  expect(countColour(firstCertificatePage, LIVE_BRAND_COLOUR)).toBe(0);

  // A QR code would encode this token, so a different token must render the
  // exact same certificate.
  await prisma.envelope.update({
    where: { id: document.id },
    data: { qrToken: 'qr_e8d_certificate_branding_test' },
  });

  const secondCertificate = await downloadCertificateFromDocumentPage({
    page,
    email: user.email,
    teamUrl: team.url,
    documentId,
  });

  const secondCertificatePages = await renderPdfPages(secondCertificate);

  expect(secondCertificatePages.length).toBe(firstCertificatePages.length);

  const certificateDrift = countDifferentPixels(
    firstCertificatePage,
    secondCertificatePages[secondCertificatePages.length - 1],
  );

  expect(certificateDrift).toBeLessThan(MAX_CERTIFICATE_PIXEL_DRIFT);
});

test('[CERTIFICATE_BRANDING]: the certificate page renders the pinned brand mark and no QR', async ({ page }) => {
  const { user, team, organisation } = await seedUser();

  await publishOrganisationBranding({
    organisationGlobalSettingsId: organisation.organisationGlobalSettingsId,
    brandingLogo: toBrandLogoReference(await createBrandLogo(PINNED_BRAND_COLOUR)),
  });

  const { document } = await seedPendingDocumentWithFullFields({
    owner: user,
    teamId: team.id,
    recipients: ['branded-certificate-page-signer@test.documenso.com'],
    fields: [FieldType.SIGNATURE],
  });

  // The certificate page is rendered while the envelope is still pending, so
  // the QR token exists but must not be rendered anywhere.
  await prisma.envelope.update({
    where: { id: document.id },
    data: { qrToken: 'qr_e8d_certificate_page_test' },
  });

  await page.goto(certificatePageUrl(mapSecondaryIdToDocumentId(document.secondaryId)));

  const brandLogo = page.locator('img[data-testid="certificate-brand-logo"]');

  await expect(brandLogo).toBeVisible();
  await expect
    .poll(async () => brandLogo.evaluate((image) => (image as HTMLImageElement).naturalWidth))
    .toBe(BRAND_LOGO_WIDTH);

  // The QR was the only other SVG on this page, so nothing else may be drawn.
  await expect(page.locator('svg:not([data-testid="certificate-brand-logo"])')).toHaveCount(0);
  await expect(page.locator('a[href*="/share/"]')).toHaveCount(0);
  expect(await page.content()).not.toContain('qr_e8d_certificate_page_test');
});

test('[CERTIFICATE_BRANDING]: the certificate page falls back to the Documenso mark', async ({ page }) => {
  const { user, team } = await seedUser();

  const { document } = await seedPendingDocumentWithFullFields({
    owner: user,
    teamId: team.id,
    recipients: ['unbranded-certificate-page-signer@test.documenso.com'],
    fields: [FieldType.SIGNATURE],
  });

  await prisma.envelope.update({
    where: { id: document.id },
    data: { qrToken: 'qr_e8d_certificate_page_fallback_test' },
  });

  await page.goto(certificatePageUrl(mapSecondaryIdToDocumentId(document.secondaryId)));

  await expect(page.locator('svg[data-testid="certificate-brand-logo"]')).toBeVisible();
  await expect(page.locator('img[data-testid="certificate-brand-logo"]')).toHaveCount(0);

  // The fallback mark is the only SVG the certificate page may render.
  await expect(page.locator('svg:not([data-testid="certificate-brand-logo"])')).toHaveCount(0);
  await expect(page.locator('a[href*="/share/"]')).toHaveCount(0);
  expect(await page.content()).not.toContain('qr_e8d_certificate_page_fallback_test');
});
