/**
 * Fixtures for the sign only (SIGN_ONLY) profile.
 *
 * `seedUser` from `@documenso/prisma/seed/users` always creates a `[USER]`
 * account together with a personal organisation, so it cannot be used to
 * reproduce a sign only account. The helpers below create the account the way
 * the real onboarding flows do after M27: `roles: [SIGN_ONLY]` and no personal
 * organisation or team of its own.
 *
 * A sign only account obtains its team only when it is invited, which is why
 * every helper either joins an existing organisation or leaves the account
 * without one.
 */

import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { hashSync } from '@documenso/lib/server-only/auth/hash';
import { addUserToOrganisation } from '@documenso/lib/server-only/organisation/accept-organisation-invitation';
import { createApiToken } from '@documenso/lib/server-only/public-api/create-api-token';
import { generateDatabaseId } from '@documenso/lib/universal/id';
import { prisma } from '@documenso/prisma';
import { seedTestEmail, seedUser } from '@documenso/prisma/seed/users';
import { createTeamMembers } from '@documenso/trpc/server/team-router/create-team-members';
import { type APIResponse, expect, type Page } from '@playwright/test';
import { OrganisationGroupType, OrganisationMemberRole, Role, TeamMemberRole } from '@prisma/client';
import { nanoid } from 'nanoid';

/**
 * Where a sign only account lands: its inbox is the whole application.
 */
export const SIGN_ONLY_HOME = '/mis-firmas';

/**
 * The refusal `assertCanManageDocuments` returns for every write a restricted
 * account attempts, on both the tRPC and the REST surface.
 */
export const RESTRICTED_ACCOUNT_MESSAGE =
  'This account is restricted to signing documents which have been shared with it, and cannot perform this action.';

/**
 * The refusal every download answers with for a restricted account.
 */
export const RESTRICTED_ACCOUNT_DOWNLOAD_MESSAGE =
  'This account is restricted to signing documents which have been shared with it, and cannot download documents.';

/**
 * The refusal every read outside the signer allowlist answers with for a
 * restricted account (the team and organisation surfaces).
 */
export const RESTRICTED_ACCOUNT_READ_MESSAGE =
  'This account is restricted to signing documents which have been shared with it, and cannot read the documents or the team data of others.';

type SeedSignOnlyUserOptions = {
  name?: string;
  email?: string;
  password?: string;
};

/**
 * Create a sign only account directly through Prisma.
 *
 * Use it when the scenario is about what the profile can do, not about the
 * onboarding flow itself: the email comes verified and the password is already
 * hashed, so the account can sign in without going through the signup wizard.
 */
export const seedSignOnlyUser = async ({
  name = 'Sign Only',
  email = seedTestEmail(),
  password = 'password',
}: SeedSignOnlyUserOptions = {}) => {
  return await prisma.user.create({
    data: {
      name,
      email: email.toLowerCase(),
      password: hashSync(password),
      emailVerified: new Date(),
      roles: [Role.SIGN_ONLY],
    },
  });
};

type SeedSignOnlyTeamMemberOptions = {
  organisationId: string;
  teamId: number;
  name?: string;
  email?: string;
  organisationRole?: OrganisationMemberRole;
  teamRole?: TeamMemberRole;
};

/**
 * Create a sign only account and invite it into an existing organisation and
 * team, the way an invitation acceptance leaves it: membership only, no wider
 * profile and no personal workspace.
 *
 * `teamRole` defaults to `MANAGER` because `createApiToken` requires a role
 * with `MANAGE_TEAM`; pass `TeamMemberRole.MEMBER` for the invitation scenario,
 * which asserts what a plain member can and cannot do.
 */
export const seedSignOnlyTeamMember = async ({
  organisationId,
  teamId,
  name = 'Sign Only',
  email = seedTestEmail(),
  organisationRole = OrganisationMemberRole.MEMBER,
  teamRole = TeamMemberRole.MANAGER,
}: SeedSignOnlyTeamMemberOptions) => {
  const user = await seedSignOnlyUser({ name, email });

  const organisationGroups = await prisma.organisationGroup.findMany({
    where: {
      organisationId,
      type: OrganisationGroupType.INTERNAL_ORGANISATION,
    },
  });

  await addUserToOrganisation({
    userId: user.id,
    organisationId,
    organisationGroups,
    organisationMemberRole: organisationRole,
    bypassEmail: true,
  });

  const { id: organisationMemberId } = await prisma.organisationMember.findFirstOrThrow({
    where: {
      userId: user.id,
      organisationId,
    },
  });

  // The team role is assigned by the organisation owner, who is the highest
  // authority in the hierarchy, so any role can be granted.
  const { ownerUserId } = await prisma.organisation.findFirstOrThrow({
    where: {
      id: organisationId,
    },
    select: {
      ownerUserId: true,
    },
  });

  await createTeamMembers({
    userId: ownerUserId,
    teamId,
    membersToCreate: [
      {
        organisationMemberId,
        teamRole,
      },
    ],
  });

  return user;
};

/**
 * Create a pending organisation invitation for the given email.
 *
 * Mirrors what `createOrganisationMemberInvites` writes, without sending the
 * email, so the invitation link can be visited directly.
 */
