import fs from 'node:fs/promises';
import path from 'node:path';

import { formatDirectTemplatePath } from '@documenso/lib/utils/templates';
import { prisma } from '@documenso/prisma';
import { seedPendingDocumentWithFullFields } from '@documenso/prisma/seed/documents';
import { seedDirectTemplate } from '@documenso/prisma/seed/templates';
import { seedUser } from '@documenso/prisma/seed/users';
import { expect, type Page, test } from '@playwright/test';
import { DocumentDataType, FieldType } from '@prisma/client';

const BRANDING_URL = 'https://brand.example/signing?source=documenso';
const PDF_PAGE_SELECTOR = 'img[data-page-number]';

/**
 * The two logos have different pixel dimensions, so the rendered
 * `naturalWidth` tells which of the two the signing page is showing.
 */
const PINNED_LOGO_WIDTH = 2248;
const CHANGED_LOGO_WIDTH = 320;

const readBrandingLogo = async (fileName = 'logo.png') => {
  const logo = await fs.readFile(path.join(__dirname, '../../assets', fileName));

  return JSON.stringify({
    type: DocumentDataType.BYTES_64,
    data: logo.toString('base64'),
  });
};

const enableOrganisationBranding = async ({
  organisationGlobalSettingsId,
  brandingUrl = BRANDING_URL,
  brandingLogo,
}: {
  organisationGlobalSettingsId: string;
  brandingUrl?: string;
  brandingLogo?: string;
}) => {
  await prisma.organisationGlobalSettings.update({
    where: { id: organisationGlobalSettingsId },
    data: {
      brandingEnabled: true,
      brandingLogo: brandingLogo ?? (await readBrandingLogo()),
      brandingUrl,
    },
  });
};

/**
 * On signing surfaces the custom branding logo must render as a plain image.
 * It must not be wrapped in any link, and the Brand Website must never appear
 * as a link on these pages.
 */
const expectPlainBrandingLogo = async (page: Page, logoName: string) => {
  const logo = page.getByRole('img', { name: logoName });

  await expect(logo).toBeVisible();

  // The custom logo must not be wrapped in a link.
  await expect(page.getByRole('link', { name: logoName })).toHaveCount(0);

  // The Brand Website must never be rendered as a link on signing pages.
  await expect(page.locator(`a[href="${BRANDING_URL}"]`)).toHaveCount(0);
};

/**
 * Assert which of the two logos the signing page is actually rendering, by
 * comparing the decoded width of the image the browser painted.
 */
