import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { prisma } from '@documenso/prisma';
import { seedUser } from '@documenso/prisma/seed/users';
import { expect, type Page, test } from '@playwright/test';
import { DocumentDataType } from '@prisma/client';
import sharp from 'sharp';

test.describe.configure({ mode: 'parallel' });

const NEUTRAL_FAVICON_HREFS = ['/apple-touch-icon.png', '/favicon-32x32.png', '/favicon-16x16.png'];

const RED = { r: 220, g: 30, b: 30 };
const BLUE = { r: 30, g: 30, b: 220 };

type Rgb = { r: number; g: number; b: number };

const webappUrl = (pathname: string) => `${NEXT_PUBLIC_WEBAPP_URL()}${pathname}`;

/**
 * Stored-logo payload the branding flows persist, built as a solid square so
 * the icon served for it can be identified by colour.
 */
const createLogoPayload = async ({ r, g, b }: Rgb) => {
  const logo = await sharp({
    create: { width: 256, height: 256, channels: 3, background: { r, g, b } },
  })
    .png()
    .toBuffer();

  return JSON.stringify({ type: DocumentDataType.BYTES_64, data: logo.toString('base64') });
};

const seedBrandedOrganisation = async ({ logo }: { logo?: string } = {}) => {
  const { organisation } = await seedUser({ isPersonalOrganisation: false });

  if (logo) {
    await prisma.organisationGlobalSettings.update({
      where: { id: organisation.organisationGlobalSettingsId },
      data: { brandingEnabled: true, brandingLogo: logo },
    });
  }

  // `/o/:orgUrl/signin` only exists for organisations whose authentication
  // portal is enabled and entitled.
  await prisma.organisationClaim.update({
    where: { id: organisation.organisationClaimId },
    data: { flags: { allowLegacyEnvelopes: true, authenticationPortal: true } },
  });

  await prisma.organisationAuthenticationPortal.update({
    where: { id: organisation.organisationAuthenticationPortalId },
    data: { enabled: true },
  });

  return organisation;
};

const tenantFaviconHrefs = (organisationId: string) => [
  `/api/branding/favicon/organisation/${organisationId}/180`,
  `/api/branding/favicon/organisation/${organisationId}/32`,
  `/api/branding/favicon/organisation/${organisationId}/16`,
];

/**
 * Icon links of the rendered document. Read from the live DOM so the same
 * helper covers both a server-rendered load and an in-app navigation, where
 * only the client updates them.
 */
const readFaviconHrefs = async (page: Page) =>
  await page
    .locator('link[rel="icon"], link[rel="apple-touch-icon"]')
    .evaluateAll((links) => links.map((link) => link.getAttribute('href')));

const fetchHtml = async (page: Page, pathname: string) => {
  const response = await page.context().request.get(webappUrl(pathname));

  expect(response.ok()).toBeTruthy();

  return await response.text();
};

const readCentrePixel = async (icon: Buffer) => {
  const { width = 0, height = 0 } = await sharp(icon).metadata();

  const { data } = await sharp(icon)
    .extract({ left: Math.floor(width / 2), top: Math.floor(height / 2), width: 1, height: 1 })
    .raw()
    .toBuffer({ resolveWithObject: true });

  return { r: data[0], g: data[1], b: data[2] };
};

const expectFaviconSize = async (icon: Buffer, size: 16 | 32 | 180) => {
  const metadata = await sharp(icon).metadata();

  expect(metadata.format).toBe('png');
  expect(metadata.width).toBe(size);
  expect(metadata.height).toBe(size);
};

const fetchFavicon = async (page: Page, organisationId: string, size: 16 | 32 | 180) => {
  const response = await page
    .context()
    .request.get(webappUrl(`/api/branding/favicon/organisation/${organisationId}/${size}`));

  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('image/png');

  return await response.body();
};

