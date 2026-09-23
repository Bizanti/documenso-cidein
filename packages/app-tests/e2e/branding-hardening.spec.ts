import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { BRANDING_LOGO_MAX_SIZE_BYTES } from '@documenso/lib/constants/branding';
import { prisma } from '@documenso/prisma';
import { seedPendingDocumentWithFullFields } from '@documenso/prisma/seed/documents';
import { seedUser } from '@documenso/prisma/seed/users';
import { expect, type Page, test } from '@playwright/test';
import { FieldType } from '@prisma/client';
import sharp from 'sharp';

import { apiSignin } from './fixtures/authentication';

test.describe.configure({ mode: 'parallel' });

const WEBAPP_BASE_URL = NEXT_PUBLIC_WEBAPP_URL();

/**
 * Uploads in this spec are generated rather than read from the shared
 * `packages/assets/logo.png`: that asset measures 2248x320 and the branding logo
 * route rejects any source image above 1024x1024, so it cannot serve as the
 * positive control. The default (512x512) is the conforming fixture; the
 * dimension test asks for sizes over the cap.
 */
const createBrandingLogo = (width = 512, height = 512) =>
  sharp({ create: { width, height, channels: 3, background: { r: 10, g: 20, b: 30 } } })
    .png()
    .toBuffer();

type MultipartFile = { name: string; mimeType: string; buffer: Buffer };

/**
 * Grant the plan flags the branding surfaces need. The positive flows require
 * `allowCustomBranding` (and `embedSigningWhiteLabel` for the advanced block)
 * whenever billing is enabled; with billing disabled the gates are bypassed, so
 * this keeps the tests valid in both modes.
 */
const grantBrandingEntitlements = async (organisationClaimId: string) => {
  await prisma.organisationClaim.update({
    where: { id: organisationClaimId },
    data: { flags: { allowLegacyEnvelopes: true, allowCustomBranding: true, embedSigningWhiteLabel: true } },
  });
};

/**
 * POST a logo straight to the dedicated multipart tRPC route using the
 * authenticated browser cookies, bypassing the client-side form validation. This
 * is the only way to exercise the server-side image validation
 * (`zfdBrandingImageFile` + `assertValidBrandingLogoSource`).
 */
const postOrganisationBrandingLogo = async (page: Page, organisationId: string, file: MultipartFile | null) => {
  const multipart: Record<string, string | MultipartFile> = {
    payload: JSON.stringify({ organisationId }),
  };

  if (file) {
    multipart.brandingLogo = file;
  }

  return await page.context().request.post(`${WEBAPP_BASE_URL}/api/trpc/organisation.settings.updateBrandingLogo`, {
    multipart,
  });
};

/**
 * Calls the organisation settings update mutation directly using the
 * authenticated browser cookies. The authorisation and entitlement checks under
 * test live on the server, so the UI is deliberately bypassed.
 */
const postOrganisationSettingsUpdate = async (page: Page, organisationId: string, data: Record<string, unknown>) => {
  return await page.context().request.post(`${WEBAPP_BASE_URL}/api/trpc/organisation.settings.update`, {
    headers: { 'content-type': 'application/json' },
    data: JSON.stringify({ json: { organisationId, data } }),
  });
};

/**
 * Calls the team settings update mutation directly using the authenticated
 * browser cookies.
 */
const postTeamSettingsUpdate = async (
  page: Page,
  teamId: number,
  data: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
) => {
  return await page.context().request.post(`${WEBAPP_BASE_URL}/api/trpc/team.settings.update`, {
    headers: { 'content-type': 'application/json', 'x-team-id': teamId.toString(), ...extraHeaders },
    data: JSON.stringify({ json: { teamId, data } }),
  });
};

const getOrganisationSettings = (organisationGlobalSettingsId: string) =>
  prisma.organisationGlobalSettings.findUniqueOrThrow({ where: { id: organisationGlobalSettingsId } });

const expectRejected = (response: { ok(): boolean; status(): number }) => {
  expect(response.ok()).toBeFalsy();
  expect(response.status()).toBeGreaterThanOrEqual(400);
  expect(response.status()).toBeLessThan(500);
};

test('[BRANDING_HARDENING]: rejects a branding logo larger than 1MB', async ({ page }) => {
  const { user, organisation } = await seedUser({ isPersonalOrganisation: false });

  await grantBrandingEntitlements(organisation.organisationClaim.id);

  await apiSignin({
    page,
    email: user.email,
    redirectPath: `/o/${organisation.url}/settings/branding`,
  });

  // A real PNG padded past the file size limit: the size gate has to fire
  // before the payload is decoded.
  const oversized = Buffer.concat([await createBrandingLogo(), Buffer.alloc(BRANDING_LOGO_MAX_SIZE_BYTES)]);

  const response = await postOrganisationBrandingLogo(page, organisation.id, {
    name: 'oversized.png',
    mimeType: 'image/png',
    buffer: oversized,
  });

  expectRejected(response);

  const settings = await getOrganisationSettings(organisation.organisationGlobalSettingsId);

  expect(settings.brandingLogo).toBeFalsy();
});

