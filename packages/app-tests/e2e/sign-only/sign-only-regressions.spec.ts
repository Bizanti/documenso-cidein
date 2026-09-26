/**
 * Scenarios G: the restricted profile changes nothing for the accounts which do
 * not carry it.
 *
 * - G1 (covered): an administrator keeps its functions. It lands on its team,
 *   uploads a document through the UI, creates a team and reaches the admin
 *   panel.
 * - G2 (covered): an addressee without an account keeps its recipient role
 *   policy, in `sign-only-downloads.spec.ts`.
 * - G3 (covered): an existing account keeps full access to its team and its API.
 *   The variant without a personal workspace is F3.
 */

import path from 'node:path';
import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { createApiToken } from '@documenso/lib/server-only/public-api/create-api-token';
import { prisma } from '@documenso/prisma';
import { seedUser } from '@documenso/prisma/seed/users';
import { expect, test } from '@playwright/test';
import { EnvelopeType } from '@prisma/client';

import { apiSignin, checkSessionValid } from '../fixtures/authentication';
import { postTrpcMutation } from '../fixtures/sign-only';

test.use({ storageState: { cookies: [], origins: [] } });

test.describe.configure({ mode: 'parallel' });

const examplePdfPath = path.join(__dirname, '../../../../assets/example.pdf');

const API_BASE_URL = `${NEXT_PUBLIC_WEBAPP_URL()}/api/v2-beta`;

test('G1: an administrator keeps creating teams, uploading documents and reaching the admin panel', async ({
  page,
}) => {
  const { user: admin, organisation, team } = await seedUser({ name: 'G1 Admin', isAdmin: true });

  await apiSignin({ page, email: admin.email, redirectPath: '/' });

  // Lands on its team's documents, with the upload control available.
  await expect(page).toHaveURL(new RegExp(`/t/${team.url}/documents$`));
  await expect(page.getByTestId('document-upload-input')).not.toHaveCount(0);

  // Uploads a document through the UI.
  await page.getByTestId('document-upload-input').first().setInputFiles(examplePdfPath);

  await expect
    .poll(async () => {
      return await prisma.envelope.count({
        where: {
          teamId: team.id,
          type: EnvelopeType.DOCUMENT,
        },
      });
    })
    .toBe(1);

  await page.waitForURL(/\/documents\/[^/]+\/edit/);

  // Creates a team.
  const createTeamResponse = await postTrpcMutation({
    page,
    path: 'team.create',
    input: {
      teamName: 'G1 Team',
      teamUrl: 'g1-team',
      organisationId: organisation.id,
      // Required by `ZCreateTeamRequestSchema`: the schema has no default, so a
      // call without it is rejected by the input parser and the team is never
      // created.
      inheritMembers: true,
    },
  });

  expect(createTeamResponse.status(), await createTeamResponse.text()).toBe(200);

  const createdTeam = await prisma.team.findFirst({
    where: {
      url: 'g1-team',
      organisationId: organisation.id,
    },
  });

  expect(createdTeam).not.toBeNull();

  // Reaches the admin panel.
  await page.goto('/admin/users');

  await expect(page.getByRole('heading', { name: 'Manage users' })).toBeVisible();
});

test('G3: an existing account keeps full access to its team and its API', async ({ page }) => {
  const { user, team } = await seedUser({ name: 'G3 User' });

  const { token } = await createApiToken({
    userId: user.id,
    teamId: team.id,
    tokenName: 'e2e-g3',
    expiresIn: null,
  });

  await apiSignin({ page, email: user.email, redirectPath: '/' });

  expect(await checkSessionValid(page)).toBe(true);

  await expect(page).toHaveURL(new RegExp(`/t/${team.url}/documents$`));
  await expect(page.getByTestId('document-upload-input')).not.toHaveCount(0);

  const createFolderResponse = await page.context().request.post(`${API_BASE_URL}/folder/create`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    data: { name: '[TEST] G3 folder' },
  });

  expect(createFolderResponse.status(), await createFolderResponse.text()).toBe(200);

  const folder = await prisma.folder.findFirst({
    where: {
      name: '[TEST] G3 folder',
      teamId: team.id,
    },
  });

  expect(folder).not.toBeNull();
});
