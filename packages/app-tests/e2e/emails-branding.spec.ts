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

const PINNED_LOGO_WIDTH = 2248;
const CHANGED_LOGO_WIDTH = 320;

/** The inline part the pinned logo travels in, named by the resolver. */
const PINNED_LOGO_FILENAME = 'branding-logo.png';

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

type ReceivedEmail = {
  id: string;
  html: string;
  /** The bytes of the inline logo part the message carries. */
  logo: Buffer;
};

const fetchInbucketJson = async (url: string) => fetch(url).then(async (res) => await res.json());

const fetchBytes = async (url: string) =>
  Buffer.from(new Uint8Array(await fetch(url).then(async (res) => await res.arrayBuffer())));

const getMessage = async (email: string, messageId: string): Promise<ReceivedEmail | null> => {
  const mailbox = email.split('@')[0];

  const details = await fetchInbucketJson(`${INBUCKET_URL}/api/v1/mailbox/${mailbox}/${messageId}`);

  if (!details?.body?.html) {
    return null;
  }

  const attachment = (details.attachments ?? []).find(
    (part: { filename?: string }) => part.filename === PINNED_LOGO_FILENAME,
  );

  if (!attachment?.['download-link']) {
    return null;
  }

  return {
    id: messageId,
    html: details.body.html as string,
    logo: await fetchBytes(attachment['download-link'] as string),
  };
};

/**
 * The email the recipient received, with the logo part it carries.
 *
 * An envelope email is sent by a background job, so the send lands slightly
 * after the distribute request resolves.
 */
const getReceivedEmail = async (email: string): Promise<ReceivedEmail> => {
  let messageId = '';
  let html = '';
  let logo = Buffer.alloc(0);

  await expect(async () => {
    const messages = await getMailboxMessages(email);

    expect(messages.length).toBeGreaterThan(0);

    // Inbucket returns the newest message first.
    const message = await getMessage(email, messages[0].id);

    expect(message).not.toBeNull();

    messageId = message?.id ?? '';
    html = message?.html ?? '';
    logo = message?.logo ?? Buffer.alloc(0);
  }).toPass({ timeout: 30_000, intervals: [500, 1000, 2000] });

  return { id: messageId, html, logo };
};

/**
 * The width encoded in a PNG's IHDR chunk. The two branding logos differ only
 * in size, so this tells which of them a set of bytes is.
 */
const pngWidth = (buffer: Buffer) => buffer.readUInt32BE(16);

/** The bytes the live logo endpoint serves for a team right now. */
const getLiveBrandingLogo = async (teamId: number) => {
  const response = await fetch(`${NEXT_PUBLIC_WEBAPP_URL()}/api/branding/logo/team/${teamId}`);

  expect(response.ok).toBe(true);

  return Buffer.from(await response.arrayBuffer());
};

/**
 * A pinned email must never reference the live logo endpoint: it resolves the
 * branding of the moment, so a message opened later would show a logo the
 * envelope never used — or a broken image when the branding was disabled since.
 */
const expectNoLiveLogoReference = (email: ReceivedEmail, teamId: number) => {
  expect(email.html).not.toContain(`/api/branding/logo/team/${teamId}`);
  expect(email.html).not.toContain('data:image/png;base64,');
  expect(email.html).toContain('cid:branding-logo-');
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

  const email = await getReceivedEmail(recipientEmail);

  // The email renders the branding the envelope was pinned to.
  expect(email.html).toContain(PINNED_COMPANY_DETAILS);
  expect(email.html).not.toContain(CHANGED_COMPANY_DETAILS);

  // The pinned logo travels inside the message as an inline part, so the bytes
  // it shows cannot change afterwards.
  expectNoLiveLogoReference(email, context.team.id);
  expect(pngWidth(email.logo)).toBe(PINNED_LOGO_WIDTH);
});

test('[EMAILS BRANDING]: an envelope email carries the pinned logo while the live branding matches', async ({
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

  const email = await getReceivedEmail(recipientEmail);

  expect(email.html).toContain(PINNED_COMPANY_DETAILS);

  // Nothing drifted, and the email still carries the pinned bytes rather than
  // pointing at the live endpoint: a message that was already sent must keep
  // showing the logo of the envelope even if the branding changes later.
  expectNoLiveLogoReference(email, context.team.id);
  expect(pngWidth(email.logo)).toBe(PINNED_LOGO_WIDTH);
});

test('[EMAILS BRANDING]: an email sent before a branding change still shows the pinned logo', async ({ request }) => {
  const context = await apiCreateTestContext('e2e-emails-branding-after-change');
  const recipientEmail = seedTestEmail();

  const envelope = await seedPinnedDraftEnvelope({
    request,
    context,
    brandingLogo: await readBrandingLogo(PINNED_LOGO_FILE),
    brandingCompanyDetails: PINNED_COMPANY_DETAILS,
    recipientEmail,
  });

  await apiDistributeEnvelope(request, context.token, envelope.id);

  const sent = await getReceivedEmail(recipientEmail);

  expect(pngWidth(sent.logo)).toBe(PINNED_LOGO_WIDTH);

  // The branding changes after the email was sent — the case that used to leave
  // the message pointing at the live endpoint.
  await updateTeamBranding({
    teamGlobalSettingsId: context.team.teamGlobalSettingsId,
    brandingLogo: await readBrandingLogo(CHANGED_LOGO_FILE),
    brandingCompanyDetails: CHANGED_COMPANY_DETAILS,
  });

  // The live endpoint now serves the changed logo, which is exactly what the
  // email must not be reading from.
  expect(pngWidth(await getLiveBrandingLogo(context.team.id))).toBe(CHANGED_LOGO_WIDTH);

  // Opening the message again shows the same bytes it was sent with.
  const reopened = await getMessage(recipientEmail, sent.id);

  expect(reopened).not.toBeNull();

  const stillPinned = reopened as ReceivedEmail;

  expect(stillPinned.html).toBe(sent.html);
  expect(stillPinned.logo.equals(sent.logo)).toBe(true);
  expect(stillPinned.html).toContain(PINNED_COMPANY_DETAILS);
  expect(stillPinned.html).not.toContain(CHANGED_COMPANY_DETAILS);
  expectNoLiveLogoReference(stillPinned, context.team.id);
  expect(pngWidth(stillPinned.logo)).toBe(PINNED_LOGO_WIDTH);
});
