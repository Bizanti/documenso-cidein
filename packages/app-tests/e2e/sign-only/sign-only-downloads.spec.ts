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
 * - E5b (covered): the transition the rule exists for. A full account signs a
 *   document and is restricted to the sign only profile once the document is
 *   sealed and before the completion email job has sent anything, so the
 *   message is resolved on the restricted profile at send time and arrives
 *   without the document. The window is held by an advisory lock the job waits
 *   on, keyed by the envelope; see the test.
 * - G2 (covered): an addressee without an account is ruled by its recipient role
 *   alone, so an external signer may still receive and download the document.
 */

import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { canAttachDocumentPdfToAddressee } from '@documenso/lib/server-only/document/document-attachment-policy';
import { canDownloadDocument } from '@documenso/lib/server-only/document/download-policy';
import { mapSecondaryIdToDocumentId } from '@documenso/lib/utils/envelope';
import { prisma } from '@documenso/prisma';
import { getDatabaseUrl } from '@documenso/prisma/helper';
import { seedCompletedDocument, seedPendingDocument } from '@documenso/prisma/seed/documents';
import { seedTestEmail, seedUser } from '@documenso/prisma/seed/users';
import { expect, type Page, test } from '@playwright/test';
import { DocumentStatus, FieldType, PrismaClient, RecipientRole, Role, TeamMemberRole } from '@prisma/client';

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
import { signEnvelopeSignatureField } from '../fixtures/signature';

test.use({ storageState: { cookies: [], origins: [] } });

test.describe.configure({ mode: 'parallel' });

/**
 * Inbucket (the test mail server `npm run dx:up` starts) exposes its HTTP API on
 * port 9000, the endpoint `e2e/emails-branding.spec.ts` and
 * `e2e/documents/resend-signed-document.spec.ts` already read.
 */
const INBUCKET_URL = 'http://localhost:9000';

/**
 * The subject of the completion email, the translated `Signing Complete!` of
 * `send-document-completed-emails.handler` which the English catalogue serves
 * verbatim. It is what tells the completion message apart from the signing
 * request sitting in the same mailbox.
 */
const COMPLETION_EMAIL_SUBJECT = 'Signing Complete!';

/**
 * The job which sends the completion email once a document is sealed. E5b reads
 * its rows to know that the send was queued while the account was still a full
 * account.
 */
const COMPLETION_EMAIL_JOB_ID = 'send.document.completed.emails';

