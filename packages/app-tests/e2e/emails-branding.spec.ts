import fs from 'node:fs/promises';
import path from 'node:path';

import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { prisma } from '@documenso/prisma';
import { seedTestEmail } from '@documenso/prisma/seed/users';
import { type APIRequestContext, expect, test } from '@playwright/test';
import { DocumentDataType } from '@prisma/client';

import { apiCreateTestContext, apiDistributeEnvelope, apiSeedDraftDocument } from './fixtures/api-seeds';

test.describe.configure({ mode: 'parallel' });

/**
 * Inbucket (the test mail server started by `npm run dx:up`) exposes its HTTP
 * API on port 9000.
 */
const INBUCKET_URL = 'http://localhost:9000';

const BRANDING_URL = 'https://brand.example/emails';
const PINNED_COMPANY_DETAILS = 'Pinned Co';
const CHANGED_COMPANY_DETAILS = 'Changed Co';

/**
 * The two logos have different pixel dimensions, so the bytes the email shows
 * (the pinned ones) can never be confused with the current live logo.
 */
const PINNED_LOGO_FILE = 'logo.png';
const CHANGED_LOGO_FILE = 'logo_icon.png';

const readBrandingLogo = async (fileName: string) => {
  const logo = await fs.readFile(path.join(__dirname, '../../assets', fileName));

  return JSON.stringify({
    type: DocumentDataType.BYTES_64,
    data: logo.toString('base64'),
  });
};

type SeedBrandingContext = Awaited<ReturnType<typeof apiCreateTestContext>>;

const updateTeamBranding = async ({
  teamGlobalSettingsId,
  brandingLogo,
  brandingCompanyDetails,
}: {
  teamGlobalSettingsId: string;
  brandingLogo: string;
  brandingCompanyDetails: string;
}) => {
  await prisma.teamGlobalSettings.update({
    where: { id: teamGlobalSettingsId },
    data: {
      brandingEnabled: true,
      brandingLogo,
      brandingCompanyDetails,
      brandingUrl: BRANDING_URL,
    },
  });
};

/**
 * Create a draft envelope while the given branding is live, so the envelope
 * pins it.
 */
const seedPinnedDraftEnvelope = async ({
  request,
  context,
  brandingLogo,
  brandingCompanyDetails,
  recipientEmail,
}: {
  request: APIRequestContext;
  context: SeedBrandingContext;
  brandingLogo: string;
  brandingCompanyDetails: string;
  recipientEmail: string;
}) => {
  await updateTeamBranding({
    teamGlobalSettingsId: context.team.teamGlobalSettingsId,
    brandingLogo,
    brandingCompanyDetails,
  });

  const { envelope } = await apiSeedDraftDocument(request, {
    context,
    title: '[TEST] Pinned email branding',
    recipients: [{ email: recipientEmail, name: 'Signer', role: 'SIGNER' }],
    fieldsPerRecipient: [[{ type: 'SIGNATURE', page: 1, positionX: 10, positionY: 10, width: 15, height: 5 }]],
  });

  // The envelope pins the branding it was created with: everything sent in its
  // context must render from this snapshot, not from the live settings.
  const { brandingSnapshot } = await prisma.envelope.findUniqueOrThrow({
    where: { id: envelope.id },
    select: { brandingSnapshot: true },
  });

  expect(brandingSnapshot).toMatchObject({
    enabled: true,
    companyDetails: brandingCompanyDetails,
  });

  return envelope;
};

/**
 * The messages currently sitting in the recipient's test mailbox. An unknown
 * mailbox has no messages rather than an error response.
 */
const getMailboxMessages = async (email: string) => {
  const mailbox = email.split('@')[0];

  const response = await fetch(`${INBUCKET_URL}/api/v1/mailbox/${mailbox}`);

  if (!response.ok) {
    return [];
  }

  return (await response.json()) as { id: string }[];
};

/**
 * The HTML body of the email the recipient received.
 *
 * The signing email is sent by a background job, so the send may land slightly
 * after the distribute request resolves.
 */
const getReceivedEmailHtml = async (email: string) => {
  const mailbox = email.split('@')[0];

  let html = '';

  await expect(async () => {
    const messages = await getMailboxMessages(email);

    expect(messages.length).toBeGreaterThan(0);

    // Inbucket returns the newest message first.
    const messageDetails = await fetch(`${INBUCKET_URL}/api/v1/mailbox/${mailbox}/${messages[0].id}`).then(
      async (res) => await res.json(),
    );

    expect(messageDetails.body?.html).toBeTruthy();

    html = messageDetails.body.html as string;
  }).toPass({ timeout: 30_000, intervals: [500, 1000, 2000] });

  return html;
};

test('[EMAILS BRANDING]: an envelope email keeps the branding pinned when it was created', async ({ request }) => {
  const context = await apiCreateTestContext('e2e-emails-branding');
  const recipientEmail = seedTestEmail();

  const envelope = await seedPinnedDraftEnvelope({
    request,
    context,
    brandingLogo: await readBrandingLogo(PINNED_LOGO_FILE),
    brandingCompanyDetails: PINNED_COMPANY_DETAILS,
    recipientEmail,
  });

  // The branding is edited while the envelope is in flight.
  await updateTeamBranding({
    teamGlobalSettingsId: context.team.teamGlobalSettingsId,
    brandingLogo: await readBrandingLogo(CHANGED_LOGO_FILE),
    brandingCompanyDetails: CHANGED_COMPANY_DETAILS,
  });

  await apiDistributeEnvelope(request, context.token, envelope.id);

  const html = await getReceivedEmailHtml(recipientEmail);

  // The email renders the branding the envelope was pinned to.
  expect(html).toContain(PINNED_COMPANY_DETAILS);
  expect(html).not.toContain(CHANGED_COMPANY_DETAILS);

  // The live logo endpoint no longer serves the pinned bytes, so the pinned
  // logo is inlined instead of pointing at a logo that was never part of this
  // envelope.
  expect(html).toContain('data:image/png;base64,');
  expect(html).not.toContain(`/api/branding/logo/team/${context.team.id}`);
});

test('[EMAILS BRANDING]: an envelope email uses the live logo while the branding matches the pin', async ({
  request,
}) => {
  const context = await apiCreateTestContext('e2e-emails-branding-live');
  const recipientEmail = seedTestEmail();

  const envelope = await seedPinnedDraftEnvelope({
    request,
    context,
    brandingLogo: await readBrandingLogo(PINNED_LOGO_FILE),
    brandingCompanyDetails: PINNED_COMPANY_DETAILS,
    recipientEmail,
  });

  await apiDistributeEnvelope(request, context.token, envelope.id);

  const html = await getReceivedEmailHtml(recipientEmail);

  expect(html).toContain(PINNED_COMPANY_DETAILS);

  // Nothing drifted, so the email keeps pointing at the live endpoint rather
  // than carrying the logo bytes around.
  expect(html).toContain(`${NEXT_PUBLIC_WEBAPP_URL()}/api/branding/logo/team/${context.team.id}`);
});
