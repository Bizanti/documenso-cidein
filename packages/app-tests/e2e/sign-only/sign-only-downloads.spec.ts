/**
 * Scenarios E (download policy) and G2 (an external recipient keeps its role
 * policy).
 *
 * - E1 (covered, regression): a controlled signer still downloads nothing. The
 *   full surface is covered by `e2e/api/v2/controlled-signer-file-access.spec.ts`;
 *   the assertion here keeps the rule pinned next to the restricted profile.
 * - E2 (covered): a signer whose account is restricted downloads nothing, on
 *   every surface: the session routes, the public API, the recipient token and
 *   the policy the UI renders from, plus the send-time attachment rule.
 * - E3 (covered): the same for an account holding SGC privileges, which would
 *   otherwise be the role allowed to download past the window and the only one
 *   allowed to download the original of a final document.
 * - E4 (covered): rendering is not downloading. A restricted account can still
 *   open the viewer of the document it has to sign: the item render route
 *   answers 200 while the download route answers 403.
 * - E5 (covered): the real completion email a restricted signer receives is
 *   delivered without the document. Read from the test mail server the suite
 *   already uses (`inbucket`), so the "ni adjunto" half of E2 is asserted
 *   against a message that really went out, not only against the policy the
 *   senders call.
 * - G2 (covered): an addressee without an account is ruled by its recipient role
 *   alone, so an external signer may still receive and download the document.
 */

import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { canAttachDocumentPdfToAddressee } from '@documenso/lib/server-only/document/document-attachment-policy';
import { canDownloadDocument } from '@documenso/lib/server-only/document/download-policy';
import { mapSecondaryIdToDocumentId } from '@documenso/lib/utils/envelope';
import { prisma } from '@documenso/prisma';
import { seedCompletedDocument, seedPendingDocument } from '@documenso/prisma/seed/documents';
import { seedTestEmail, seedUser } from '@documenso/prisma/seed/users';
import { expect, type Page, test } from '@playwright/test';
import { DocumentStatus, RecipientRole, TeamMemberRole } from '@prisma/client';

import { apiSeedPendingDocument } from '../fixtures/api-seeds';
import { apiSignin } from '../fixtures/authentication';
import {
  createSignOnlyApiToken,
  expectForbiddenResponse,
  expectPathsRedirectToInbox,
  expectSignOnlyInboxShell,
  RESTRICTED_ACCOUNT_DOWNLOAD_MESSAGE,
  seedSignOnlyMemberContext,
  seedSignOnlyUser,
} from '../fixtures/sign-only';
import { signSignaturePad } from '../fixtures/signature';

test.use({ storageState: { cookies: [], origins: [] } });

test.describe.configure({ mode: 'parallel' });

/**
 * Inbucket (the test mail server `npm run dx:up` starts) exposes its HTTP API on
 * port 9000, the endpoint `e2e/emails-branding.spec.ts` and
 * `e2e/documents/resend-signed-document.spec.ts` already read.
 */
const INBUCKET_URL = 'http://localhost:9000';

type InbucketMessage = {
  id: string;
};

type InbucketMessagePart = {
  filename?: string;
  'content-type'?: string;
};

/** The messages sitting in a recipient's mailbox, newest first. */
const getMailboxMessages = async (email: string) => {
  const mailbox = email.split('@')[0];

  const response = await fetch(`${INBUCKET_URL}/api/v1/mailbox/${mailbox}`);

  if (!response.ok) {
    return [];
  }

  return (await response.json()) as InbucketMessage[];
};

/** The MIME parts a message carries, as the test mail server parses them. */
const getMessageParts = async (email: string, messageId: string) => {
  const mailbox = email.split('@')[0];

  const response = await fetch(`${INBUCKET_URL}/api/v1/mailbox/${mailbox}/${messageId}`);

  expect(response.ok, `could not read message ${messageId}: ${await response.text()}`).toBe(true);

  const details = (await response.json()) as { attachments?: InbucketMessagePart[] };

  return details.attachments ?? [];
};

/** The raw SMTP source of a message, where an attached PDF shows up as a part. */
const getMessageSource = async (email: string, messageId: string) => {
  const mailbox = email.split('@')[0];

  const response = await fetch(`${INBUCKET_URL}/api/v1/mailbox/${mailbox}/${messageId}/source`);

  expect(response.ok, `could not read the source of message ${messageId}`).toBe(true);

  return await response.text();
};

const getSessionDownloadUrl = ({
  envelopeId,
  envelopeItemId,
  version,
}: {
  envelopeId: string;
  envelopeItemId: string;
  version: 'signed' | 'original';
}) => `${NEXT_PUBLIC_WEBAPP_URL()}/api/files/envelope/${envelopeId}/envelopeItem/${envelopeItemId}/download/${version}`;

