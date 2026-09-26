/**
 * Scenarios D: isolation.
 *
 * - D1 (covered): shared team. The account is a member of the team which holds
 *   other people's documents; the team area is unreachable, the inbox only lists
 *   documents addressed to the account itself, and reading the team's documents
 *   is refused on the session and on the public API surfaces.
 * - D2 (covered): manipulated URLs. Paths carrying the ids of another team or
 *   organisation, or a foreign document id under its own team, all end in the
 *   inbox.
 * - D3 (covered): invited as a plain member. A member holds no team management
 *   permission, so the upload can only be attempted through the account's own
 *   session, which is refused.
 */

import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { seedPendingDocument } from '@documenso/prisma/seed/documents';
import { seedTestEmail, seedUser } from '@documenso/prisma/seed/users';
import { type APIResponse, expect, test } from '@playwright/test';
import { TeamMemberRole } from '@prisma/client';

import { apiSignin } from '../fixtures/authentication';
import {
  createSignOnlyApiToken,
  expectForbiddenResponse,
  expectPathsRedirectToInbox,
  expectTrpcQueryRefused,
  postTrpcMutation,
  RESTRICTED_ACCOUNT_MESSAGE,
  SIGN_ONLY_HOME,
  seedSignOnlyMemberContext,
} from '../fixtures/sign-only';

test.use({ storageState: { cookies: [], origins: [] } });

test.describe.configure({ mode: 'parallel' });

const getTrpcQueryUrl = (path: string, input: Record<string, unknown>) =>
  `${NEXT_PUBLIC_WEBAPP_URL()}/api/trpc/${path}?input=${encodeURIComponent(JSON.stringify({ json: input }))}`;

/**
 * Assert a public API read was refused without leaking any of the document.
 */
const expectApiReadRefused = async (response: APIResponse, title: string) => {
  const body = await response.text();

  expect(response.status(), `expected 403 but got ${response.status()}: ${body}`).toBe(403);
  expect(body).toContain('FORBIDDEN');
  expect(body).not.toContain(title);
};

test('D1: a sign only member of a shared team does not see the team documents', async ({ page }) => {
  const { owner, team, signOnlyUser } = await seedSignOnlyMemberContext({ teamRole: TeamMemberRole.MEMBER });

  const teamDocumentTitle = '[TEST] D1 team document';

  const teamDocument = await seedPendingDocument(owner, team.id, [seedTestEmail()], {
    createDocumentOptions: {
      title: teamDocumentTitle,
    },
  });

  await apiSignin({ page, email: signOnlyUser.email, redirectPath: '/' });

  await expect(page).toHaveURL(new RegExp(`${SIGN_ONLY_HOME}$`));

  // The team area, which is where the team documents are listed, is not reachable.
  await expectPathsRedirectToInbox(page, [`/t/${team.url}/documents`, `/t/${team.url}/documents/${teamDocument.id}`]);

  // And the inbox lists what is addressed to the account, not what the team holds.
  await expect(page.getByTestId('mis-firmas-page')).not.toContainText(teamDocumentTitle);
  await expect(page.getByTestId('mis-firmas-document')).toHaveCount(0);

  // The team's documents cannot be asked for either.
  await expectTrpcQueryRefused(
    await page.context().request.get(getTrpcQueryUrl('document.find', { query: teamDocumentTitle })),
  );

  await expectTrpcQueryRefused(
    await page.context().request.get(getTrpcQueryUrl('envelope.get', { id: teamDocument.id })),
  );
});

test('D1 (API): a restricted account cannot read a team envelope through the public API', async ({ request }) => {
  const { owner, team, signOnlyUser } = await seedSignOnlyMemberContext({ teamRole: TeamMemberRole.MANAGER });

  const token = await createSignOnlyApiToken({ userId: signOnlyUser.id, teamId: team.id });

  const teamDocumentTitle = '[TEST] D1 api read';

  const teamDocument = await seedPendingDocument(owner, team.id, [seedTestEmail()], {
    createDocumentOptions: {
      title: teamDocumentTitle,
    },
  });

  const authHeader = {
    Authorization: `Bearer ${token}`,
  };

  await expectApiReadRefused(
    await request.get(`${NEXT_PUBLIC_WEBAPP_URL()}/api/v2/envelope/${teamDocument.id}`, {
      headers: authHeader,
    }),
    teamDocumentTitle,
  );

  await expectApiReadRefused(
    await request.get(`${NEXT_PUBLIC_WEBAPP_URL()}/api/v2/envelope`, {
      headers: authHeader,
    }),
    teamDocumentTitle,
  );
});

test('D2: typed URLs carrying the ids of another team or organisation end in the inbox', async ({ page }) => {
  const { organisation, team, signOnlyUser } = await seedSignOnlyMemberContext();

  const { user: foreignOwner, organisation: foreignOrganisation, team: foreignTeam } = await seedUser();

  const foreignDocument = await seedPendingDocument(foreignOwner, foreignTeam.id, [seedTestEmail()], {
    createDocumentOptions: {
      title: '[TEST] D2 foreign document',
    },
  });

  await apiSignin({ page, email: signOnlyUser.email, redirectPath: '/' });

  await expectPathsRedirectToInbox(page, [
    // Its own team, with a document id which belongs to another team.
    `/t/${team.url}/documents/${foreignDocument.id}`,
    `/t/${team.url}/templates/${foreignDocument.id}`,
    // Another team.
    `/t/${foreignTeam.url}/documents`,
    `/t/${foreignTeam.url}/documents/${foreignDocument.id}`,
    `/t/${foreignTeam.url}/settings/members`,
    `/t/${foreignTeam.url}/settings/tokens`,
    // Another organisation.
    `/o/${foreignOrganisation.url}/settings/members`,
    `/o/${foreignOrganisation.url}/settings/general`,
    // The organisation this account does belong to: membership does not open
    // the organisation settings either.
    `/o/${organisation.url}/settings/members`,
    // The administrative area.
    '/admin/users',
  ]);
});

test('D3: an account invited as a plain member cannot upload', async ({ page }) => {
  const { team, signOnlyUser } = await seedSignOnlyMemberContext({ teamRole: TeamMemberRole.MEMBER });

  await apiSignin({ page, email: signOnlyUser.email, redirectPath: '/' });

  // A plain member holds no team management permission, so it cannot mint an API
  // token either: the upload can only be attempted through its own session.
  await expectPathsRedirectToInbox(page, [`/t/${team.url}/documents`]);
  await expect(page.getByTestId('document-upload-input')).toHaveCount(0);

  const uploadResponse = await postTrpcMutation({ page, path: 'envelope.create', input: {} });

  await expectForbiddenResponse(uploadResponse, RESTRICTED_ACCOUNT_MESSAGE);
});
