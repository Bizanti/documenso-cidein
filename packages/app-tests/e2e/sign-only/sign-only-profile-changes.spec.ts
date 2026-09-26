/**
 * Scenarios F: profile changes.
 *
 * - F1 (covered): promotion. An administrator promotes a restricted account to
 *   the user profile from the admin page, and the API token the account already
 *   held is accepted on its very next request. No personal workspace is created
 *   by the promotion.
 * - F2 (covered): demotion. An administrator restricts a plain account which
 *   already holds a session and an API token: the session is invalidated (the
 *   account has to authenticate again) and the token is refused on its next
 *   write, because the roles are read fresh from the database on every request.
 * - F3 (covered): a promoted account without a personal workspace works in the
 *   team it was assigned. Signing in lands on that team's documents, the upload
 *   control is available and a write through its API token succeeds.
 */

import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { createApiToken } from '@documenso/lib/server-only/public-api/create-api-token';
import { prisma } from '@documenso/prisma';
import { seedUser } from '@documenso/prisma/seed/users';
import { expect, type Page, test } from '@playwright/test';
import { Role, TeamMemberRole } from '@prisma/client';

import { apiSignin, checkSessionValid } from '../fixtures/authentication';
import { expectToastTextToBeVisible } from '../fixtures/generic';
import {
  countOwnedOrganisations,
  createSignOnlyApiToken,
  expectForbiddenResponse,
  postTrpcMutation,
  RESTRICTED_ACCOUNT_MESSAGE,
  seedSignOnlyMemberContext,
} from '../fixtures/sign-only';

test.use({ storageState: { cookies: [], origins: [] } });

test.describe.configure({ mode: 'parallel' });

const API_BASE_URL = `${NEXT_PUBLIC_WEBAPP_URL()}/api/v2-beta`;

const createFolder = async ({ page, token, name }: { page: Page; token: string; name: string }) => {
  return await page.context().request.post(`${API_BASE_URL}/folder/create`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    data: { name },
  });
};

/**
 * Change the profile of a user from the admin page.
 */