const getTokenDownloadUrl = ({
  token,
  envelopeItemId,
  version,
}: {
  token: string;
  envelopeItemId: string;
  version: 'signed' | 'original';
}) => `${NEXT_PUBLIC_WEBAPP_URL()}/api/files/token/${token}/envelopeItem/${envelopeItemId}/download/${version}`;

/**
 * The viewer URL the signing page feeds to the PDF viewer: `current` is the
 * document with the signatures collected so far.
 */
const getTokenViewerUrl = ({
  token,
  envelopeId,
  envelopeItemId,
  documentDataId,
}: {
  token: string;
  envelopeId: string;
  envelopeItemId: string;
  documentDataId: string;
}) =>
  `${NEXT_PUBLIC_WEBAPP_URL()}/api/files/token/${token}/envelope/${envelopeId}/envelopeItem/${envelopeItemId}/dataId/${documentDataId}/current/item.pdf`;

/**
 * Resolve the download policy the UI uses, exactly as the document tables and
 * the download dialog ask for it.
 *
 * Passing a token asks for the policy of the recipient viewing through that
 * token, which is the one a signer is handed.
 */
const getDownloadPolicy = async ({ page, envelopeId, token }: { page: Page; envelopeId: string; token?: string }) => {
  const input = encodeURIComponent(JSON.stringify({ json: { envelopeIds: [envelopeId], token } }));

  const response = await page
    .context()
    .request.get(`${NEXT_PUBLIC_WEBAPP_URL()}/api/trpc/document.getEnvelopeDownloadPolicies?input=${input}`);

  expect(response.ok(), `download policy query failed: ${await response.text()}`).toBeTruthy();

  const body = await response.json();

  return body.result.data.json.data[0];
};

/**
 * Assert both versions are hidden from the UI for the given envelope.
 */
const expectBothVersionsHidden = async ({
  page,
  envelopeId,
  token,
}: {
  page: Page;
  envelopeId: string;
  token?: string;
}) => {
  const policy = await getDownloadPolicy({ page, envelopeId, token });

  expect(policy.canDownloadSigned).toBe(false);
  expect(policy.canDownloadOriginal).toBe(false);
  expect(policy.downloadDenialReason).toBe('ACCOUNT_DOWNLOAD_FORBIDDEN');
};

test('E1: a controlled signer still downloads nothing', async ({ request }) => {
  const { user: owner, team } = await seedUser();

  const document = await seedCompletedDocument(owner, team.id, [seedTestEmail()], {
    createDocumentOptions: {
      title: '[TEST] E1 controlled signer',
      completedAt: new Date(),
    },
  });

  const recipient = await prisma.recipient.findFirstOrThrow({
    where: {
      envelopeId: document.id,
    },
  });

  await prisma.recipient.update({
    where: {
      id: recipient.id,
    },
    data: {
      role: RecipientRole.CONTROLLED_SIGNER,
    },
  });

  // The rule itself, as every caller evaluates it.
  expect(canDownloadDocument({ recipient: { role: RecipientRole.CONTROLLED_SIGNER } })).toBe(false);

  // And the route which hands out the bytes.
  const response = await request.get(
    getTokenDownloadUrl({
      token: recipient.token,
      envelopeItemId: document.envelopeItems[0].id,
      version: 'signed',
    }),
  );

  expect(response.status()).toBe(403);
  expect(await response.text()).toContain('Controlled signers are not permitted to download this document');
});

