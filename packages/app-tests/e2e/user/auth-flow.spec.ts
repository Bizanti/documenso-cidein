import { prisma } from '@documenso/prisma';
import { extractUserVerificationToken, seedTestEmail, seedUser } from '@documenso/prisma/seed/users';
import { expect, type Page, test } from '@playwright/test';
import { Role } from '@prisma/client';

import { signSignaturePad } from '../fixtures/signature';

test.use({ storageState: { cookies: [], origins: [] } });

test('[SIGN_ONLY] can sign up with email and password and lands on the signing inbox', async ({
  page,
}: {
  page: Page;
}) => {
  const username = 'Test User';
  const email = seedTestEmail();
  const password = 'Password123#';

  await page.goto('/signup');
  await page.getByLabel('Name').fill(username);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);

  await signSignaturePad(page);

  await page.getByRole('button', { name: 'Create account', exact: true }).click();

  await page.waitForURL('/unverified-account');

  // Wait to ensure token is created in the database
  await page.waitForTimeout(2000);

  const { token } = await extractUserVerificationToken(email);

  const user = await prisma.user.findFirstOrThrow({
    where: {
      email,
    },
  });

  // Every account starts with the restricted profile and without a personal
  // workspace, so there is no organisation to own and no team to land on.
  expect(user.roles).toEqual([Role.SIGN_ONLY]);

  const organisation = await prisma.organisation.findFirst({
    where: {
      ownerUserId: user.id,
    },
  });

  expect(organisation).toBeNull();

  await page.goto(`/verify-email/${token}`);

  await expect(page.getByRole('heading')).toContainText('Email Confirmed!');

  // We now automatically redirect to the home page
  await page.getByRole('link', { name: 'Continue' }).click();

  // The signing inbox is the whole application for a restricted account.
  await page.waitForURL('/mis-firmas');
  await expect(page).toHaveURL('/mis-firmas');
  await expect(page.getByTestId('mis-firmas-page')).toBeVisible();
});

test('[USER] can sign in using email and password', async ({ page }: { page: Page }) => {
  const { user, team } = await seedUser();

  await page.goto('/signin');
  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Password', { exact: true }).fill('password');
  await page.getByRole('button', { name: 'Sign In' }).click();

  await page.waitForURL(`/t/${team.url}/documents`);
  await expect(page).toHaveURL(`/t/${team.url}/documents`);
});