export const seedSignOnlyInvitation = async ({
  organisationId,
  email,
  organisationRole = OrganisationMemberRole.MEMBER,
}: {
  organisationId: string;
  email: string;
  organisationRole?: OrganisationMemberRole;
}) => {
  return await prisma.organisationMemberInvite.create({
    data: {
      id: generateDatabaseId('member_invite'),
      email: email.toLowerCase(),
      organisationId,
      organisationRole,
      token: nanoid(32),
    },
  });
};

/**
 * Seed the organisation owner plus a sign only member of the same organisation
 * and team, the shape every "an invited sign only account" scenario needs.
 */
export const seedSignOnlyMemberContext = async ({
  organisationRole = OrganisationMemberRole.MEMBER,
  teamRole = TeamMemberRole.MANAGER,
}: {
  organisationRole?: OrganisationMemberRole;
  teamRole?: TeamMemberRole;
} = {}) => {
  const { user: owner, organisation, team } = await seedUser();

  const signOnlyUser = await seedSignOnlyTeamMember({
    organisationId: organisation.id,
    teamId: team.id,
    organisationRole,
    teamRole,
  });

  return { owner, organisation, team, signOnlyUser };
};

/**
 * Mint an API token for a sign only account.
 *
 * The guard on `apiToken.create` would refuse the mutation, so the token is
 * created through the same server function the route uses. This is also how a
 * token issued before a profile change exists, which is what the demotion
 * scenario has to invalidate.
 */
export const createSignOnlyApiToken = async ({
  userId,
  teamId,
  tokenName = 'e2e-sign-only',
}: {
  userId: number;
  teamId: number;
  tokenName?: string;
}) => {
  const { token } = await createApiToken({
    userId,
    teamId,
    tokenName,
    expiresIn: null,
  });

  return token;
};

/**
 * The number of organisations the account owns, which is what "no personal
 * workspace" means in the database.
 */
export const countOwnedOrganisations = async (userId: number) => {
  return await prisma.organisation.count({
    where: {
      ownerUserId: userId,
    },
  });
};

/**
 * The number of organisations the account is a member of.
 */
export const countOrganisationMemberships = async (userId: number) => {
  return await prisma.organisationMember.count({
    where: {
      userId,
    },
  });
};

/**
 * Assert the response is the 403 the restricted account closure produces.
 *
 * Both surfaces carry the refusal message, so the status and the message are
 * checked together: a generic 403 (for instance a team permission failure)
 * would not satisfy this.
 */
export const expectForbiddenResponse = async (response: APIResponse, message: string) => {
  const body = await response.text();

  expect(response.status(), `expected 403 but got ${response.status()}: ${body}`).toBe(403);
  expect(body).toContain(message);
};

/**
 * Assert a tRPC query was refused for a restricted account.
 *
 * The session surface answers with the refusal inside the body - the HTTP status
 * is 403 for a single call and may still be 200 on a batched one - while the
 * public API always answers 403. The body carries the decision either way, so
 * the assertion is made there.
 */
export const expectTrpcQueryRefused = async (
  response: APIResponse,
  message: string = RESTRICTED_ACCOUNT_READ_MESSAGE,
) => {
  const body = await response.text();

  expect(body, `expected a refusal but got: ${body}`).toContain('FORBIDDEN');
  expect(body, `expected the read refusal message but got: ${body}`).toContain(message);

  if (!response.ok()) {
    expect(response.status()).toBe(403);
  }
};

type TrpcMutationOptions = {
  page: Page;
  path: string;
  input?: Record<string, unknown>;
};

/**
 * Call a tRPC mutation with the session the page already holds.
 *
 * The body is the non batched superjson format the app client sends, and the
 * same one the existing `GET /api/trpc/...?input={"json":...}` helpers use.
 *
 * The account closure runs as a middleware, before the input parser, so the
 * call is refused with `FORBIDDEN` even when the body would not satisfy the
 * route schema.
 */
export const postTrpcMutation = async ({ page, path, input = {} }: TrpcMutationOptions) => {
  return await page.context().request.post(`${NEXT_PUBLIC_WEBAPP_URL()}/api/trpc/${path}`, {
    headers: {
      'content-type': 'application/json',
    },
    data: {
      json: input,
    },
  });
};

/**
 * Assert the shell a sign only account is allowed to see.
 *
 * The inbox is reachable, and the team navigation (which is where documents,
 * templates, folders and team settings live) is not rendered at all.
 */
export const expectSignOnlyInboxShell = async (page: Page) => {
  await expect(page.getByTestId('mis-firmas-page')).toBeVisible();

  await expect(page.getByRole('link', { name: 'My signatures' })).not.toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Documents' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Templates' })).toHaveCount(0);
};

/**
 * Assert every given path is sent back to the sign only inbox.
 *
 * The middleware and the authenticated layout both run the same rule, so a
 * typed URL cannot reach the team or organisation area by hand.
 */
export const expectPathsRedirectToInbox = async (page: Page, paths: string[]) => {
  for (const path of paths) {
    await page.goto(path);

    await expect(page, `expected ${path} to be redirected to ${SIGN_ONLY_HOME}`).toHaveURL(
      new RegExp(`${SIGN_ONLY_HOME}$`),
    );
  }
};