test('[BRANDING_FAVICON]: root sign in stays neutral with no brand', async ({ page }) => {
  await page.goto('/signin');

  await expect(page.getByRole('heading', { name: 'Sign in to your account' })).toBeVisible();

  // No organisation context exists on the root sign in page, so the tab keeps
  // the Documenso icon and nothing renders a tenant brand.
  expect(await readFaviconHrefs(page)).toEqual(NEUTRAL_FAVICON_HREFS);
  await expect(page.locator('img[src*="/api/branding/"]')).toHaveCount(0);

  expect(await fetchHtml(page, '/signin')).not.toContain('/api/branding/favicon/organisation');
});

test('[BRANDING_FAVICON]: verified organisation sign in shows the organisation brand', async ({ page }) => {
  const organisation = await seedBrandedOrganisation({ logo: await createLogoPayload(RED) });

  await page.goto(`/o/${organisation.url}/signin`);

  // The brand comes from the verified organisation, served through the existing
  // logo route.
  const logo = page.getByRole('img', { name: organisation.name });

  await expect(logo).toBeVisible();
  await expect(logo).toHaveAttribute('src', `/api/branding/logo/organisation/${organisation.id}`);
  await expect(page.getByRole('link', { name: organisation.name })).toHaveCount(0);

  expect(await readFaviconHrefs(page)).toEqual(tenantFaviconHrefs(organisation.id));

  // Served in the document itself, not injected afterwards by the client.
  const html = await fetchHtml(page, `/o/${organisation.url}/signin`);

  expect(html).toContain(`/api/branding/favicon/organisation/${organisation.id}/16`);
  expect(html).toContain(`/api/branding/favicon/organisation/${organisation.id}/32`);
  expect(html).toContain(`/api/branding/favicon/organisation/${organisation.id}/180`);
});

test('[BRANDING_FAVICON]: tenant icons are generated from the organisation logo at each size', async ({ page }) => {
  const organisation = await seedBrandedOrganisation({ logo: await createLogoPayload(RED) });

  for (const size of [16, 32, 180] as const) {
    const icon = await fetchFavicon(page, organisation.id, size);

    await expectFaviconSize(icon, size);

    // The icon is derived from the stored logo rather than a placeholder.
    const { r, g, b } = await readCentrePixel(icon);

    expect(r).toBeGreaterThan(150);
    expect(g).toBeLessThan(100);
    expect(b).toBeLessThan(100);
  }
});

test('[BRANDING_FAVICON]: requests without a verified branding context stay neutral', async ({ page }) => {
  const unknownOrganisation = await page
    .context()
    .request.get(webappUrl('/api/branding/favicon/organisation/missing-org/32'), {
      maxRedirects: 0,
    });

  // Unknown organisation: the neutral static icon, not a tenant icon and not a 404.
  expect(unknownOrganisation.status()).toBe(302);
  expect(new URL(unknownOrganisation.headers().location).pathname).toBe('/favicon-32x32.png');

  const neutralIcon = await page.context().request.get(webappUrl('/favicon-32x32.png'));

  expect(neutralIcon.status()).toBe(200);
  expect(neutralIcon.headers()['content-type']).toContain('image/png');

  // Organisation without branding: same neutral icon, and its sign in page
  // renders no brand.
  const unbrandedOrganisation = await seedBrandedOrganisation();

  for (const size of [16, 32, 180] as const) {
    const response = await page
      .context()
      .request.get(webappUrl(`/api/branding/favicon/organisation/${unbrandedOrganisation.id}/${size}`), {
        maxRedirects: 0,
      });

    expect(response.status()).toBe(302);
    expect(new URL(response.headers().location).pathname).toMatch(/^\/.*\.png$/);
  }

  await page.goto(`/o/${unbrandedOrganisation.url}/signin`);

  await expect(page.getByRole('heading', { name: `Welcome to ${unbrandedOrganisation.name}` })).toBeVisible();
  expect(await readFaviconHrefs(page)).toEqual(NEUTRAL_FAVICON_HREFS);
  await expect(page.locator('img[src*="/api/branding/"]')).toHaveCount(0);

  // Unsupported sizes are rejected outright.
  const invalidSize = await page
    .context()
    .request.get(webappUrl(`/api/branding/favicon/organisation/${unbrandedOrganisation.id}/64`), { maxRedirects: 0 });

  expect(invalidSize.status()).toBe(400);
});

