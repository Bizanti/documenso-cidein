import { prisma } from '@documenso/prisma';
import { seedCompletedDocument, seedPendingDocument } from '@documenso/prisma/seed/documents';
import { seedTeam, seedTeamMember } from '@documenso/prisma/seed/teams';
import { seedUser } from '@documenso/prisma/seed/users';
import { expect, type Page, test } from '@playwright/test';
import { RecipientRole, TeamMemberRole } from '@prisma/client';

import { apiSignin } from '../fixtures/authentication';
import { expectToastTextToBeVisible, openDropdownMenu } from '../fixtures/generic';

test.describe.configure({ mode: 'parallel' });

/**
 * Inbucket (the test mail server started by `npm run dx:up`) exposes its HTTP
 * API on port 9000.
 */
const INBUCKET_URL = 'http://localhost:9000';

const seedSignedDocument = async () => {
  const { owner, team, organisation } = await seedTeam();

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

  return { owner, team, organisation, document, recipient, signer };
};

/**
 * Prevents the organisation from sending any email.
 */
const disableOrganisationEmails = async (organisationId: string) => {
  const organisation = await prisma.organisation.findFirstOrThrow({
    where: {
      id: organisationId,
    },
    select: {
      organisationClaim: true,
    },
  });

  await prisma.organisationClaim.update({
    where: {
      id: organisation.organisationClaim.id,
    },
    data: {
      flags: {
        ...(organisation.organisationClaim.flags as Record<string, unknown>),
        disableEmails: true,
      },
    },
  });
};

/**
 * The messages currently sitting in the recipient's test mailbox.
 *
 * An unknown mailbox has no messages rather than an error response.
 */
const getMailboxMessages = async (email: string) => {
  const mailbox = email.split('@')[0];

  const response = await fetch(`${INBUCKET_URL}/api/v1/mailbox/${mailbox}`);

  if (!response.ok) {
    return [];
  }

  return (await response.json()) as { id: string }[];
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
    const messages = await getMailboxMessages(recipient.email);

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

test('[RESEND SIGNED]: nothing is sent and the user is told when the organisation has emails disabled', async ({
  page,
}) => {
  const { owner, team, organisation, document, recipient } = await seedSignedDocument();

  await disableOrganisationEmails(organisation.id);

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

  // The user is told that no email went out, instead of a false success.
  await expectToastTextToBeVisible(page, 'Signed document not sent');
  await expectToastTextToBeVisible(page, 'Email sending is disabled for this organisation');

  await expect(page.locator('[role="status"]').getByText('Signed document resent')).toHaveCount(0);

  // No delivery is recorded on the document audit log.
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

  expect(auditLog).toBeNull();

  // And the recipient never received an email. The send happens before the
  // request resolves, so no waiting is needed by the time the toast is shown.
  const messages = await getMailboxMessages(recipient.email);

  expect(messages).toHaveLength(0);
});

test('[RESEND SIGNED]: the rejection message is translated instead of showing the raw Lingui id', async ({ page }) => {
  const { owner, team, document } = await seedSignedDocument();

  await apiSignin({
    page,
    email: owner.email,
    redirectPath: `/t/${team.url}/documents`,
  });

  const row = page.locator('tr', { hasText: document.title });

  await openDropdownMenu(page, row.getByTestId('document-table-action-btn'));

  await page.getByTestId('document-resend-signed-action').click();

  await expect(page.getByRole('heading', { name: 'Resend Signed Document' })).toBeVisible();

  // Sending with nothing selected is rejected.
  await page.getByTestId('resend-signed-submit').click();

  await expect(page.getByText('You must select at least one recipient')).toBeVisible();

  // The user never sees the Lingui message id that backs the validation message.
  await expect(page.getByText('Xkxw3d')).toHaveCount(0);
});

test('[RESEND SIGNED]: a document that only has controlled signers cannot be resent to anyone', async ({ page }) => {
  const { owner, team, document, recipient } = await seedSignedDocument();

  // Controlled signers never receive a copy of the completed document.
  await prisma.recipient.update({
    where: {
      id: recipient.id,
    },
    data: {
      role: RecipientRole.CONTROLLED_SIGNER,
    },
  });

  await apiSignin({
    page,
    email: owner.email,
    redirectPath: `/t/${team.url}/documents`,
  });

  const row = page.locator('tr', { hasText: document.title });

  await openDropdownMenu(page, row.getByTestId('document-table-action-btn'));

  await page.getByTestId('document-resend-signed-action').click();

  await expect(page.getByRole('heading', { name: 'Resend Signed Document' })).toBeVisible();

  // The dialog explains the situation instead of showing an empty list.
  await expect(page.getByTestId('resend-signed-empty-state')).toBeVisible();
  await expect(page.getByText('No recipients can receive the completed document')).toBeVisible();

  // And nothing can be sent.
  await expect(page.getByTestId('resend-signed-submit')).toBeDisabled();
  await expect(page.getByTestId(`resend-signed-recipient-${recipient.id}`)).toHaveCount(0);
});
