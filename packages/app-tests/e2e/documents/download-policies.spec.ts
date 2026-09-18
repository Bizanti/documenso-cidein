import { getEnvelopeItemPdfUrl } from '@documenso/lib/utils/envelope-download';
import { prisma } from '@documenso/prisma';
import { seedCompletedDocument } from '@documenso/prisma/seed/documents';
import { seedTeam, seedTeamMember } from '@documenso/prisma/seed/teams';
import { seedUser } from '@documenso/prisma/seed/users';
import { expect, type Page, test } from '@playwright/test';
import { TeamMemberRole } from '@prisma/client';

import { apiSignin, apiSignout } from '../fixtures/authentication';
import { openDropdownMenu } from '../fixtures/generic';

test.describe.configure({ mode: 'parallel' });

const HOUR_IN_MS = 60 * 60 * 1000;

/**
 * Seeds a completed document with a single signer, then applies the download
 * window (null means the global setting applies) and backdates the completion
 * date so the window can be tested as expired.
 */
const seedCompletedDocumentForDownloads = async ({
  completedHoursAgo,
  downloadWindowHours,
}: {
  completedHoursAgo: number;
  downloadWindowHours: number | null;
}) => {
  const { owner, team } = await seedTeam();

  const { user: signer } = await seedUser();

  const document = await seedCompletedDocument(owner, team.id, [signer], {
    createDocumentOptions: {
      title: '[TEST] Download policy document',
    },
  });

  const completedAt = new Date(Date.now() - completedHoursAgo * HOUR_IN_MS);

  const documentMeta = await prisma.documentMeta.findFirstOrThrow({
    where: {
      envelope: {
        id: document.id,
      },
    },
  });

  await prisma.envelope.update({
    where: {
      id: document.id,
    },
    data: {
      completedAt,
    },
  });

  await prisma.documentMeta.update({
    where: {
      id: documentMeta.id,
    },
    data: {
      downloadWindowHours,
    },
  });

  const recipient = await prisma.recipient.findFirstOrThrow({
    where: {
      envelopeId: document.id,
    },
  });

  const envelopeItem = await prisma.envelopeItem.findFirstOrThrow({
    where: {
      envelopeId: document.id,
    },
  });

  return { owner, team, document, recipient, envelopeItem, signer };
};

type ItemDownloadOptions = {
  page: Page;
  envelopeItem: { id: string; envelopeId: string };
  version: 'original' | 'signed';
  token?: string;
};

/**
 * Requests an envelope item download. Without a token the request uses the
 * session cookie of the signed in user, mirroring the team side downloads.
 */
const requestItemDownload = async ({ page, envelopeItem, version, token }: ItemDownloadOptions) => {
  const url = getEnvelopeItemPdfUrl({
    type: 'download',
    envelopeItem,
    token,
    version,
  });

  return await page.context().request.get(url);
};

test('[DOWNLOAD POLICY]: recipients can only download the signed copy of a completed document', async ({ page }) => {
  const { envelopeItem, recipient } = await seedCompletedDocumentForDownloads({
    completedHoursAgo: 1,
    downloadWindowHours: null,
  });

  const originalResponse = await requestItemDownload({
    page,
    envelopeItem,
    version: 'original',
    token: recipient.token,
  });

  expect(originalResponse.status()).toBe(403);
  expect(await originalResponse.json()).toMatchObject({ code: 'ORIGINAL_DOWNLOAD_FORBIDDEN' });

  const signedResponse = await requestItemDownload({
    page,
    envelopeItem,
    version: 'signed',
    token: recipient.token,
  });

  expect(signedResponse.status()).toBe(200);
});

test('[DOWNLOAD POLICY]: the download window blocks recipients and members once it elapses, while ADMIN and SGC keep access', async ({
  page,
}) => {
  const { owner, team, envelopeItem, recipient } = await seedCompletedDocumentForDownloads({
    completedHoursAgo: 49,
    downloadWindowHours: 48,
  });

  const member = await seedTeamMember({
    teamId: team.id,
    name: 'Download policy member',
    role: TeamMemberRole.MEMBER,
  });

  // Recipients are blocked once the window has elapsed.
  const recipientResponse = await requestItemDownload({
    page,
    envelopeItem,
    version: 'signed',
    token: recipient.token,
  });

  expect(recipientResponse.status()).toBe(403);
  expect(await recipientResponse.json()).toMatchObject({ code: 'DOWNLOAD_WINDOW_EXPIRED' });

  // So are plain team members.
  await apiSignin({
    page,
    email: member.email,
    redirectPath: `/t/${team.url}/documents`,
  });

  const memberResponse = await requestItemDownload({ page, envelopeItem, version: 'signed' });

  expect(memberResponse.status()).toBe(403);
  expect(await memberResponse.json()).toMatchObject({ code: 'DOWNLOAD_WINDOW_EXPIRED' });

  await apiSignout({ page });

  // The document owner (team ADMIN) keeps both versions.
  await apiSignin({
    page,
    email: owner.email,
    redirectPath: `/t/${team.url}/documents`,
  });

  expect((await requestItemDownload({ page, envelopeItem, version: 'signed' })).status()).toBe(200);
  expect((await requestItemDownload({ page, envelopeItem, version: 'original' })).status()).toBe(200);

  await apiSignout({ page });

  // Members holding the SGC role keep both versions as well.
  const sgcMember = await seedTeamMember({
    teamId: team.id,
    name: 'Download policy SGC member',
    role: TeamMemberRole.SGC,
  });

  await apiSignin({
    page,
    email: sgcMember.email,
    redirectPath: `/t/${team.url}/documents`,
  });

  expect((await requestItemDownload({ page, envelopeItem, version: 'signed' })).status()).toBe(200);
  expect((await requestItemDownload({ page, envelopeItem, version: 'original' })).status()).toBe(200);
});

