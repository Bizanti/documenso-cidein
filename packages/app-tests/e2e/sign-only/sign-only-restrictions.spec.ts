/**
 * Scenarios C: creating content.
 *
 * - C1 (covered): creating a document is refused. In the UI because the team
 *   area, where the upload control lives, is not reachable and the inbox has no
 *   upload control; through the API because every write is refused with the
 *   restricted account message.
 * - C2 (covered): folders, templates and duplication are refused the same way.
 * - C3 (covered): creating a team or an organisation is refused. Neither route
 *   is exposed on the public API, so the refusal is asserted on the tRPC
 *   endpoint the app itself calls, with the session the account holds.
 */

import fs from 'node:fs';
import path from 'node:path';
import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { prisma } from '@documenso/prisma';
import { type APIRequestContext, type APIResponse, expect, test } from '@playwright/test';

import { apiSignin } from '../fixtures/authentication';
import {
  createSignOnlyApiToken,
  expectForbiddenResponse,
  expectPathsRedirectToInbox,
  expectSignOnlyInboxShell,
  postTrpcMutation,
  RESTRICTED_ACCOUNT_MESSAGE,
  seedSignOnlyMemberContext,
} from '../fixtures/sign-only';

test.use({ storageState: { cookies: [], origins: [] } });

test.describe.configure({ mode: 'parallel' });

const API_BASE_URL = `${NEXT_PUBLIC_WEBAPP_URL()}/api/v2-beta`;

const examplePdfBuffer = fs.readFileSync(path.join(__dirname, '../../../../assets/example.pdf'));

/**
 * Create an envelope through the API the same way the app seed helpers do, so
 * the request reaches the authorization middleware instead of failing on
 * request validation.
 */
const postEnvelopeCreate = async ({
  request,
  token,
  type,
}: {
  request: APIRequestContext;
  token: string;
  type: 'DOCUMENT' | 'TEMPLATE';
}): Promise<APIResponse> => {
  const formData = new FormData();

  formData.append('payload', JSON.stringify({ title: '[TEST] restricted envelope', type }));
  formData.append('files', new File([examplePdfBuffer], 'example.pdf', { type: 'application/pdf' }));

  return await request.post(`${API_BASE_URL}/envelope/create`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
    multipart: formData,
  });
};

test('C1: creating a document is refused in the UI and through the API', async ({ page, request }) => {
  const { team, signOnlyUser } = await seedSignOnlyMemberContext();

  const token = await createSignOnlyApiToken({ userId: signOnlyUser.id, teamId: team.id });

  await apiSignin({ page, email: signOnlyUser.email, redirectPath: '/' });

  await expectSignOnlyInboxShell(page);

  // UI: the documents area is not reachable, and the inbox offers no upload control.
  await expectPathsRedirectToInbox(page, [`/t/${team.url}/documents`, `/t/${team.url}/documents/folders`]);
  await expect(page.getByTestId('document-upload-input')).toHaveCount(0);

  // API: the direct call is refused before anything is created, on the v2 surface
  // and on the v1 REST surface alike.
  await expectForbiddenResponse(
    await postEnvelopeCreate({ request, token, type: 'DOCUMENT' }),
    RESTRICTED_ACCOUNT_MESSAGE,
  );

  await expectForbiddenResponse(
    await request.post(`${NEXT_PUBLIC_WEBAPP_URL()}/api/v1/documents/999999999/send`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      data: { sendEmail: false },
    }),
    RESTRICTED_ACCOUNT_MESSAGE,
  );
});

test('C2: folders, templates and duplication are refused in the UI and through the API', async ({ page, request }) => {
  const { team, signOnlyUser } = await seedSignOnlyMemberContext();

  const token = await createSignOnlyApiToken({ userId: signOnlyUser.id, teamId: team.id });

  await apiSignin({ page, email: signOnlyUser.email, redirectPath: '/' });

  await expectSignOnlyInboxShell(page);

  await expectPathsRedirectToInbox(page, [
    `/t/${team.url}/documents/folders`,
    `/t/${team.url}/templates`,
    `/t/${team.url}/templates/folders`,
  ]);

  const authHeader = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  // Folder.
  await expectForbiddenResponse(
    await request.post(`${API_BASE_URL}/folder/create`, {
      headers: authHeader,
      data: { name: '[TEST] restricted folder' },
    }),
    RESTRICTED_ACCOUNT_MESSAGE,
  );

  // Template.
  await expectForbiddenResponse(
    await postEnvelopeCreate({ request, token, type: 'TEMPLATE' }),
    RESTRICTED_ACCOUNT_MESSAGE,
  );

  // Duplicate.
  await expectForbiddenResponse(
    await request.post(`${API_BASE_URL}/envelope/duplicate`, {
      headers: authHeader,
      data: { envelopeId: 'envelope_00000000000000000000000000', includeRecipients: true, includeFields: true },
    }),
    RESTRICTED_ACCOUNT_MESSAGE,
  );

  // Nothing was created.
  const restrictedEnvelopeCount = await prisma.envelope.count({
    where: {
      teamId: team.id,
      title: {
        contains: '[TEST] restricted',
      },
    },
  });

  expect(restrictedEnvelopeCount).toBe(0);
});

test('C3: creating a team or an organisation is refused in the UI and through the API', async ({ page }) => {
  const { organisation, signOnlyUser } = await seedSignOnlyMemberContext();

  await apiSignin({ page, email: signOnlyUser.email, redirectPath: '/' });

  await expectSignOnlyInboxShell(page);

  // UI: the pages which host the create dialogs are out of bounds.
  await expectPathsRedirectToInbox(page, ['/settings/organisations', `/o/${organisation.url}/settings/teams`]);

  // API: neither route is exposed publicly, so the app's own tRPC endpoint is
  // called with the session; the account closure runs before the input parser.
  const createTeamResponse = await postTrpcMutation({
    page,
    path: 'team.create',
    input: { teamName: '[TEST] restricted team', teamUrl: 'restricted-team', organisationId: organisation.id },
  });

  await expectForbiddenResponse(createTeamResponse, RESTRICTED_ACCOUNT_MESSAGE);

  const createOrganisationResponse = await postTrpcMutation({
    page,
    path: 'organisation.create',
    input: { name: '[TEST] restricted organisation' },
  });

  await expectForbiddenResponse(createOrganisationResponse, RESTRICTED_ACCOUNT_MESSAGE);
});