type InbucketMessage = {
  id: string;
  subject?: string;
  to?: string[];
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

/**
 * The messages of the mailbox which are the completion email addressed to
 * `email`.
 *
 * Selected by subject and addressee, not by "a message which happens to carry no
 * PDF": the mailbox also holds the signing request, and a message without an
 * attachment proves nothing on its own.
 */
const getCompletionMessages = async (email: string) => {
  const normalizedEmail = email.toLowerCase();

  const messages = await getMailboxMessages(email);

  return messages.filter(
    (message) =>
      message.subject === COMPLETION_EMAIL_SUBJECT &&
      (message.to ?? []).some((addressee) => addressee.toLowerCase().includes(normalizedEmail)),
  );
};

/**
 * The audit log entries which record the send of the completion email to
 * `email`, with the time each one was written. They are what ties the message
 * read from the mailbox to the send this scenario is about.
 */
const getCompletionEmailAuditLogs = async (envelopeId: string, email: string) => {
  const auditLogs = await prisma.documentAuditLog.findMany({
    where: {
      envelopeId,
      type: 'EMAIL_SENT',
      data: {
        path: ['emailType'],
        equals: 'DOCUMENT_COMPLETED',
      },
    },
    select: {
      data: true,
      createdAt: true,
    },
  });

  return auditLogs.filter((auditLog) => (auditLog.data as { recipientEmail?: string }).recipientEmail === email);
};

/** The MIME parts a message carries, as the test mail server parses them. */
const getMessageParts = async (email: string, messageId: string) => {
  const mailbox = email.split('@')[0];

  const response = await fetch(`${INBUCKET_URL}/api/v1/mailbox/${mailbox}/${messageId}`);

  // The body is read once: reading it in the assertion message below would
  // consume it and leave nothing for the parse, since `fetch` hands out a body
  // only once.
  const body = await response.text();

  expect(response.ok, `could not read message ${messageId}: ${body}`).toBe(true);

  const details = JSON.parse(body) as { attachments?: InbucketMessagePart[] };

  return details.attachments ?? [];
};

/** The raw SMTP source of a message, where an attached PDF shows up as a part. */
const getMessageSource = async (email: string, messageId: string) => {
  const mailbox = email.split('@')[0];

  const response = await fetch(`${INBUCKET_URL}/api/v1/mailbox/${mailbox}/${messageId}/source`);

  expect(response.ok, `could not read the source of message ${messageId}`).toBe(true);

  return await response.text();
};

/**
 * The pause which holds the completion email job of `envelopeId` back, taken on
 * the advisory lock that job waits on. The app side lives in
 * `packages/lib/jobs/definitions/emails/e2e-completion-email-pause.ts`: both
 * sides derive the key with `hashtext(<envelope id>)::bigint`, so the pause is
 * per document and never global, and the two have to change together.
 *
 * An advisory session lock belongs to the connection which took it, so it is
 * taken on a client pinned to a single connection: the pooled client the rest of
 * the suite uses could hand the unlock a different connection and leave the lock
 * behind for the rest of the run. Closing the client releases it as well, which
 * is the safety net for a test which fails while holding it.
 */
const holdCompletionEmailPause = async (envelopeId: string) => {
  const databaseUrl = getDatabaseUrl();

  if (!databaseUrl) {
    throw new Error('No database URL is configured, so the completion email pause cannot be taken');
  }

  const pauseUrl = new URL(databaseUrl);
  pauseUrl.searchParams.set('connection_limit', '1');
  pauseUrl.searchParams.set('pool_timeout', '30');

  const client = new PrismaClient({ datasourceUrl: pauseUrl.toString() });

  const [{ paused }] = await client.$queryRaw<{ paused: boolean }[]>`
    SELECT pg_try_advisory_lock(hashtext(${envelopeId})::bigint) AS paused
  `;

  expect(paused, `the completion email pause of ${envelopeId} was already held by another connection`).toBe(true);

  /**
   * How many backends are waiting on the lock of this document. The job of the
   * scenario shows up here as a waiter while the pause is held, which is what
   * tells a stalled send from one which resolved its policy before the
   * restriction was written: `pg_locks` reports the advisory lock of a bigint
   * key as `classid`/`objid` (the high and the low 32 bits) with `objsubid` 1.
   */
  const countWaiters = async () => {
    const [{ waiters }] = await prisma.$queryRaw<{ waiters: number }[]>`
      SELECT count(*)::int AS waiters
      FROM pg_locks
      WHERE locktype = 'advisory'
        AND NOT granted
        AND objsubid = 1
        AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
        AND classid::bigint = ((hashtext(${envelopeId})::bigint >> 32) & 4294967295)
        AND objid::bigint = (hashtext(${envelopeId})::bigint & 4294967295)
    `;

    return waiters;
  };

  let isReleased = false;

  /** Let the job continue, on the profile which is committed by now. */
  const release = async () => {
    if (isReleased) {
      return;
    }

    isReleased = true;

    try {
      const [{ unlocked }] = await client.$queryRaw<{ unlocked: boolean }[]>`
        SELECT pg_advisory_unlock(hashtext(${envelopeId})::bigint) AS unlocked
      `;

      expect(unlocked, 'the completion email pause was not held by the connection which released it').toBe(true);
    } finally {
      await client.$disconnect();
    }
  };

  return { countWaiters, release };
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
  const signatureField = envelope.fields.find((field) => field.type === FieldType.SIGNATURE);

  if (!recipient || !signatureField) {
    throw new Error('The distribution did not hand out a signing token and a signature field');
  }

  // The restricted account signs for real: that is what completes the document
  // and makes the completion email go out through the transport.
  await apiSignin({ page, email: signOnlyUser.email, redirectPath: '/' });

  await page.goto(`/sign/${recipient.token}`);
  await signEnvelopeSignatureField(page, signatureField);

  await page.getByRole('button', { name: 'Complete' }).click();
  await expect(page.getByRole('heading', { name: 'Are you sure?' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign' }).click();

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
    .poll(async () => (await getCompletionEmailAuditLogs(envelope.id, signOnlyUser.email)).length, { timeout: 30_000 })
    .toBeGreaterThan(0);

  // The message the assertion is about is the completion email addressed to the
  // restricted account, selected by subject and addressee: a message without a
  // PDF is not evidence on its own, and the mailbox also holds the signing
  // request. The completion email has to withhold the document because the
  // addressee cannot download it. Asserted against the parsed parts and the raw
  // source, so an inline logo is allowed but a PDF part is not.
  await expect(async () => {
    const completionMessages = await getCompletionMessages(signOnlyUser.email);

    expect(completionMessages.length).toBeGreaterThan(0);

    for (const message of completionMessages) {
      const parts = await getMessageParts(signOnlyUser.email, message.id);

      const documentPart = parts.find((part) => part['content-type'] === 'application/pdf');

      expect(
        documentPart,
        `completion message ${message.id} carried the document as ${documentPart?.filename}`,
      ).toBeUndefined();

      const source = await getMessageSource(signOnlyUser.email, message.id);

      expect(source, `completion message ${message.id} attached a PDF part`).not.toContain('application/pdf');
    }
  }).toPass({ timeout: 30_000, intervals: [1000, 2000, 5000] });
});

test('E5b: an account restricted once the document is sealed receives the completion email without the document', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);

  // The send this test looks at is a job of its own document, and every job row
  // it reads was created after it started: that is what keeps the lookups off
  // the rows of the tests running in parallel.
  const testStartedAt = new Date();

  // A full account, not a restricted one: it signs the document while it still
  // carries the whole profile and is only restricted afterwards, which is the
  // transition the send-time rule exists for.
  const { user: signer } = await seedUser({ name: 'E5b Transition Signer' });

  const { envelope, distributeResult } = await apiSeedPendingDocument(request, {
    title: '[TEST] E5b restricted after sealing',
    recipients: [{ email: signer.email, name: 'E5b Transition Signer', role: 'SIGNER' }],
  });

  const recipient = distributeResult.recipients[0];
  const signatureField = envelope.fields.find((field) => field.type === FieldType.SIGNATURE);

  if (!recipient || !signatureField) {
    throw new Error('The distribution did not hand out a signing token and a signature field');
  }

  const getSendJobs = async () => {
    const sendJobs = await prisma.backgroundJob.findMany({
      where: {
        jobId: COMPLETION_EMAIL_JOB_ID,
        submittedAt: {
          gte: testStartedAt,
        },
      },
      orderBy: {
        submittedAt: 'asc',
      },
      select: {
        payload: true,
        submittedAt: true,
      },
    });

    return sendJobs.filter((job) => (job.payload as { envelopeId?: string } | null)?.envelopeId === envelope.id);
  };

  // The pause of this document, taken before the signature is completed: the
  // completion email job waits on it from its first statement, so it cannot
  // resolve anything until the test releases it below.
  const pause = await holdCompletionEmailPause(envelope.id);

  try {
    await apiSignin({ page, email: signer.email, redirectPath: '/' });

    await page.goto(`/sign/${recipient.token}`);
    await signEnvelopeSignatureField(page, signatureField);

    // Signing completes the document and triggers the seal, which enqueues the
    // completion email further down. The account is a full account here.
    await page.getByRole('button', { name: 'Complete' }).click();
    await expect(page.getByRole('heading', { name: 'Are you sure?' })).toBeVisible();
    await page.getByRole('button', { name: 'Sign' }).click();

    await page.waitForURL(`/sign/${recipient.token}/complete`);

    // 1. The document is sealed. The seal commits the seal before it enqueues the
    //    send, so the account is still a full account at this point.
    await expect
      .poll(
        async () => {
          const sealed = await prisma.envelope.findFirstOrThrow({
            where: {
              id: envelope.id,
            },
            select: {
              status: true,
            },
          });

          return sealed.status;
        },
        { timeout: 30_000 },
      )
      .toBe(DocumentStatus.COMPLETED);

    // 2. The send was queued while the account was still a full account. Checked
    //    before the restriction is written, so a send which was never queued fails
    //    here instead of passing on nothing.
    await expect
      .poll(async () => (await getSendJobs()).length, { timeout: 30_000, intervals: [25, 50, 100, 250, 500] })
      .toBeGreaterThan(0);

    // 3. The job is paused on the lock of this document, waiting for this test:
    //    `pg_locks` reports its request as a waiter. Checked, not assumed, because
    //    the pause is what makes the order deterministic - without it the send
    //    could resolve the policy before the restriction is committed and the
    //    scenario would pass for the wrong reason.
    await expect
      .poll(async () => await pause.countWaiters(), {
        timeout: 30_000,
        intervals: [25, 50, 100, 250, 500],
        message: `the completion email job never waited on the lock of ${envelope.id}: the app running this suite needs E2E_PAUSE_COMPLETION_EMAIL=true (see packages/lib/jobs/definitions/emails/e2e-completion-email-pause.ts)`,
      })
      .toBeGreaterThan(0);

    // 4. The account is restricted and the write read back, so the release below
    //    can only let the job continue on the restricted profile.
    await prisma.user.update({
      where: {
        id: signer.id,
      },
      data: {
        roles: [Role.SIGN_ONLY],
      },
    });

    const restrictedAccount = await prisma.user.findFirstOrThrow({
      where: {
        id: signer.id,
      },
      select: {
        roles: true,
        updatedAt: true,
      },
    });

    expect(restrictedAccount.roles).toEqual([Role.SIGN_ONLY]);

    await pause.release();

    // The document was sealed while the account was still a full account, and the
    // restriction was committed after the seal.
    const sealedEnvelope = await prisma.envelope.findFirstOrThrow({
      where: {
        id: envelope.id,
      },
      select: {
        completedAt: true,
      },
    });

    expect(sealedEnvelope.completedAt, 'the seal never completed').not.toBeNull();
    expect(sealedEnvelope.completedAt?.getTime()).toBeLessThan(restrictedAccount.updatedAt.getTime());

    // The send of the completion email only got past the pause once the release
    // above let it, and every send queued for this document was queued while the
    // account was still a full account.
    const queuedSends = await getSendJobs();

    for (const sendJob of queuedSends) {
      expect(sendJob.submittedAt.getTime()).toBeLessThanOrEqual(restrictedAccount.updatedAt.getTime());
    }

    // The message goes out from the job the seal enqueued, so wait until the send
    // of the completion email addressed to the account is on the audit log before
    // reading the mailbox: the assertions below must run against that message.
    await expect
      .poll(async () => (await getCompletionEmailAuditLogs(envelope.id, signer.email)).length, { timeout: 30_000 })
      .toBeGreaterThan(0);

    // Every recorded send of the completion email to that address happened after
    // the restriction was committed.
    const completionEmailAuditLogs = await getCompletionEmailAuditLogs(envelope.id, signer.email);

    for (const auditLog of completionEmailAuditLogs) {
      expect(auditLog.createdAt.getTime()).toBeGreaterThan(restrictedAccount.updatedAt.getTime());
    }

    // The send resolved the addressee's policy at send time, on the profile which
    // was committed when the pause was released, so the completion email which
    // went out after the restriction carries no document. The mailbox holds the
    // signing request as well, so the message under test is the one selected by
    // subject and addressee.
    await expect(async () => {
      const mailboxMessages = await getMailboxMessages(signer.email);
      const completionMessages = await getCompletionMessages(signer.email);

      expect(mailboxMessages.length, 'the mailbox holds the signing request too').toBeGreaterThan(1);
      expect(completionMessages.length).toBeGreaterThan(0);

      for (const message of completionMessages) {
        const parts = await getMessageParts(signer.email, message.id);

        const documentPart = parts.find((part) => part['content-type'] === 'application/pdf');

        expect(
          documentPart,
          `completion message ${message.id} carried the document as ${documentPart?.filename}`,
        ).toBeUndefined();

        const source = await getMessageSource(signer.email, message.id);

        expect(source, `completion message ${message.id} attached a PDF part`).not.toContain('application/pdf');
      }
    }).toPass({ timeout: 30_000, intervals: [1000, 2000, 5000] });
  } finally {
    // The pause is released on the way into the mailbox assertions above, so this
    // is the safety net: a run which fails while holding it still lets the app go
    // on instead of leaving the lock held for the rest of the suite.
    await pause.release();
  }
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
