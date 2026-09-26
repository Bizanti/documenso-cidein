/**
 * Scenarios A4 and B: signing from the inbox.
 *
 * - A4 (covered): a sign only account opens its inbox, follows the signing
 *   link of a pending document and signs it for real, without being redirected
 *   away and without an error.
 * - B (partially covered): the inbox sections. A document behind a real signer
 *   is listed as waiting (and offers no signing link) while a document behind a
 *   CC is already pending, and a signed document lands in the history with its
 *   status. Moving a waiting document to pending requires the preceding signer
 *   to sign in a second browser context, which is documented as deferred in
 *   `sign-only/README.md`.
 */

import { prisma } from '@documenso/prisma';
import { seedPendingDocument } from '@documenso/prisma/seed/documents';
import { seedTestEmail, seedUser } from '@documenso/prisma/seed/users';
import { expect, test } from '@playwright/test';
import { DocumentStatus } from '@prisma/client';

import { apiSeedPendingDocument } from '../fixtures/api-seeds';
import { apiSignin } from '../fixtures/authentication';
import { SIGN_ONLY_HOME, seedSignOnlyUser } from '../fixtures/sign-only';
import { signSignaturePad } from '../fixtures/signature';

test.use({ storageState: { cookies: [], origins: [] } });

test.describe.configure({ mode: 'parallel' });

const SIGNATURE_FIELD = {
  type: 'SIGNATURE',
  page: 1,
  positionX: 10,
  positionY: 10,
  width: 15,
  height: 5,
};

test('A4: a sign only account signs a document from its inbox and it moves to the history', async ({ page }) => {
  const { user: owner, team } = await seedUser();

  const signOnlyUser = await seedSignOnlyUser({ name: 'A4 Signer' });

  const title = '[TEST] A4 sign only signing';

  const document = await seedPendingDocument(owner, team.id, [signOnlyUser.email], {
    createDocumentOptions: {
      title,
    },
  });

  const recipient = document.recipients[0];

  await apiSignin({ page, email: signOnlyUser.email, redirectPath: '/' });

  await expect(page).toHaveURL(new RegExp(`${SIGN_ONLY_HOME}$`));

  const pendingRow = page.getByTestId('mis-firmas-pending').getByTestId('mis-firmas-document');

  await expect(pendingRow).toHaveCount(1);
  await expect(pendingRow).toContainText(title);

  // The inbox hands out the recipient token, which is what makes the document
  // signable without an email round trip.
  await expect(pendingRow.getByTestId('mis-firmas-sign-link')).toHaveAttribute('href', `/sign/${recipient.token}`);

  await pendingRow.getByTestId('mis-firmas-sign-link').click();

  await page.waitForURL(`/sign/${recipient.token}`);

  await signSignaturePad(page);

  await page.getByRole('button', { name: 'Complete' }).click();
  await page.waitForTimeout(1000);
  await page.getByRole('button', { name: 'Sign' }).click({ force: true });

  await page.waitForURL(`/sign/${recipient.token}/complete`);

  await expect
    .poll(async () => {
      const envelope = await prisma.envelope.findFirstOrThrow({
        where: {
          id: document.id,
        },
      });

      return envelope.status;
    })
    .toBe(DocumentStatus.COMPLETED);

  // Back to the inbox: the document is no longer pending and is reported as signed.
  await page.goto(SIGN_ONLY_HOME);

  await expect(page.getByTestId('mis-firmas-pending').getByTestId('mis-firmas-document')).toHaveCount(0);

  const historyRow = page.getByTestId('mis-firmas-history').getByTestId('mis-firmas-document');

  await expect(historyRow).toHaveCount(1);
  await expect(historyRow).toContainText(title);
  await expect(historyRow.getByTestId('mis-firmas-history-status')).toHaveText('Signed');
});

test('B: the inbox waits behind a real signer and is already actionable behind a CC', async ({ page, request }) => {
  const signOnlyUser = await seedSignOnlyUser({ name: 'B Signer' });

  // Sequential document: the CC has nothing to do, so it never blocks the turn.
  await apiSeedPendingDocument(request, {
    title: '[TEST] B pending behind a CC',
    meta: { signingOrder: 'SEQUENTIAL' },
    recipients: [
      { email: seedTestEmail(), name: 'CC recipient', role: 'CC', signingOrder: 1 },
      { email: signOnlyUser.email, name: 'Sign Only', role: 'SIGNER', signingOrder: 2 },
    ],
    fieldsPerRecipient: [[], [SIGNATURE_FIELD]],
  });

  // Sequential document: the first signer has not signed yet, so it is not this
  // account's turn.
  await apiSeedPendingDocument(request, {
    title: '[TEST] B waiting behind a signer',
    meta: { signingOrder: 'SEQUENTIAL' },
    recipients: [
      { email: seedTestEmail(), name: 'First signer', role: 'SIGNER', signingOrder: 1 },
      { email: signOnlyUser.email, name: 'Sign Only', role: 'SIGNER', signingOrder: 2 },
    ],
    fieldsPerRecipient: [[SIGNATURE_FIELD], [SIGNATURE_FIELD]],
  });

  await apiSignin({ page, email: signOnlyUser.email, redirectPath: '/' });

  await expect(page).toHaveURL(new RegExp(`${SIGN_ONLY_HOME}$`));

  const pendingRow = page.getByTestId('mis-firmas-pending').getByTestId('mis-firmas-document');

  await expect(pendingRow).toHaveCount(1);
  await expect(pendingRow).toContainText('[TEST] B pending behind a CC');
  await expect(pendingRow.getByTestId('mis-firmas-sign-link')).toHaveCount(1);

  const waitingRow = page.getByTestId('mis-firmas-waiting').getByTestId('mis-firmas-document');

  await expect(waitingRow).toHaveCount(1);
  await expect(waitingRow).toContainText('[TEST] B waiting behind a signer');

  // A document whose turn has not arrived never carries a signing token.
  await expect(waitingRow.getByTestId('mis-firmas-sign-link')).toHaveCount(0);

  await expect(page.getByTestId('mis-firmas-history').getByTestId('mis-firmas-document')).toHaveCount(0);
});
