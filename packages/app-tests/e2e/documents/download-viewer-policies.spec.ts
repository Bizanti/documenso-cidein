import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { prisma } from '@documenso/prisma';
import { seedCompletedDocument, seedPendingDocument } from '@documenso/prisma/seed/documents';
import { seedTeam, seedTeamMember } from '@documenso/prisma/seed/teams';
import { seedUser } from '@documenso/prisma/seed/users';
import { expect, test } from '@playwright/test';
import { TeamMemberRole } from '@prisma/client';

import { apiSignin, apiSignout } from '../fixtures/authentication';

test.describe.configure({ mode: 'parallel' });

const WEBAPP_BASE_URL = NEXT_PUBLIC_WEBAPP_URL();
const HOUR_IN_MS = 60 * 60 * 1000;

type EnvelopeItemForViewer = {
  id: string;
  documentData: {
    id: string;
  };
};

/**
 * The recipient viewer route, which serves the stored `initial` (original) and
 * `current` (signed) versions of an envelope item.
 */
const tokenItemPdfUrl = (
  token: string,
  envelopeId: string,
  envelopeItem: EnvelopeItemForViewer,
  version: 'initial' | 'current',
) =>
  `${WEBAPP_BASE_URL}/api/files/token/${token}/envelope/${envelopeId}/envelopeItem/${envelopeItem.id}/dataId/${envelopeItem.documentData.id}/${version}/item.pdf`;

/**
 * The session authenticated counterpart of the recipient viewer route.
 */
const sessionItemPdfUrl = (envelopeId: string, envelopeItem: EnvelopeItemForViewer, version: 'initial' | 'current') =>
  `${WEBAPP_BASE_URL}/api/files/envelope/${envelopeId}/envelopeItem/${envelopeItem.id}/dataId/${envelopeItem.documentData.id}/${version}/item.pdf`;

const tokenViewUrl = (token: string, envelopeItem: EnvelopeItemForViewer) =>
  `${WEBAPP_BASE_URL}/api/files/token/${token}/envelopeItem/${envelopeItem.id}`;

const sessionViewUrl = (envelopeId: string, envelopeItem: EnvelopeItemForViewer) =>
  `${WEBAPP_BASE_URL}/api/files/envelope/${envelopeId}/envelopeItem/${envelopeItem.id}`;