test('[BRANDING_HARDENING]: rejects a PNG larger than 1024x1024 pixels', async ({ page }) => {
  const { user, organisation } = await seedUser({ isPersonalOrganisation: false });

  await grantBrandingEntitlements(organisation.organisationClaim.id);

  await apiSignin({
    page,
    email: user.email,
    redirectPath: `/o/${organisation.url}/settings/branding`,
  });

  // Positive control: a valid logo is accepted, so the stored value below is a
  // real value that the rejected uploads must leave untouched.
  const validResponse = await postOrganisationBrandingLogo(page, organisation.id, {
    name: 'logo.png',
    mimeType: 'image/png',
    buffer: await createBrandingLogo(),
  });

  expect(validResponse.ok()).toBeTruthy();

  const afterValid = await getOrganisationSettings(organisation.organisationGlobalSettingsId);

  expect(afterValid.brandingLogo).toBeTruthy();

  // One pixel over the cap on either side is rejected rather than downscaled.
  for (const [width, height] of [
    [1025, 512],
    [512, 1025],
  ]) {
    const response = await postOrganisationBrandingLogo(page, organisation.id, {
      name: 'too-large.png',
      mimeType: 'image/png',
      buffer: await createBrandingLogo(width, height),
    });

    expectRejected(response);
  }

  const afterRejections = await getOrganisationSettings(organisation.organisationGlobalSettingsId);

  expect(afterRejections.brandingLogo).toBe(afterValid.brandingLogo);
});

test('[BRANDING_HARDENING]: rejects a logo whose declared MIME type does not match its bytes', async ({ page }) => {
  const { user, organisation } = await seedUser({ isPersonalOrganisation: false });

  await grantBrandingEntitlements(organisation.organisationClaim.id);

  await apiSignin({
    page,
    email: user.email,
    redirectPath: `/o/${organisation.url}/settings/branding`,
  });

  // JPEG bytes announced as `image/png`: the MIME allowlist alone would let this
  // through, so it is the magic byte check that has to reject it.
  const jpeg = await sharp({ create: { width: 256, height: 256, channels: 3, background: { r: 10, g: 20, b: 30 } } })
    .jpeg()
    .toBuffer();

  const mislabelled = await postOrganisationBrandingLogo(page, organisation.id, {
    name: 'mislabelled.png',
    mimeType: 'image/png',
    buffer: jpeg,
  });

  expectRejected(mislabelled);

  // Same bytes with an honest content type: only PNG is accepted in this phase.
  const jpegResponse = await postOrganisationBrandingLogo(page, organisation.id, {
    name: 'logo.jpg',
    mimeType: 'image/jpeg',
    buffer: jpeg,
  });

  expectRejected(jpegResponse);

  const settings = await getOrganisationSettings(organisation.organisationGlobalSettingsId);

  expect(settings.brandingLogo).toBeFalsy();
});

test('[BRANDING_HARDENING]: ignores custom branding CSS sent to the settings update', async ({ page }) => {
  const { user, organisation } = await seedUser({ isPersonalOrganisation: false });

  await grantBrandingEntitlements(organisation.organisationClaim.id);

  await apiSignin({
    page,
    email: user.email,
    redirectPath: `/o/${organisation.url}/settings/branding`,
  });

  // Custom CSS is disabled: the field is still accepted so older clients keep
  // working, but its value must never reach the database.
  const response = await postOrganisationSettingsUpdate(page, organisation.id, {
    brandingEnabled: true,
    brandingCss: '.documenso-branded .branding-hardening-marker { display: none; }',
  });

  expect(response.ok()).toBeTruthy();

  const settings = await getOrganisationSettings(organisation.organisationGlobalSettingsId);

  expect(settings.brandingEnabled).toBe(true);
  expect(settings.brandingCss).toBeFalsy();
});

test('[BRANDING_HARDENING]: ignores custom branding CSS sent to the team settings update', async ({ page }) => {
  const { user, team, organisation } = await seedUser({ isPersonalOrganisation: false });

  await grantBrandingEntitlements(organisation.organisationClaim.id);

  await apiSignin({
    page,
    email: user.email,
    redirectPath: `/t/${team.url}/settings/branding`,
  });

  const response = await postTeamSettingsUpdate(page, team.id, {
    brandingEnabled: true,
    brandingCss: '.documenso-branded .branding-hardening-marker { display: none; }',
  });

  expect(response.ok()).toBeTruthy();

  const teamWithSettings = await prisma.team.findUniqueOrThrow({
    where: { id: team.id },
    include: { teamGlobalSettings: true },
  });

  expect(teamWithSettings.teamGlobalSettings?.brandingEnabled).toBe(true);
  expect(teamWithSettings.teamGlobalSettings?.brandingCss).toBeFalsy();
});