test('[DOWNLOAD POLICY]: the documents table shows a locked download state for members past the window', async ({
  page,
}) => {
  const { owner, team, document } = await seedCompletedDocumentForDownloads({
    completedHoursAgo: 49,
    downloadWindowHours: 48,
  });

  const member = await seedTeamMember({
    teamId: team.id,
    name: 'Locked download member',
    role: TeamMemberRole.MEMBER,
  });

  await apiSignin({
    page,
    email: member.email,
    redirectPath: `/t/${team.url}/documents`,
  });

  const row = page.locator('tr', { hasText: document.title });

  const lockedButton = row.getByRole('button', { name: 'Download locked' });
  await expect(lockedButton).toBeVisible();
  await expect(lockedButton).toBeDisabled();

  // The dropdown action is locked as well and explains why.
  await openDropdownMenu(page, row.getByTestId('document-table-action-btn'));

  await expect(page.getByRole('menuitem', { name: /Download/ })).toBeDisabled();
  await expect(page.getByText('The download window has expired')).toBeVisible();

  await page.keyboard.press('Escape');
  await apiSignout({ page });

  // The owner keeps the download action and is offered both versions.
  await apiSignin({
    page,
    email: owner.email,
    redirectPath: `/t/${team.url}/documents`,
  });

  const ownerRow = page.locator('tr', { hasText: document.title });

  await expect(ownerRow.getByRole('button', { name: 'Download locked' })).toHaveCount(0);

  await ownerRow.getByRole('button', { name: 'Download', exact: true }).click();

  await expect(page.getByRole('heading', { name: 'Download Files' })).toBeVisible();
  await expect(page.getByText(/The download window for this document has expired/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Original' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Signed' })).toBeVisible();
});

test('[DOWNLOAD POLICY]: members without SGC privileges are only offered the signed copy', async ({ page }) => {
  const { team, document } = await seedCompletedDocumentForDownloads({
    completedHoursAgo: 1,
    downloadWindowHours: null,
  });

  const member = await seedTeamMember({
    teamId: team.id,
    name: 'Signed only member',
    role: TeamMemberRole.MEMBER,
  });

  await apiSignin({
    page,
    email: member.email,
    redirectPath: `/t/${team.url}/documents`,
  });

  const row = page.locator('tr', { hasText: document.title });

  await row.getByRole('button', { name: 'Download', exact: true }).click();

  await expect(page.getByRole('heading', { name: 'Download Files' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Signed' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Original' })).toHaveCount(0);
});

test('[DOWNLOAD POLICY]: the signing complete page does not offer sharing to recipients', async ({ page }) => {
  const { recipient } = await seedCompletedDocumentForDownloads({
    completedHoursAgo: 1,
    downloadWindowHours: null,
  });

  await page.goto(`/sign/${recipient.token}/complete`);

  await expect(page.getByRole('heading', { name: 'Document Signed' })).toBeVisible();

  // Sharing was removed for recipients.
  await expect(page.getByRole('button', { name: 'Share' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Share Signing Card' })).toHaveCount(0);

  // Only the signed copy is downloadable.
  await page.getByRole('button', { name: 'Download', exact: true }).click();

  await expect(page.getByRole('heading', { name: 'Download Files' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Signed' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Original' })).toHaveCount(0);
});

test('[DOWNLOAD POLICY]: the signing complete page locks downloads once the window elapses', async ({ page }) => {
  const { recipient } = await seedCompletedDocumentForDownloads({
    completedHoursAgo: 49,
    downloadWindowHours: 48,
  });

  await page.goto(`/sign/${recipient.token}/complete`);

  await expect(page.getByRole('button', { name: 'Download locked' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download', exact: true })).toHaveCount(0);
  await expect(
    page.getByText(/The download window for this document has expired. Contact the sender to request a copy./),
  ).toBeVisible();
});

test('[DOWNLOAD POLICY]: the documents table resolves the page download policies in a single request', async ({
  page,
}) => {
  const { owner, team } = await seedTeam();

  const { user: signer } = await seedUser();

  const documents = await Promise.all(
    [1, 2].map(async (index) =>
      seedCompletedDocument(owner, team.id, [signer], {
        createDocumentOptions: {
          title: `[TEST] Batched download policy ${index}`,
        },
      }),
    ),
  );

  const policyRequestPayloads: string[] = [];

  page.on('request', (request) => {
    if (request.url().includes('document.getEnvelopeDownloadPolicies')) {
      policyRequestPayloads.push(`${request.url()} ${request.postData() ?? ''}`);
    }
  });

  const policyResponsePromise = page.waitForResponse((response) =>
    response.url().includes('document.getEnvelopeDownloadPolicies'),
  );

  await apiSignin({
    page,
    email: owner.email,
    redirectPath: `/t/${team.url}/documents`,
  });

  await expect(page.getByRole('link', { name: documents[0].title })).toBeVisible();

  // Waiting for the response means every query the page triggered has already
  // been sent, so a per row request cannot hide behind the batch.
  await policyResponsePromise;

  // A request that mentions some, but not all, of the page envelopes is the per
  // row query this test exists to prevent.
  const perRowPolicyRequests = policyRequestPayloads.filter(
    (payload) =>
      documents.some((document) => payload.includes(document.id)) &&
      !documents.every((document) => payload.includes(document.id)),
  );

  expect(perRowPolicyRequests).toEqual([]);

  const batchPolicyRequests = policyRequestPayloads.filter((payload) =>
    documents.every((document) => payload.includes(document.id)),
  );

  expect(batchPolicyRequests.length).toBeGreaterThan(0);
});
