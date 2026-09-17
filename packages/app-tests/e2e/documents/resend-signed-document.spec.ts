import { prisma } from '@documenso/prisma';
import { seedCompletedDocument, seedPendingDocument } from '@documenso/prisma/seed/documents';
import { seedTeam, seedTeamMember } from '@documenso/prisma/seed/teams';
import { seedUser } from '@documenso/prisma/seed/users';
import { expect, type Page, test } from '@playwright/test';
import { TeamMemberRole } from '@prisma/client';

import { apiSignin } from '../fixtures/authentication';
import { expectToastTextToBeVisible, openDropdownMenu } from '../fixtures/generic';

test.describe.configure({ mode: 'parallel' });

/**
 * Inbucket (the test mail server started by `npm run dx:up`) exposes its HTTP
 * API on port 9000.
 */
const INBUCKET_URL = 'http://localhost:9000';

const seedSignedDocument = async () => {
  const { owner, team } = await seedTeam();

  const { user: signer } = await seedUser();

  const document = await seedCompletedDocument(owner, team.id, [signer], {
    createDocumentOptions: {
      title: '[TEST] Resend signed document',
    },
  });

  await prisma.envelope.update({
    where: {
      id: document.id,
    },
    data: {
      completedAt: new Date(),
    },
  });

  const recipient = await prisma.recipient.findFirstOrThrow({
    where: {
      envelopeId: document.id,
    },
  });

  return { owner, team, document, recipient, signer };
};

type ResendSignedDocumentOptions = {
  page: Page;
  documentTitle: string;
  recipientId: number;
  message?: string;
};

const resendSignedDocumentViaUi = async ({
  page,
  documentTitle,
  recipientId,
  message,
}: ResendSignedDocumentOptions) => {
  const row = page.locator('tr', { hasText: documentTitle });

  await openDropdownMenu(page, row.getByTestId('document-table-action-btn'));

  await page.getByTestId('document-resend-signed-action').click();

  await expect(page.getByRole('heading', { name: 'Resend Signed Document' })).toBeVisible();

  await page.getByTestId(`resend-signed-recipient-${recipientId}`).click();

  if (message) {
    await page.getByTestId('resend-signed-message').fill(message);
  }

  await page.getByTestId('resend-signed-submit').click();
};

test('[RESEND SIGNED]: the owner can resend the signed document and the delivery is logged', async ({ page }) => {
  const { owner, team, document, recipient } = await seedSignedDocument();

  await apiSignin({
    page,
    email: owner.email,
    redirectPath: `/t/${team.url}/documents`,
  });

  await resendSignedDocumentViaUi({
    page,
    documentTitle: document.title,
    recipientId: recipient.id,
    message: 'Please find the signed copy attached.',
  });

  await expectToastTextToBeVisible(page, 'Signed document resent');

  // The new delivery is recorded on the document audit log.
  await expect(async () => {
    const auditLog = await prisma.documentAuditLog.findFirst({
      where: {
        envelopeId: document.id,
        type: 'EMAIL_SENT',
        data: {
          path: ['isResending'],
          equals: true,
        },
      },
    });

    expect(auditLog).not.toBeNull();

    expect(auditLog?.data).toMatchObject({
      emailType: 'DOCUMENT_COMPLETED',
      recipientEmail: recipient.email,
      recipientId: recipient.id,
      isResending: true,
    });
  }).toPass();

  // And it is visible in the document history.
  await page.goto(`/t/${team.url}/documents/${document.id}`);

  await expect(page.getByText(/resent an email to/i)).toBeVisible();
});

test('[RESEND SIGNED]: team members with the SGC role are copied on the resent document', async ({ page }) => {
  const { owner, team, document, recipient } = await seedSignedDocument();

  const sgcMember = await seedTeamMember({
    teamId: team.id,
    name: 'SGC copy member',
    role: TeamMemberRole.SGC,
  });

  await apiSignin({
    page,
    email: owner.email,
    redirectPath: `/t/${team.url}/documents`,
  });

  await resendSignedDocumentViaUi({
    page,
    documentTitle: document.title,
    recipientId: recipient.id,
  });

  await expectToastTextToBeVisible(page, 'Signed document resent');

  const mailbox = recipient.email.split('@')[0];

  await expect(async () => {
    const messages = (await fetch(`${INBUCKET_URL}/api/v1/mailbox/${mailbox}`).then(
      async (res) => await res.json(),
    )) as { id: string }[];

    expect(messages.length).toBeGreaterThan(0);

    const [message] = messages;

    const messageDetails = await fetch(`${INBUCKET_URL}/api/v1/mailbox/${mailbox}/${message.id}`).then(
      async (res) => await res.json(),
    );

    // Compare against the raw payload so the assertion does not depend on the
    // exact response shape of the test mail server.
    expect(JSON.stringify(messageDetails)).toContain(sgcMember.email);
  }).toPass();
});

test('[RESEND SIGNED]: the action is not offered for documents that are not completed', async ({ page }) => {
  const { owner, team } = await seedTeam();

  const { user: signer } = await seedUser();

  const pendingDocument = await seedPendingDocument(owner, team.id, [signer], {
    createDocumentOptions: {
      title: '[TEST] Pending document',
    },
  });

  await apiSignin({
    page,
    email: owner.email,
    redirectPath: `/t/${team.url}/documents`,
  });

  const row = page.locator('tr', { hasText: pendingDocument.title });

  await openDropdownMenu(page, row.getByTestId('document-table-action-btn'));

  await expect(page.getByTestId('document-resend-signed-action')).toHaveCount(0);
});