test('[BRANDING_HARDENING]: never injects a stored custom CSS value on signing pages', async ({ page }) => {
  const { user, team, organisation } = await seedUser();

  // Simulate a value written by an older version, before custom CSS was
  // disabled, next to a brand colour so the page is genuinely branded.
  await prisma.organisationGlobalSettings.update({
    where: { id: organisation.organisationGlobalSettingsId },
    data: {
      brandingEnabled: true,
      brandingColors: { primary: '#123456' },
      brandingCss: '.documenso-branded .branding-hardening-marker { display: none; }',
    },
  });

  const { recipients } = await seedPendingDocumentWithFullFields({
    owner: user,
    teamId: team.id,
    recipients: ['branding-css-signer@test.documenso.com'],
    fields: [FieldType.SIGNATURE],
    updateDocumentOptions: { internalVersion: 2 },
  });

  const response = await page.goto(`/sign/${recipients[0].token}`);

  expect(response?.ok()).toBeTruthy();

  // Assert on the CSS the page actually applies, not on the raw HTML: the stored
  // value still travels inside the React Router hydration payload (loader data),
  // so `page.content()` legitimately contains the string.
  const injectedCss = await page
    .locator('style')
    .evaluateAll((styleElements) => styleElements.map((style) => style.textContent ?? '').join('\n'));

  // The branding style block is rendered and the colour variables applied, so
  // the check below is meaningful rather than vacuous.
  expect(injectedCss).toContain('.documenso-branded');

  // ...and the stored custom CSS is never emitted as CSS.
  expect(injectedCss).not.toContain('branding-hardening-marker');
});

test('[BRANDING_HARDENING]: renders the custom CSS field disabled with a notice', async ({ page }) => {
  const { user, organisation } = await seedUser({ isPersonalOrganisation: false });

  await grantBrandingEntitlements(organisation.organisationClaim.id);

  await apiSignin({
    page,
    email: user.email,
    redirectPath: `/o/${organisation.url}/settings/branding`,
  });

  // While branding is off, the whole advanced block sits under a
  // `bg-background/60` overlay that intercepts pointer events, so enable
  // branding before opening the CSS accordion.
  await page.getByTestId('enable-branding').click();
  await page.getByRole('option', { name: 'Yes' }).click();

  await page.getByRole('button', { name: 'Advanced — Custom CSS' }).click();

  await expect(page.getByTestId('branding-css-textarea')).toBeDisabled();
  await expect(page.getByText('Custom CSS is disabled', { exact: true })).toBeVisible();
});

test('[BRANDING_HARDENING]: rejects organisation branding settings without the custom-branding entitlement', async ({
  page,
}) => {
  // The entitlement is only enforced when billing is enabled; with billing off
  // the check is intentionally skipped server-side, so this can't be exercised.
  test.skip(
    process.env.NEXT_PUBLIC_FEATURE_BILLING_ENABLED !== 'true',
    'Entitlement is only enforced when billing is enabled.',
  );

  const { user, organisation } = await seedUser({ isPersonalOrganisation: false });

  await apiSignin({
    page,
    email: user.email,
    redirectPath: `/o/${organisation.url}/settings/branding`,
  });

  const response = await postOrganisationSettingsUpdate(page, organisation.id, {
    brandingEnabled: true,
    brandingCompanyDetails: 'written-without-entitlement',
  });

  expectRejected(response);

  const settings = await getOrganisationSettings(organisation.organisationGlobalSettingsId);

  expect(settings.brandingEnabled).not.toBe(true);
  expect(settings.brandingCompanyDetails).not.toBe('written-without-entitlement');
});

test('[BRANDING_HARDENING]: rejects team branding settings without the custom-branding entitlement', async ({
  page,
}) => {
  test.skip(
    process.env.NEXT_PUBLIC_FEATURE_BILLING_ENABLED !== 'true',
    'Entitlement is only enforced when billing is enabled.',
  );

  const { user, team } = await seedUser({ isPersonalOrganisation: false });

  await apiSignin({
    page,
    email: user.email,
    redirectPath: `/t/${team.url}/settings/branding`,
  });

  const response = await postTeamSettingsUpdate(page, team.id, {
    brandingEnabled: true,
    brandingCompanyDetails: 'written-without-entitlement',
  });

  expectRejected(response);

  const teamWithSettings = await prisma.team.findUniqueOrThrow({
    where: { id: team.id },
    include: { teamGlobalSettings: true },
  });

  expect(teamWithSettings.teamGlobalSettings?.brandingEnabled).not.toBe(true);
  expect(teamWithSettings.teamGlobalSettings?.brandingCompanyDetails).not.toBe('written-without-entitlement');
});
