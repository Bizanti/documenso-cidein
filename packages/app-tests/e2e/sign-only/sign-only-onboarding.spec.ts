/**
 * Scenarios A: how a sign only account is created and how it lands.
 *
 * - A1 (covered): email signup gets `roles: [SIGN_ONLY]`, no personal
 *   organisation/team, and lands on `/mis-firmas` with the reduced menu.
 * - A2 (deferred, see `test.skip`): SSO signup. There is no SSO harness in this
 *   suite, see `sign-only/README.md`.
 * - A3 (covered): invitation. The invited account is created through the signup
 *   wizard, accepts the invitation and stays restricted; joining an
 *   organisation never widens the profile.
 * - A5 (covered): an account without any organisation signs in, lands on its
 *   inbox and cannot reach the team or organisation area.
 */

import { prisma } from '@documenso/prisma';
import { extractUserVerificationToken, seedTestEmail, seedUser } from '@documenso/prisma/seed/users';
import { expect, type Page, test } from '@playwright/test';
import { Role } from '@prisma/client';

import { apiSignin } from '../fixtures/authentication';
import {
  countOrganisationMemberships,
  countOwnedOrganisations,
  expectPathsRedirectToInbox,
  expectSignOnlyInboxShell,
  SIGN_ONLY_HOME,
  seedSignOnlyInvitation,
  seedSignOnlyUser,
} from '../fixtures/sign-only';
import { signSignaturePad } from '../fixtures/signature';

test.use({ storageState: { cookies: [], origins: [] } });

test.describe.configure({ mode: 'parallel' });

const PASSWORD = 'Password123#';

/**
 * Sign up through the UI and confirm the email, leaving the session signed in
 * the same way the onboarding flows do.
 */
const signUpWithEmail = async ({ page, name, email }: { page: Page; name: string; email: string }) => {
  await page.goto('/signup');
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);

  await signSignaturePad(page);

  await page.getByRole('button', { name: 'Create account', exact: true }).click();

  await page.waitForURL('/unverified-account');

  // Wait to ensure token is created in the database
  await page.waitForTimeout(2000);

  const { token } = await extractUserVerificationToken(email);

  await page.goto(`/verify-email/${token}`);

  await expect(page.getByRole('heading')).toContainText('Email Confirmed!');

  await page.getByRole('link', { name: 'Continue' }).click();
};

test('A1: an email signup is restricted, has no personal workspace and lands on /mis-firmas', async ({ page }) => {
  const email = seedTestEmail();

  await signUpWithEmail({ page, name: 'A1 Sign Only', email });

  const user = await prisma.user.findFirstOrThrow({
    where: {
      email,
    },
  });

  expect(user.roles).toEqual([Role.SIGN_ONLY]);
  expect(await countOwnedOrganisations(user.id)).toBe(0);
  expect(await countOrganisationMemberships(user.id)).toBe(0);

  await page.waitForURL(SIGN_ONLY_HOME);
  await expect(page).toHaveURL(SIGN_ONLY_HOME);

  await expectSignOnlyInboxShell(page);

  // The inbox starts empty: there is no document to share with a brand new account.
  await expect(page.getByTestId('mis-firmas-pending')).toContainText(
    'You have no documents waiting for your signature.',
  );
});

test.skip('A2: an SSO signup is restricted and lands on /mis-firmas', async () => {
  // Deferred: the organisation SSO portal needs an external identity provider
  // and no E2E harness fakes the OIDC round trip. The rule itself (every account
  // creation hands out the restricted profile) is covered by A1/A3 here and by
  // the unit tests of `create-user`/`handle-oauth-organisation-callback-url`.
  // See `packages/app-tests/e2e/sign-only/README.md`.
});

test('A3: an invited account signs up, accepts the invitation and stays restricted', async ({ page }) => {
  const { organisation, team } = await seedUser();

  const email = seedTestEmail();

  const invite = await seedSignOnlyInvitation({
    organisationId: organisation.id,
    email,
  });

  await signUpWithEmail({ page, name: 'A3 Invited', email });

  const user = await prisma.user.findFirstOrThrow({
    where: {
      email,
    },
  });

  expect(user.roles).toEqual([Role.SIGN_ONLY]);

  await page.goto(`/organisation/invite/${invite.token}`);

  // Match the heading by role and accept either spelling: the view is written
  // with the British "Organisation" while the English catalog renders the US
  // "Organization", so a literal assertion on the source string never matched
  // the screen.
  await expect(page.getByRole('heading', { name: /Organi[sz]ation invitation/ })).toBeVisible();

  // And this is the accepting branch: the invited account already exists, so the
  // page offers Accept instead of the "create an account" step.
  await expect(page.getByRole('button', { name: 'Accept' })).toBeVisible();

  await page.getByRole('button', { name: 'Accept' }).click();

  await expect(page.getByRole('heading', { name: 'Invitation accepted!' })).toBeVisible();

  await page.getByRole('link', { name: 'Continue' }).click();

  await page.waitForURL(SIGN_ONLY_HOME);

  // Joining an organisation grants membership and nothing else: no personal
  // workspace is created and the restricted profile is not widened.
  const member = await prisma.organisationMember.findFirst({
    where: {
      userId: user.id,
      organisationId: organisation.id,
    },
  });

  expect(member).not.toBeNull();

  const refreshedUser = await prisma.user.findFirstOrThrow({
    where: {
      id: user.id,
    },
  });

  expect(refreshedUser.roles).toEqual([Role.SIGN_ONLY]);
  expect(await countOwnedOrganisations(user.id)).toBe(0);

  // The account is a member of the team the invitation belongs to, and still
  // cannot reach the team area.
  const organisationMemberId = member?.id;

  const teamMembership = await prisma.teamGroup.findFirst({
    where: {
      teamId: team.id,
      organisationGroup: {
        organisationGroupMembers: {
          some: {
            organisationMemberId,
          },
        },
      },
    },
  });

  expect(teamMembership).not.toBeNull();

  await expectSignOnlyInboxShell(page);
  await expectPathsRedirectToInbox(page, [`/t/${team.url}/documents`, `/t/${team.url}/templates`]);
});

test('A5: a sign only account without any organisation signs in and reaches its inbox', async ({ page }) => {
  const user = await seedSignOnlyUser({ name: 'A5 Sign Only' });

  await apiSignin({ page, email: user.email, redirectPath: '/' });

  await expect(page).toHaveURL(new RegExp(`${SIGN_ONLY_HOME}$`));

  await expectSignOnlyInboxShell(page);

  // Reloading keeps the account on its inbox instead of bouncing or erroring.
  await page.reload();
  await expect(page).toHaveURL(new RegExp(`${SIGN_ONLY_HOME}$`));
  await expect(page.getByTestId('mis-firmas-page')).toBeVisible();

  // The account settings it keeps are reachable...
  await page.goto('/settings/profile');
  await expect(page).toHaveURL(/\/settings\/profile$/);

  await page.goto('/settings/security');
  await expect(page).toHaveURL(/\/settings\/security$/);

  // ...and neither a typed team URL nor the rest of the settings and the
  // administrative areas are.
  await expectPathsRedirectToInbox(page, [
    '/t/any-team/documents',
    '/t/any-team/templates',
    '/settings/billing',
    '/settings/organisations',
    '/admin/users',
  ]);
});