test('[BRANDING_FAVICON]: a stored logo that cannot be decoded falls back to the neutral icon', async ({ page }) => {
  // Branding is enabled, so the layout does advertise a tenant icon, but the
  // stored payload is not a decodable image. The icon request must degrade to
  // the neutral icon instead of failing.
  const organisation = await seedBrandedOrganisation({
    logo: JSON.stringify({ type: DocumentDataType.BYTES_64, data: Buffer.from('not an image').toString('base64') }),
  });

  const undecodable = await page
    .context()
    .request.get(webappUrl(`/api/branding/favicon/organisation/${organisation.id}/32`), { maxRedirects: 0 });

  expect(undecodable.status()).toBe(302);
  expect(new URL(undecodable.headers().location).pathname).toBe('/favicon-32x32.png');

  // A payload that is not even valid JSON behaves the same way.
  await prisma.organisationGlobalSettings.update({
    where: { id: organisation.organisationGlobalSettingsId },
    data: { brandingLogo: 'not json at all' },
  });

  const malformed = await page
    .context()
    .request.get(webappUrl(`/api/branding/favicon/organisation/${organisation.id}/32`), { maxRedirects: 0 });

  expect(malformed.status()).toBe(302);
  expect(new URL(malformed.headers().location).pathname).toBe('/favicon-32x32.png');
});

test('[BRANDING_FAVICON]: organisations never leak brands into each other', async ({ page }) => {
  const organisationA = await seedBrandedOrganisation({ logo: await createLogoPayload(RED) });
  const organisationB = await seedBrandedOrganisation({ logo: await createLogoPayload(BLUE) });

  await page.goto(`/o/${organisationA.url}/signin`);
  expect(await readFaviconHrefs(page)).toEqual(tenantFaviconHrefs(organisationA.id));

  const htmlA = await fetchHtml(page, `/o/${organisationA.url}/signin`);

  expect(htmlA).not.toContain(organisationB.id);

  const iconA = await fetchFavicon(page, organisationA.id, 32);
  const iconB = await fetchFavicon(page, organisationB.id, 32);

  const pixelA = await readCentrePixel(iconA);
  const pixelB = await readCentrePixel(iconB);

  expect(pixelA.r).toBeGreaterThan(150);
  expect(pixelA.b).toBeLessThan(100);
  expect(pixelB.b).toBeGreaterThan(150);
  expect(pixelB.r).toBeLessThan(100);

  await page.goto(`/o/${organisationB.url}/signin`);
  expect(await readFaviconHrefs(page)).toEqual(tenantFaviconHrefs(organisationB.id));

  const htmlB = await fetchHtml(page, `/o/${organisationB.url}/signin`);

  expect(htmlB).not.toContain(organisationA.id);
});

test('[BRANDING_FAVICON]: in-app navigation out of the organisation context drops the tenant icon', async ({
  page,
}) => {
  const organisation = await seedBrandedOrganisation({ logo: await createLogoPayload(RED) });

  await page.goto(`/o/${organisation.url}/signin`);
  expect(await readFaviconHrefs(page)).toEqual(tenantFaviconHrefs(organisation.id));

  // Client-side navigation: the root loader is never revalidated, so the icon
  // must be dropped by the layout itself rather than by a new document load.
  await page.getByRole('link', { name: 'Return to Documenso sign in page here' }).click();

  await expect(page).toHaveURL(/\/signin$/);
  await expect(page.getByRole('heading', { name: 'Sign in to your account' })).toBeVisible();

  expect(await readFaviconHrefs(page)).toEqual(NEUTRAL_FAVICON_HREFS);
  await expect(page.getByRole('img', { name: organisation.name })).toHaveCount(0);
});