const setDocumentMetaWindow = async (envelopeId: string, downloadWindowHours: number | null) => {
  const documentMeta = await prisma.documentMeta.findFirstOrThrow({
    where: {
      envelope: {
        id: envelopeId,
      },
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
};

/**
 * Seeds a completed document with a single signer, then applies the download
 * window (null means the global setting applies) and backdates the completion
 * date so the window can be tested as expired.
 */
const seedCompletedDocumentForViewer = async ({
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
      title: '[TEST] Viewer download policy document',
    },
  });

  await prisma.envelope.update({
    where: {
      id: document.id,
    },
    data: {
      completedAt: new Date(Date.now() - completedHoursAgo * HOUR_IN_MS),
    },
  });

  await setDocumentMetaWindow(document.id, downloadWindowHours);

  const recipient = await prisma.recipient.findFirstOrThrow({
    where: {
      envelopeId: document.id,
    },
  });

  const envelopeItem = await prisma.envelopeItem.findFirstOrThrow({
    where: {
      envelopeId: document.id,
    },
    include: {
      documentData: true,
    },
  });

  return { owner, team, document, recipient, envelopeItem };
};

const seedPendingDocumentForViewer = async (downloadWindowHours: number | null) => {
  const owner = await seedUser();
  const { user: signer } = await seedUser();

  const document = await seedPendingDocument(owner.user, owner.team.id, [signer], {
    createDocumentOptions: {
      title: '[TEST] Viewer download policy pending document',
    },
  });

  await setDocumentMetaWindow(document.id, downloadWindowHours);

  const recipient = await prisma.recipient.findFirstOrThrow({
    where: {
      envelopeId: document.id,
    },
  });

  const envelopeItem = await prisma.envelopeItem.findFirstOrThrow({
    where: {
      envelopeId: document.id,
    },
    include: {
      documentData: true,
    },
  });

  return { owner, document, recipient, envelopeItem };
};

test('[DOWNLOAD POLICY]: the recipient viewer denies the original of a completed document', async ({ request }) => {
  const { document, recipient, envelopeItem } = await seedCompletedDocumentForViewer({
    completedHoursAgo: 1,
    downloadWindowHours: 48,
  });

  const originalResponse = await request.get(tokenItemPdfUrl(recipient.token, document.id, envelopeItem, 'initial'));

  expect(originalResponse.status()).toBe(403);
  expect(await originalResponse.json()).toMatchObject({ code: 'ORIGINAL_DOWNLOAD_FORBIDDEN' });

  const signedResponse = await request.get(tokenItemPdfUrl(recipient.token, document.id, envelopeItem, 'current'));

  expect(signedResponse.status()).toBe(200);
  expect(signedResponse.headers()['content-type']).toContain('application/pdf');

  // The signed copy is bounded by the download window, so it must not be cached
  // for a year the way in-flight documents are.
  const cacheControl = signedResponse.headers()['cache-control'] ?? '';

  expect(cacheControl).toContain('no-store');
  expect(cacheControl).not.toContain('max-age=31536000');
});

test('[DOWNLOAD POLICY]: the recipient viewer blocks the signed copy once the window elapses', async ({ request }) => {
  const { document, recipient, envelopeItem } = await seedCompletedDocumentForViewer({
    completedHoursAgo: 49,
    downloadWindowHours: 48,
  });

  const signedResponse = await request.get(tokenItemPdfUrl(recipient.token, document.id, envelopeItem, 'current'));

  expect(signedResponse.status()).toBe(403);
  expect(await signedResponse.json()).toMatchObject({ code: 'DOWNLOAD_WINDOW_EXPIRED' });

  const originalResponse = await request.get(tokenItemPdfUrl(recipient.token, document.id, envelopeItem, 'initial'));

  expect(originalResponse.status()).toBe(403);
  expect(await originalResponse.json()).toMatchObject({ code: 'ORIGINAL_DOWNLOAD_FORBIDDEN' });

  // The sibling viewer route hands out the same bytes and is closed as well.
  const viewResponse = await request.get(tokenViewUrl(recipient.token, envelopeItem));

  expect(viewResponse.status()).toBe(403);
  expect(await viewResponse.json()).toMatchObject({ code: 'DOWNLOAD_WINDOW_EXPIRED' });
});

test('[DOWNLOAD POLICY]: the session viewer applies the download policy for members while ADMIN keeps access', async ({
  page,
}) => {
  const { owner, team, document, envelopeItem } = await seedCompletedDocumentForViewer({
    completedHoursAgo: 49,
    downloadWindowHours: 48,
  });

  const member = await seedTeamMember({
    teamId: team.id,
    name: 'Viewer policy member',
    role: TeamMemberRole.MEMBER,
  });

  await apiSignin({
    page,
    email: member.email,
    redirectPath: `/t/${team.url}/documents`,
  });

  const memberSignedResponse = await page
    .context()
    .request.get(sessionItemPdfUrl(document.id, envelopeItem, 'current'));

  expect(memberSignedResponse.status()).toBe(403);
  expect(await memberSignedResponse.json()).toMatchObject({ code: 'DOWNLOAD_WINDOW_EXPIRED' });

  const memberOriginalResponse = await page
    .context()
    .request.get(sessionItemPdfUrl(document.id, envelopeItem, 'initial'));

  expect(memberOriginalResponse.status()).toBe(403);
  expect(await memberOriginalResponse.json()).toMatchObject({ code: 'ORIGINAL_DOWNLOAD_FORBIDDEN' });

  const memberViewResponse = await page.context().request.get(sessionViewUrl(document.id, envelopeItem));

  expect(memberViewResponse.status()).toBe(403);
  expect(await memberViewResponse.json()).toMatchObject({ code: 'DOWNLOAD_WINDOW_EXPIRED' });

  await apiSignout({ page });

  // The document owner (team ADMIN) keeps both versions.
  await apiSignin({
    page,
    email: owner.email,
    redirectPath: `/t/${team.url}/documents`,
  });

  expect((await page.context().request.get(sessionItemPdfUrl(document.id, envelopeItem, 'current'))).status()).toBe(
    200,
  );
  expect((await page.context().request.get(sessionItemPdfUrl(document.id, envelopeItem, 'initial'))).status()).toBe(
    200,
  );

  await apiSignout({ page });
});

test('[DOWNLOAD POLICY]: the session viewer only offers the original to ADMIN before the window elapses', async ({
  page,
}) => {
  const { owner, team, document, envelopeItem } = await seedCompletedDocumentForViewer({
    completedHoursAgo: 1,
    downloadWindowHours: 48,
  });

  const member = await seedTeamMember({
    teamId: team.id,
    name: 'Viewer policy signed only member',
    role: TeamMemberRole.MEMBER,
  });

  await apiSignin({
    page,
    email: member.email,
    redirectPath: `/t/${team.url}/documents`,
  });

  const memberSignedResponse = await page
    .context()
    .request.get(sessionItemPdfUrl(document.id, envelopeItem, 'current'));

  expect(memberSignedResponse.status()).toBe(200);
  expect(memberSignedResponse.headers()['cache-control']).toContain('no-store');

  const memberOriginalResponse = await page
    .context()
    .request.get(sessionItemPdfUrl(document.id, envelopeItem, 'initial'));

  expect(memberOriginalResponse.status()).toBe(403);
  expect(await memberOriginalResponse.json()).toMatchObject({ code: 'ORIGINAL_DOWNLOAD_FORBIDDEN' });

  await apiSignout({ page });

  await apiSignin({
    page,
    email: owner.email,
    redirectPath: `/t/${team.url}/documents`,
  });

  expect((await page.context().request.get(sessionItemPdfUrl(document.id, envelopeItem, 'initial'))).status()).toBe(
    200,
  );

  await apiSignout({ page });
});

test('[DOWNLOAD POLICY]: the viewer keeps serving in-flight documents to recipients and members', async ({ page }) => {
  const { owner, document, recipient, envelopeItem } = await seedPendingDocumentForViewer(48);

  // The signing page renders the current version while the envelope is pending.
  const recipientSignedResponse = await page
    .context()
    .request.get(tokenItemPdfUrl(recipient.token, document.id, envelopeItem, 'current'));

  expect(recipientSignedResponse.status()).toBe(200);
  expect(recipientSignedResponse.headers()['cache-control']).toContain('max-age=31536000');

  expect(
    (await page.context().request.get(tokenItemPdfUrl(recipient.token, document.id, envelopeItem, 'initial'))).status(),
  ).toBe(200);

  await apiSignin({
    page,
    email: owner.user.email,
    redirectPath: `/t/${owner.team.url}/documents`,
  });

  expect((await page.context().request.get(sessionItemPdfUrl(document.id, envelopeItem, 'current'))).status()).toBe(
    200,
  );
  expect((await page.context().request.get(sessionItemPdfUrl(document.id, envelopeItem, 'initial'))).status()).toBe(
    200,
  );

  await apiSignout({ page });
});