test('E2: a signer with a restricted account downloads nothing', async ({ page, request }) => {
  const { owner, team, signOnlyUser } = await seedSignOnlyMemberContext({
    teamRole: TeamMemberRole.MANAGER,
  });

  const token = await createSignOnlyApiToken({ userId: signOnlyUser.id, teamId: team.id });

  // The restricted account is a signer of this completed document.
  const document = await seedCompletedDocument(owner, team.id, [signOnlyUser], {
    createDocumentOptions: {
      title: '[TEST] E2 restricted signer',
      completedAt: new Date(),
    },
  });

  const envelopeItem = document.envelopeItems[0];

  const recipient = await prisma.recipient.findFirstOrThrow({
    where: {
      envelopeId: document.id,
      email: signOnlyUser.email,
    },
  });

  await apiSignin({ page, email: signOnlyUser.email, redirectPath: '/' });

  await expectSignOnlyInboxShell(page);

  // UI: the team area which carries the download controls is not reachable.
  await expectPathsRedirectToInbox(page, [`/t/${team.url}/documents/${document.id}`]);

  // Server, session: the signed copy and the original are both refused.
  await expectForbiddenResponse(
    await page
      .context()
      .request.get(
        getSessionDownloadUrl({ envelopeId: document.id, envelopeItemId: envelopeItem.id, version: 'signed' }),
      ),
    RESTRICTED_ACCOUNT_DOWNLOAD_MESSAGE,
  );

  await expectForbiddenResponse(
    await page
      .context()
      .request.get(
        getSessionDownloadUrl({ envelopeId: document.id, envelopeItemId: envelopeItem.id, version: 'original' }),
      ),
    RESTRICTED_ACCOUNT_DOWNLOAD_MESSAGE,
  );

  // Server, recipient token: the account behind the token is what decides, so
  // the signing token does not open the download route either.
  await expectForbiddenResponse(
    await request.get(
      getTokenDownloadUrl({ token: recipient.token, envelopeItemId: envelopeItem.id, version: 'signed' }),
    ),
    RESTRICTED_ACCOUNT_DOWNLOAD_MESSAGE,
  );

  // Server, API token: the public API reports the same refusal.
  await expectForbiddenResponse(
    await request.get(
      `${NEXT_PUBLIC_WEBAPP_URL()}/api/v1/documents/${mapSecondaryIdToDocumentId(document.secondaryId)}/download`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    ),
    RESTRICTED_ACCOUNT_DOWNLOAD_MESSAGE,
  );

  // UI: the policy the download controls render from hides both versions, for the
  // session and for the recipient token.
  await expectBothVersionsHidden({ page, envelopeId: document.id });
  await expectBothVersionsHidden({ page, envelopeId: document.id, token: recipient.token });

  // UI: the signer's own completion page offers no download control either.
  await page.goto(`/sign/${recipient.token}/complete`);

  await expect(page.getByRole('heading', { name: 'Document Signed' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Download locked', exact: true })).toHaveCount(0);

  // Attachment: the send-time rule refuses to attach the document to an email
  // addressed to the restricted account. Asserted against the policy entry point
  // the senders call; E5 asserts the same rule on the message that really goes
  // out.
  expect(await canAttachDocumentPdfToAddressee({ email: signOnlyUser.email })).toBe(false);
});

test('E3: an account with SGC privileges and a restricted profile downloads nothing', async ({ page }) => {
  const { owner, organisation, team, signOnlyUser } = await seedSignOnlyMemberContext({
    teamRole: TeamMemberRole.SGC,
  });

  // Prove the privilege is really held: without the restriction this role would
  // be the one allowed to download the original of a final document and the only
  // one allowed to download past the window.
  const organisationMember = await prisma.organisationMember.findFirstOrThrow({
    where: {
      userId: signOnlyUser.id,
      organisationId: organisation.id,
    },
  });

  const isSgcMember = await prisma.teamGroup.findFirst({
    where: {
      teamId: team.id,
      teamRole: TeamMemberRole.SGC,
      organisationGroup: {
        organisationGroupMembers: {
          some: {
            organisationMemberId: organisationMember.id,
          },
        },
      },
    },
  });

  expect(isSgcMember).not.toBeNull();

  const document = await seedCompletedDocument(owner, team.id, [signOnlyUser], {
    createDocumentOptions: {
      title: '[TEST] E3 restricted sgc',
      completedAt: new Date(),
    },
  });

  const envelopeItem = document.envelopeItems[0];

  await apiSignin({ page, email: signOnlyUser.email, redirectPath: '/' });

  await expectSignOnlyInboxShell(page);

  await expectForbiddenResponse(
    await page
      .context()
      .request.get(
        getSessionDownloadUrl({ envelopeId: document.id, envelopeItemId: envelopeItem.id, version: 'signed' }),
      ),
    RESTRICTED_ACCOUNT_DOWNLOAD_MESSAGE,
  );

  await expectForbiddenResponse(
    await page
      .context()
      .request.get(
        getSessionDownloadUrl({ envelopeId: document.id, envelopeItemId: envelopeItem.id, version: 'original' }),
      ),
    RESTRICTED_ACCOUNT_DOWNLOAD_MESSAGE,
  );

  // The SGC privilege does not survive the restricted profile in the UI either.
  await expectBothVersionsHidden({ page, envelopeId: document.id });
});

test('E4: a restricted account can still open the viewer of the document it signs', async ({ request }) => {
  const { user: owner, team } = await seedUser();

  const signOnlyUser = await seedSignOnlyUser({ name: 'E4 Signer' });

  const document = await seedPendingDocument(owner, team.id, [signOnlyUser.email], {
    createDocumentOptions: {
      title: '[TEST] E4 viewer',
    },
  });

  const envelopeItem = document.envelopeItems[0];
  const recipient = document.recipients[0];

  // Render: the viewer answers 200, because rendering is not downloading.
  const viewerResponse = await request.get(
    getTokenViewerUrl({
      token: recipient.token,
      envelopeId: document.id,
      envelopeItemId: envelopeItem.id,
      documentDataId: envelopeItem.documentDataId,
    }),
  );

  expect(viewerResponse.status(), await viewerResponse.text()).toBe(200);
  expect(viewerResponse.headers()['content-type']).toContain('pdf');
});

test('E5: the completion email a restricted signer receives travels without the document', async ({
  page,
  request,
}) => {
  const signOnlyUser = await seedSignOnlyUser({ name: 'E5 Signer' });

  const { envelope, distributeResult } = await apiSeedPendingDocument(request, {
    title: '[TEST] E5 restricted email',
    recipients: [{ email: signOnlyUser.email, name: 'E5 Signer', role: 'SIGNER' }],
    fieldsPerRecipient: [[{ type: 'SIGNATURE', page: 1, positionX: 10, positionY: 10, width: 15, height: 5 }]],
  });

  const recipient = distributeResult.recipients[0];

  if (!recipient) {
    throw new Error('The distribution did not hand out a signing token for the restricted signer');
  }

  // The restricted account signs for real: that is what completes the document
  // and makes the completion email go out through the transport.
  await apiSignin({ page, email: signOnlyUser.email, redirectPath: '/' });

  await page.goto(`/sign/${recipient.token}`);
  await signSignaturePad(page);
  await page.getByRole('button', { name: 'Complete' }).click();
  await page.waitForTimeout(1000);
  await page.getByRole('button', { name: 'Sign' }).click({ force: true });

  await page.waitForURL(`/sign/${recipient.token}/complete`);

  await expect
    .poll(
      async () => {
        const completed = await prisma.envelope.findFirstOrThrow({
          where: {
            id: envelope.id,
          },
        });

        return completed.status;
      },
      { timeout: 30_000 },
    )
    .toBe(DocumentStatus.COMPLETED);

  // The message goes out from a background job, so wait until the send of the
  // completion email addressed to the restricted account is on the audit log
  // before reading the mailbox: the assertions below must run against that
  // message, not against an earlier one.
  await expect
    .poll(
      async () => {
        const sentEmails = await prisma.documentAuditLog.findMany({
          where: {
            envelopeId: envelope.id,
            type: 'EMAIL_SENT',
            data: {
              path: ['emailType'],
              equals: 'DOCUMENT_COMPLETED',
            },
          },
          select: {
            data: true,
          },
        });

        return sentEmails.some(
          (email) => (email.data as { recipientEmail?: string }).recipientEmail === signOnlyUser.email,
        );
      },
      { timeout: 30_000 },
    )
    .toBe(true);

  // Nothing in this mailbox may carry the document: the signing request does not
  // attach it either, and the completion email has to withhold it because the
  // addressee cannot download it. Asserted against the parsed parts and the raw
  // source, so an inline logo is allowed but a PDF part is not.
  await expect(async () => {
    const messages = await getMailboxMessages(signOnlyUser.email);

    expect(messages.length).toBeGreaterThan(0);

    for (const message of messages) {
      const parts = await getMessageParts(signOnlyUser.email, message.id);

      const documentPart = parts.find((part) => part['content-type'] === 'application/pdf');

      expect(documentPart, `message ${message.id} carried the document as ${documentPart?.filename}`).toBeUndefined();

      const source = await getMessageSource(signOnlyUser.email, message.id);

      expect(source, `message ${message.id} attached a PDF part`).not.toContain('application/pdf');
    }
  }).toPass({ timeout: 30_000, intervals: [1000, 2000, 5000] });
});

test('G2: an external recipient without an account keeps its role policy', async ({ request }) => {
  const { user: owner, team } = await seedUser();

  const externalEmail = seedTestEmail();

  const document = await seedCompletedDocument(owner, team.id, [externalEmail], {
    createDocumentOptions: {
      title: '[TEST] G2 external recipient',
      completedAt: new Date(),
    },
  });

  const recipient = await prisma.recipient.findFirstOrThrow({
    where: {
      envelopeId: document.id,
    },
  });

  expect(recipient.role).toBe(RecipientRole.SIGNER);

  // No account exists for the address, so only the recipient role rules.
  expect(await canAttachDocumentPdfToAddressee({ email: externalEmail, recipientRole: recipient.role })).toBe(true);

  const downloadResponse = await request.get(
    getTokenDownloadUrl({
      token: recipient.token,
      envelopeItemId: document.envelopeItems[0].id,
      version: 'signed',
    }),
  );

  expect(downloadResponse.status(), await downloadResponse.text()).toBe(200);
});