const expectRenderedLogoWidth = async (page: Page, logoName: string, width: number) => {
  const logo = page.getByRole('img', { name: logoName });

  await expect(logo).toBeVisible();

  await expect.poll(async () => logo.evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBe(width);
};

test('[SIGNING_BRANDING]: V1 normal signing renders custom logo as a plain image', async ({ page }) => {
  const { user, team, organisation } = await seedUser();

  await enableOrganisationBranding({
    organisationGlobalSettingsId: organisation.organisationGlobalSettingsId,
  });

  const { recipients } = await seedPendingDocumentWithFullFields({
    owner: user,
    teamId: team.id,
    recipients: ['v1-branding-signer@test.documenso.com'],
    fields: [FieldType.SIGNATURE],
  });

  await page.goto(`/sign/${recipients[0].token}`);

  await expectPlainBrandingLogo(page, `${team.name}'s Logo`);
});

test('[SIGNING_BRANDING]: V2 signing renders custom logo as a plain image', async ({ page }) => {
  const { user, team, organisation } = await seedUser();

  await enableOrganisationBranding({
    organisationGlobalSettingsId: organisation.organisationGlobalSettingsId,
  });

  const { recipients } = await seedPendingDocumentWithFullFields({
    owner: user,
    teamId: team.id,
    recipients: ['v2-branding-signer@test.documenso.com'],
    fields: [FieldType.SIGNATURE],
    updateDocumentOptions: { internalVersion: 2 },
  });

  const directTemplate = await seedDirectTemplate({
    title: 'V2 Branding Direct Template',
    userId: user.id,
    teamId: team.id,
    internalVersion: 2,
  });

  await page.goto(`/sign/${recipients[0].token}`);
  await expectPlainBrandingLogo(page, `${team.name}'s Logo`);

  await page.goto(formatDirectTemplatePath(directTemplate.directLink?.token || ''));
  await expectPlainBrandingLogo(page, `${team.name}'s Logo`);
});

test('[SIGNING_BRANDING]: V2 signing keeps internal link for the Documenso fallback logo', async ({ page }) => {
  const { user, team } = await seedUser();

  const { recipients } = await seedPendingDocumentWithFullFields({
    owner: user,
    teamId: team.id,
    recipients: ['v2-fallback-signer@test.documenso.com'],
    fields: [FieldType.SIGNATURE],
    updateDocumentOptions: { internalVersion: 2 },
  });

  await page.goto(`/sign/${recipients[0].token}`);

  const fallbackLogoLink = page.locator('a[href="/"]').first();

  await expect(fallbackLogoLink).toBeVisible();
});

test('[SIGNING_BRANDING]: embedded signing does not render custom logo Brand Website links', async ({ page }) => {
  const { user, team, organisation } = await seedUser();

  await enableOrganisationBranding({
    organisationGlobalSettingsId: organisation.organisationGlobalSettingsId,
  });

  const { recipients } = await seedPendingDocumentWithFullFields({
    owner: user,
    teamId: team.id,
    recipients: ['embed-branding-signer@test.documenso.com'],
    fields: [FieldType.SIGNATURE],
    updateDocumentOptions: { internalVersion: 2 },
  });

  await page.goto(`/embed/sign/${recipients[0].token}`);
  await expect(page.locator(PDF_PAGE_SELECTOR).first()).toBeVisible({ timeout: 30_000 });

  await expect(page.locator(`a[href="${BRANDING_URL}"]`)).toHaveCount(0);
  await expect(page.getByRole('link', { name: `${team.name}'s Logo` })).toHaveCount(0);
});

/**
 * The branding is pinned when the envelope is created, so a signing page that
 * is already in flight must keep showing the pinned logo even after the team
 * or organisation branding changes — the signer saw that version, and that is
 * the version the envelope's evidence refers to.
 */
test('[SIGNING_BRANDING]: in-flight signing keeps the pinned logo when the branding changes', async ({ page }) => {
  const { user, team, organisation } = await seedUser();

  await enableOrganisationBranding({
    organisationGlobalSettingsId: organisation.organisationGlobalSettingsId,
  });

  const v2Document = await seedPendingDocumentWithFullFields({
    owner: user,
    teamId: team.id,
    recipients: ['pinned-v2-branding-signer@test.documenso.com'],
    fields: [FieldType.SIGNATURE],
    updateDocumentOptions: { internalVersion: 2 },
  });

  const v1Document = await seedPendingDocumentWithFullFields({
    owner: user,
    teamId: team.id,
    recipients: ['pinned-v1-branding-signer@test.documenso.com'],
    fields: [FieldType.SIGNATURE],
  });

  // Branding enabled at creation → the pinned logo is rendered.
  await page.goto(`/sign/${v2Document.recipients[0].token}`);
  await expectRenderedLogoWidth(page, `${team.name}'s Logo`, PINNED_LOGO_WIDTH);

  await page.goto(`/sign/${v1Document.recipients[0].token}`);
  await expectRenderedLogoWidth(page, `${team.name}'s Logo`, PINNED_LOGO_WIDTH);

  // Disable branding while the envelopes are in flight.
  await prisma.organisationGlobalSettings.update({
    where: { id: organisation.organisationGlobalSettingsId },
    data: { brandingEnabled: false },
  });

  // The pinned logo survives, and the Documenso fallback logo (inside the
  // signer header nav) must still not be shown.
  await page.goto(`/sign/${v2Document.recipients[0].token}`);
  await expectRenderedLogoWidth(page, `${team.name}'s Logo`, PINNED_LOGO_WIDTH);
  await expect(page.locator('nav a[href="/"]')).toHaveCount(0);

  await page.goto(`/sign/${v1Document.recipients[0].token}`);
  await expectRenderedLogoWidth(page, `${team.name}'s Logo`, PINNED_LOGO_WIDTH);
  await expect(page.locator('nav a[href="/"]')).toHaveCount(0);

  // Re-enable branding with a different logo: the pinned bytes are still the
  // ones the signer sees.
  await enableOrganisationBranding({
    organisationGlobalSettingsId: organisation.organisationGlobalSettingsId,
    brandingLogo: await readBrandingLogo('logo_icon.png'),
  });

  await page.goto(`/sign/${v2Document.recipients[0].token}`);
  await expectRenderedLogoWidth(page, `${team.name}'s Logo`, PINNED_LOGO_WIDTH);

  await page.goto(`/sign/${v1Document.recipients[0].token}`);
  await expectRenderedLogoWidth(page, `${team.name}'s Logo`, PINNED_LOGO_WIDTH);
});

/**
 * Only envelopes created after a branding change use the new version.
 */
test('[SIGNING_BRANDING]: envelopes created after a branding change use the new logo', async ({ page }) => {
  const { user, team, organisation } = await seedUser();

  await enableOrganisationBranding({
    organisationGlobalSettingsId: organisation.organisationGlobalSettingsId,
  });

  const pinnedDocument = await seedPendingDocumentWithFullFields({
    owner: user,
    teamId: team.id,
    recipients: ['pinned-before-change-signer@test.documenso.com'],
    fields: [FieldType.SIGNATURE],
    updateDocumentOptions: { internalVersion: 2 },
  });

  await enableOrganisationBranding({
    organisationGlobalSettingsId: organisation.organisationGlobalSettingsId,
    brandingLogo: await readBrandingLogo('logo_icon.png'),
  });

  const newDocument = await seedPendingDocumentWithFullFields({
    owner: user,
    teamId: team.id,
    recipients: ['created-after-change-signer@test.documenso.com'],
    fields: [FieldType.SIGNATURE],
    updateDocumentOptions: { internalVersion: 2 },
  });

  await page.goto(`/sign/${newDocument.recipients[0].token}`);
  await expectRenderedLogoWidth(page, `${team.name}'s Logo`, CHANGED_LOGO_WIDTH);

  await page.goto(`/sign/${pinnedDocument.recipients[0].token}`);
  await expectRenderedLogoWidth(page, `${team.name}'s Logo`, PINNED_LOGO_WIDTH);
});
