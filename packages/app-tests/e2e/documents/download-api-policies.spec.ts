import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { createApiToken } from '@documenso/lib/server-only/public-api/create-api-token';
import { mapSecondaryIdToDocumentId } from '@documenso/lib/utils/envelope';
import { prisma } from '@documenso/prisma';
import { seedCompletedDocument } from '@documenso/prisma/seed/documents';
import { seedTeam, seedTeamMember } from '@documenso/prisma/seed/teams';
import { seedUser } from '@documenso/prisma/seed/users';
import { expect, test } from '@playwright/test';
import { TeamMemberRole } from '@prisma/client';

test.describe.configure({ mode: 'parallel' });

const WEBAPP_BASE_URL = NEXT_PUBLIC_WEBAPP_URL();
const HOUR_IN_MS = 60 * 60 * 1000;

/**
 * Seeds a completed document with a single signer, then applies the download
 * window (null means the global setting applies) and backdates the completion
 * date so the window can be tested as expired.
 */
const seedCompletedDocumentForApiDownloads = async ({
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
      title: '[TEST] API download policy document',
    },
  });

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
      completedAt: new Date(Date.now() - completedHoursAgo * HOUR_IN_MS),
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

  const envelopeItem = await prisma.envelopeItem.findFirstOrThrow({
    where: {
      envelopeId: document.id,
    },
  });

  return {
    owner,
    team,
    document,
    envelopeItem,
    documentId: mapSecondaryIdToDocumentId(document.secondaryId),
  };
};

const createTokenFor = async ({ userId, teamId, tokenName }: { userId: number; teamId: number; tokenName: string }) => {
  const { token } = await createApiToken({
    userId,
    teamId,
    tokenName,
    expiresIn: null,
  });

  return token;
};

const authorizationHeaders = (token: string) => ({ authorization: `Bearer ${token}` });

test('[DOWNLOAD POLICY API]: an API token cannot download the original of a completed document', async ({
  request,
}) => {
  const { owner, team, envelopeItem, documentId } = await seedCompletedDocumentForApiDownloads({
    completedHoursAgo: 1,
    downloadWindowHours: null,
  });

  // A MANAGER can mint API tokens, but must not be able to fetch the original.
  const manager = await seedTeamMember({
    teamId: team.id,
    name: 'API download manager',
    role: TeamMemberRole.MANAGER,
  });

  const managerToken = await createTokenFor({
    userId: manager.id,
    teamId: team.id,
    tokenName: 'e2e-download-manager',
  });

  const documentResponse = await request.get(`${WEBAPP_BASE_URL}/api/v2/document/${documentId}/download/original`, {
    headers: authorizationHeaders(managerToken),
  });

  expect(documentResponse.status()).toBe(403);
  expect(await documentResponse.json()).toMatchObject({ code: 'ORIGINAL_DOWNLOAD_FORBIDDEN' });

  const itemResponse = await request.get(
    `${WEBAPP_BASE_URL}/api/v2/envelope/item/${envelopeItem.id}/download?version=original`,
    {
      headers: authorizationHeaders(managerToken),
    },
  );

  expect(itemResponse.status()).toBe(403);
  expect(await itemResponse.json()).toMatchObject({ code: 'ORIGINAL_DOWNLOAD_FORBIDDEN' });

  // The signed copy is still served to the manager.
  const signedResponse = await request.get(
    `${WEBAPP_BASE_URL}/api/v2/envelope/item/${envelopeItem.id}/download?version=signed`,
    {
      headers: authorizationHeaders(managerToken),
    },
  );

  expect(signedResponse.status()).toBe(200);

  // The owner (team ADMIN) keeps the original.
  const ownerToken = await createTokenFor({
    userId: owner.id,
    teamId: team.id,
    tokenName: 'e2e-download-owner',
  });

  const ownerResponse = await request.get(
    `${WEBAPP_BASE_URL}/api/v2/envelope/item/${envelopeItem.id}/download?version=original`,
    {
      headers: authorizationHeaders(ownerToken),
    },
  );

  expect(ownerResponse.status()).toBe(200);
});

test('[DOWNLOAD POLICY API]: the download window applies to API token downloads', async ({ request }) => {
  const { owner, team, envelopeItem, documentId } = await seedCompletedDocumentForApiDownloads({
    completedHoursAgo: 49,
    downloadWindowHours: 48,
  });

  const manager = await seedTeamMember({
    teamId: team.id,
    name: 'API window manager',
    role: TeamMemberRole.MANAGER,
  });

  const managerToken = await createTokenFor({
    userId: manager.id,
    teamId: team.id,
    tokenName: 'e2e-window-manager',
  });

  const documentResponse = await request.get(`${WEBAPP_BASE_URL}/api/v2/document/${documentId}/download/signed`, {
    headers: authorizationHeaders(managerToken),
  });

  expect(documentResponse.status()).toBe(403);
  expect(await documentResponse.json()).toMatchObject({ code: 'DOWNLOAD_WINDOW_EXPIRED' });

  const itemResponse = await request.get(
    `${WEBAPP_BASE_URL}/api/v2/envelope/item/${envelopeItem.id}/download?version=signed`,
    {
      headers: authorizationHeaders(managerToken),
    },
  );

  expect(itemResponse.status()).toBe(403);
  expect(await itemResponse.json()).toMatchObject({ code: 'DOWNLOAD_WINDOW_EXPIRED' });

  // The owner (team ADMIN) keeps access past the window.
  const ownerToken = await createTokenFor({
    userId: owner.id,
    teamId: team.id,
    tokenName: 'e2e-window-owner',
  });

  const ownerResponse = await request.get(
    `${WEBAPP_BASE_URL}/api/v2/envelope/item/${envelopeItem.id}/download?version=signed`,
    {
      headers: authorizationHeaders(ownerToken),
    },
  );

  expect(ownerResponse.status()).toBe(200);
});

test('[DOWNLOAD POLICY API]: the v1 download endpoint denies the original for non privileged tokens', async ({
  request,
}) => {
  const { team, documentId } = await seedCompletedDocumentForApiDownloads({
    completedHoursAgo: 1,
    downloadWindowHours: null,
  });

  const manager = await seedTeamMember({
    teamId: team.id,
    name: 'API v1 manager',
    role: TeamMemberRole.MANAGER,
  });

  const managerToken = await createTokenFor({
    userId: manager.id,
    teamId: team.id,
    tokenName: 'e2e-v1-manager',
  });

  const response = await request.get(
    `${WEBAPP_BASE_URL}/api/v1/documents/${documentId}/download?downloadOriginalDocument=true`,
    {
      headers: authorizationHeaders(managerToken),
    },
  );

  expect(response.status()).toBe(403);
  expect(await response.json()).toMatchObject({ code: 'ORIGINAL_DOWNLOAD_FORBIDDEN' });
});