const setProfileFromAdminPage = async ({
  adminPage,
  userId,
  currentProfile,
  nextProfile,
}: {
  adminPage: Page;
  userId: number;
  currentProfile: 'Sign only' | 'User';
  nextProfile: 'Sign only' | 'User';
}) => {
  await adminPage.goto(`/admin/users/${userId}`);

  await expect(adminPage.getByRole('heading', { name: /Manage .*'s profile/ })).toBeVisible();

  await adminPage.getByRole('combobox').filter({ hasText: currentProfile }).click();
  await adminPage.getByRole('option', { name: nextProfile, exact: true }).click();

  await adminPage.getByRole('button', { name: 'Update user' }).click();

  await expectToastTextToBeVisible(adminPage, 'Profile updated');
};

test('F1: promoting a restricted account is effective on the next request', async ({ browser }) => {
  const { team, signOnlyUser } = await seedSignOnlyMemberContext({ teamRole: TeamMemberRole.MANAGER });

  const token = await createSignOnlyApiToken({ userId: signOnlyUser.id, teamId: team.id });

  const admin = await seedUser({ isAdmin: true });

  const adminContext = await browser.newContext();
  const adminPage = await adminContext.newPage();

  await apiSignin({ page: adminPage, email: admin.user.email, redirectPath: '/' });

  try {
    // Baseline: as a restricted account the write is refused.
    await expectForbiddenResponse(
      await createFolder({ page: adminPage, token, name: '[TEST] F1 before promotion' }),
      RESTRICTED_ACCOUNT_MESSAGE,
    );

    await setProfileFromAdminPage({
      adminPage,
      userId: signOnlyUser.id,
      currentProfile: 'Sign only',
      nextProfile: 'User',
    });

    const promoted = await prisma.user.findFirstOrThrow({ where: { id: signOnlyUser.id } });

    expect(promoted.roles).toEqual([Role.USER]);

    // Promotion is not a way to obtain a personal workspace: only the profile
    // changed, the account keeps working in the team it was assigned.
    expect(await countOwnedOrganisations(signOnlyUser.id)).toBe(0);

    // The very next request made with the token issued before the promotion is
    // accepted: the profile is resolved per request, never from the token.
    const response = await createFolder({ page: adminPage, token, name: '[TEST] F1 after promotion' });

    expect(response.status(), await response.text()).toBe(200);

    const folder = await prisma.folder.findFirst({
      where: {
        name: '[TEST] F1 after promotion',
        teamId: team.id,
      },
    });

    expect(folder).not.toBeNull();
  } finally {
    await adminContext.close();
  }
});

test('F2: restricting an account blocks its previous session and API token', async ({ browser }) => {
  const { user: target, team: targetTeam } = await seedUser({ name: 'F2 Target' });

  const { token } = await createApiToken({
    userId: target.id,
    teamId: targetTeam.id,
    tokenName: 'e2e-f2',
    expiresIn: null,
  });

  const admin = await seedUser({ isAdmin: true });

  const targetContext = await browser.newContext();
  const targetPage = await targetContext.newPage();

  const adminContext = await browser.newContext();
  const adminPage = await adminContext.newPage();

  try {
    await apiSignin({ page: targetPage, email: target.email, redirectPath: '/' });

    expect(await checkSessionValid(targetPage)).toBe(true);

    // Baseline: the session and the token both work before the demotion.
    const beforeResponse = await createFolder({ page: targetPage, token, name: '[TEST] F2 before demotion' });

    expect(beforeResponse.status(), await beforeResponse.text()).toBe(200);

    await apiSignin({ page: adminPage, email: admin.user.email, redirectPath: '/' });

    await setProfileFromAdminPage({
      adminPage,
      userId: target.id,
      currentProfile: 'User',
      nextProfile: 'Sign only',
    });

    const restricted = await prisma.user.findFirstOrThrow({ where: { id: target.id } });

    expect(restricted.roles).toEqual([Role.SIGN_ONLY]);

    // The session which was open before the change is gone.
    expect(await checkSessionValid(targetPage)).toBe(false);

    await targetPage.goto('/');
    await expect(targetPage).toHaveURL(/\/signin/);

    // The token which was issued before the change is refused on its next write.
    await expectForbiddenResponse(
      await createFolder({ page: targetPage, token, name: '[TEST] F2 after demotion' }),
      RESTRICTED_ACCOUNT_MESSAGE,
    );

    const folder = await prisma.folder.findFirst({
      where: {
        name: '[TEST] F2 after demotion',
        teamId: targetTeam.id,
      },
    });

    expect(folder).toBeNull();
  } finally {
    await targetContext.close();
    await adminContext.close();
  }
});

test('F3: a promoted account without a personal workspace works in its assigned team', async ({ page, browser }) => {
  const { team, signOnlyUser } = await seedSignOnlyMemberContext({ teamRole: TeamMemberRole.MANAGER });

  const token = await createSignOnlyApiToken({ userId: signOnlyUser.id, teamId: team.id });

  const admin = await seedUser({ isAdmin: true });

  await apiSignin({ page, email: admin.user.email, redirectPath: '/' });

  const response = await postTrpcMutation({
    page,
    path: 'admin.user.update',
    input: { id: signOnlyUser.id, roles: [Role.USER] },
  });

  expect(response.status(), await response.text()).toBe(200);

  const promoted = await prisma.user.findFirstOrThrow({ where: { id: signOnlyUser.id } });

  expect(promoted.roles).toEqual([Role.USER]);
  expect(await countOwnedOrganisations(signOnlyUser.id)).toBe(0);

  // The account authenticates again (its sessions were invalidated by the
  // profile change) and lands on the team it was assigned.
  const promotedContext = await browser.newContext();
  const promotedPage = await promotedContext.newPage();

  try {
    await apiSignin({ page: promotedPage, email: signOnlyUser.email, redirectPath: '/' });

    await expect(promotedPage).toHaveURL(`/t/${team.url}/documents`);

    // The upload control is available again, and the account has no workspace of
    // its own to work in but the assigned team.
    await expect(promotedPage.getByTestId('document-upload-input')).not.toHaveCount(0);

    const folderResponse = await createFolder({
      page: promotedPage,
      token,
      name: '[TEST] F3 promoted folder',
    });

    expect(folderResponse.status(), await folderResponse.text()).toBe(200);

    const folder = await prisma.folder.findFirst({
      where: {
        name: '[TEST] F3 promoted folder',
        teamId: team.id,
      },
    });

    expect(folder).not.toBeNull();
  } finally {
    await promotedContext.close();
  }
});
