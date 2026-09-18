import fs from 'node:fs';
import { prisma } from '@documenso/prisma';
import { seedCompletedDocument } from '@documenso/prisma/seed/documents';
import { seedTeam, seedTeamMember } from '@documenso/prisma/seed/teams';
import { seedUser } from '@documenso/prisma/seed/users';
import { expect, type Page, test } from '@playwright/test';
import type { User } from '@prisma/client';
import { TeamMemberRole } from '@prisma/client';
import { unzipSync } from 'fflate';

import { apiSignin } from '../fixtures/authentication';
import { expectToastTextToBeVisible } from '../fixtures/generic';

test.describe.configure({ mode: 'parallel' });

const HOUR_IN_MS = 60 * 60 * 1000;

const LOCKED_DOCUMENT_TITLE = '[TEST] Bulk download locked document';
const EXPIRED_WINDOW_HOURS = 48;

/**
 * Seeds a completed document with a single signer, applies the download window
 * (null means the global setting applies) and backdates the completion date so
 * the window can be tested as expired.
 */
const seedCompletedDocumentWithWindow = async ({
  owner,
  signer,
  teamId,
  title,
  completedHoursAgo,
  downloadWindowHours,
}: {
  owner: User;
  signer: User;
  teamId: number;
  title: string;
  completedHoursAgo: number;
  downloadWindowHours: number | null;
}) => {
  const document = await seedCompletedDocument(owner, teamId, [signer], {
    createDocumentOptions: {
      title,
    },
  });

  const documentMeta = await prisma.documentMeta.findFirstOrThrow({
    where: {
      envelope: {
        id: document.id,
      },
    },
  });

  await prisma.envelope.update({
    where: {
      id: document.id,
    },
    data: {
      completedAt: new Date(Date.now() - completedHoursAgo * HOUR_IN_MS),
    },
  });

  await prisma.documentMeta.update({
    where: {
      id: documentMeta.id,
    },
    data: {
      downloadWindowHours,
    },
  });

  return document;
};

const selectDocument = async (page: Page, title: string) => {
  await page.locator('tr', { hasText: title }).getByRole('checkbox').click();
};

/**
 * The bulk action bar holds the download action for the selection. It is reached
 * through its clear selection button since the rows also render download actions.
 */
const openBulkDownloadDialog = async (page: Page) => {
  const bulkActionBar = page.getByLabel('Clear selection').locator('..');

  await expect(bulkActionBar).toBeVisible();

  await bulkActionBar.getByRole('button', { name: 'Download', exact: true }).click();

  await expect(page.getByRole('dialog')).toBeVisible();
};

test('[BULK_DOWNLOAD]: documents past their download window are marked as locked', async ({ page }) => {
  const { owner, team } = await seedTeam();
  const { user: signer } = await seedUser();

  await seedCompletedDocumentWithWindow({
    owner,
    signer,
    teamId: team.id,
    title: LOCKED_DOCUMENT_TITLE,
    completedHoursAgo: EXPIRED_WINDOW_HOURS + 1,
    downloadWindowHours: EXPIRED_WINDOW_HOURS,
  });

  // A manager outranks a member but holds no SGC download privileges, so the
  // expired window blocks every version of the document.
  const manager = await seedTeamMember({
    teamId: team.id,
    name: 'Bulk download manager',
    role: TeamMemberRole.MANAGER,
  });

  await apiSignin({
    page,
    email: manager.email,
    redirectPath: `/t/${team.url}/documents`,
  });

  await selectDocument(page, LOCKED_DOCUMENT_TITLE);

  await openBulkDownloadDialog(page);

  const dialog = page.getByRole('dialog');

  // The dialog explains why the document cannot be downloaded instead of
  // letting the download fail with a generic error.
  await expect(dialog.getByTestId('bulk-download-locked-alert')).toBeVisible();
  await expect(dialog.getByTestId('bulk-download-locked-document')).toHaveCount(1);
  await expect(dialog.getByText('The download window has expired')).toBeVisible();

  await expect(dialog.getByRole('button', { name: 'Download' })).toBeDisabled();
});

test('[BULK_DOWNLOAD]: documents past their download window are skipped and reported', async ({ page }) => {
  const { owner, team } = await seedTeam();
  const { user: signer } = await seedUser();

  const lockedDocument = await seedCompletedDocumentWithWindow({
    owner,
    signer,
    teamId: team.id,
    title: LOCKED_DOCUMENT_TITLE,
    completedHoursAgo: EXPIRED_WINDOW_HOURS + 1,
    downloadWindowHours: EXPIRED_WINDOW_HOURS,
  });

  const availableDocument = await seedCompletedDocumentWithWindow({
    owner,
    signer,
    teamId: team.id,
    title: '[TEST] Bulk download available document',
    completedHoursAgo: 1,
    downloadWindowHours: EXPIRED_WINDOW_HOURS,
  });

  const manager = await seedTeamMember({
    teamId: team.id,
    name: 'Bulk download partial manager',
    role: TeamMemberRole.MANAGER,
  });

  await apiSignin({
    page,
    email: manager.email,
    redirectPath: `/t/${team.url}/documents`,
  });

  await selectDocument(page, lockedDocument.title);
  await selectDocument(page, availableDocument.title);

  await openBulkDownloadDialog(page);

  const dialog = page.getByRole('dialog');

  await expect(dialog.getByTestId('bulk-download-locked-document')).toHaveCount(1);

  const downloadPromise = page.waitForEvent('download', { timeout: 15_000 });

  await dialog.getByRole('button', { name: 'Download' }).click();

  const download = await downloadPromise;
  const downloadPath = await download.path();

  const zipContents = unzipSync(new Uint8Array(fs.readFileSync(downloadPath)));

  // Only the document the window still covers reaches the zip.
  expect(Object.keys(zipContents)).toHaveLength(1);
  expect(Object.keys(zipContents)[0]).toContain(`${availableDocument.id}_`);

  await expectToastTextToBeVisible(page, 'Documents partially downloaded');
  await expectToastTextToBeVisible(page, '1 document was skipped because its download window has expired.');
});

test('[BULK_DOWNLOAD]: versions the policy blocks are not offered for a document', async ({ page }) => {
  const { owner, team } = await seedTeam();
  const { user: signer } = await seedUser();

  const document = await seedCompletedDocumentWithWindow({
    owner,
    signer,
    teamId: team.id,
    title: '[TEST] Bulk download partially locked document',
    completedHoursAgo: 1,
    downloadWindowHours: EXPIRED_WINDOW_HOURS,
  });

  const manager = await seedTeamMember({
    teamId: team.id,
    name: 'Bulk download signed only manager',
    role: TeamMemberRole.MANAGER,
  });

  await apiSignin({
    page,
    email: manager.email,
    redirectPath: `/t/${team.url}/documents`,
  });

  await selectDocument(page, document.title);

  await openBulkDownloadDialog(page);

  const dialog = page.getByRole('dialog');

  await expect(dialog.getByText(document.title)).toBeVisible();

  // The window is still open, so the signed copy stays available...
  await expect(dialog.getByRole('radio', { name: 'Signed' })).toBeVisible();

  // ...but the original of a completed document is limited to ADMIN and SGC, so
  // offering it would only produce a failed download.
  await expect(dialog.getByRole('radio', { name: 'Original' })).toHaveCount(0);

  await expect(dialog.getByTestId('bulk-download-locked-document')).toHaveCount(0);
});
