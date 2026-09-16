import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { mapSecondaryIdToDocumentId } from '@documenso/lib/utils/envelope';
import { prisma } from '@documenso/prisma';
import { seedPendingDocument } from '@documenso/prisma/seed/documents';
import { seedUser } from '@documenso/prisma/seed/users';
import { type APIRequestContext, expect, test } from '@playwright/test';
import { DocumentStatus, RecipientRole } from '@prisma/client';

import { apiSignin } from '../../fixtures/authentication';

const WEBAPP_BASE_URL = NEXT_PUBLIC_WEBAPP_URL();

test.describe.configure({
  mode: 'parallel',
});

const viewUrl = (token: string, envelopeItemId: string) =>
  `${WEBAPP_BASE_URL}/api/files/token/${token}/envelopeItem/${envelopeItemId}`;

const downloadUrl = (token: string, envelopeItemId: string, version: 'original' | 'signed') =>
  `${WEBAPP_BASE_URL}/api/files/token/${token}/envelopeItem/${envelopeItemId}/download/${version}`;

const itemPdfUrl = (
  token: string,
  envelopeId: string,
  envelopeItemId: string,
  documentDataId: string,
  version: 'initial' | 'current',
) =>
  `${WEBAPP_BASE_URL}/api/files/token/${token}/envelope/${envelopeId}/envelopeItem/${envelopeItemId}/dataId/${documentDataId}/${version}/item.pdf`;

const seedDocumentWithControlledSigner = async () => {
  const owner = await seedUser();
  const { user: controlledSignerUser } = await seedUser();
  const { user: regularSignerUser } = await seedUser();

  const envelope = await seedPendingDocument(owner.user, owner.team.id, [controlledSignerUser, regularSignerUser], {
    createDocumentOptions: { title: 'Controlled Signer File Access Test' },
  });

  const controlledRecipient = envelope.recipients.find((recipient) => recipient.email === controlledSignerUser.email);
  const regularRecipient = envelope.recipients.find((recipient) => recipient.email === regularSignerUser.email);

  if (!controlledRecipient || !regularRecipient) {
    throw new Error('Failed to seed recipients');
  }

  await prisma.recipient.update({
    where: { id: controlledRecipient.id },
    data: { role: RecipientRole.CONTROLLED_SIGNER },
  });

  return {
    owner,
    envelope,
    envelopeItem: envelope.envelopeItems[0],
    controlledRecipient,
    regularRecipient,
  };
};

const setEnvelopeStatus = async (envelopeId: string, status: DocumentStatus) => {
  await prisma.envelope.update({
    where: { id: envelopeId },
    data: {
      status,
      completedAt: status === DocumentStatus.COMPLETED ? new Date() : null,
    },
  });
};

test.describe('Controlled signer file access', () => {
  test('allows a controlled signer to view the document while it is pending', async ({ request }) => {
    const { envelope, envelopeItem, controlledRecipient } = await seedDocumentWithControlledSigner();

    const viewRes = await request.get(viewUrl(controlledRecipient.token, envelopeItem.id));
    expect(viewRes.status()).toBe(200);

    const itemPdfRes = await request.get(
      itemPdfUrl(controlledRecipient.token, envelope.id, envelopeItem.id, envelopeItem.documentData.id, 'current'),
    );
    expect(itemPdfRes.status()).toBe(200);
  });

  test('rejects controlled signer downloads while the document is pending', async ({ request }) => {
    const { envelopeItem, controlledRecipient } = await seedDocumentWithControlledSigner();

    const res = await request.get(downloadUrl(controlledRecipient.token, envelopeItem.id, 'signed'));

    expect(res.status()).toBe(403);
  });

  test('rejects controlled signer access to the final document once completed', async ({ request }) => {
    const { envelope, envelopeItem, controlledRecipient } = await seedDocumentWithControlledSigner();

    await setEnvelopeStatus(envelope.id, DocumentStatus.COMPLETED);

    const viewRes = await request.get(viewUrl(controlledRecipient.token, envelopeItem.id));
    expect(viewRes.status()).toBe(403);

    const itemPdfRes = await request.get(
      itemPdfUrl(controlledRecipient.token, envelope.id, envelopeItem.id, envelopeItem.documentData.id, 'current'),
    );
    expect(itemPdfRes.status()).toBe(403);

    const downloadRes = await request.get(downloadUrl(controlledRecipient.token, envelopeItem.id, 'signed'));
    expect(downloadRes.status()).toBe(403);

    // The original unsigned document remains accessible.
    const initialRes = await request.get(
      itemPdfUrl(controlledRecipient.token, envelope.id, envelopeItem.id, envelopeItem.documentData.id, 'initial'),
    );
    expect(initialRes.status()).toBe(200);
  });

  test('rejects controlled signer access to the final document once rejected', async ({ request }) => {
    const { envelope, envelopeItem, controlledRecipient } = await seedDocumentWithControlledSigner();

    await setEnvelopeStatus(envelope.id, DocumentStatus.REJECTED);

    const viewRes = await request.get(viewUrl(controlledRecipient.token, envelopeItem.id));
    expect(viewRes.status()).toBe(403);

    const itemPdfRes = await request.get(
      itemPdfUrl(controlledRecipient.token, envelope.id, envelopeItem.id, envelopeItem.documentData.id, 'current'),
    );
    expect(itemPdfRes.status()).toBe(403);

    const downloadRes = await request.get(downloadUrl(controlledRecipient.token, envelopeItem.id, 'signed'));
    expect(downloadRes.status()).toBe(403);
  });

  test('still allows a regular signer to access the completed document', async ({ request }) => {
    const { envelope, envelopeItem, regularRecipient } = await seedDocumentWithControlledSigner();

    await setEnvelopeStatus(envelope.id, DocumentStatus.COMPLETED);

    const viewRes = await request.get(viewUrl(regularRecipient.token, envelopeItem.id));
    expect(viewRes.status()).toBe(200);

    const downloadRes = await request.get(downloadUrl(regularRecipient.token, envelopeItem.id, 'signed'));
    expect(downloadRes.status()).toBe(200);
  });
});

test.describe('Controlled signer share links', () => {
  const callShareDocument = (request: APIRequestContext, input: { documentId: number; token?: string }) => {
    return request.post(`${WEBAPP_BASE_URL}/api/trpc/document.share`, {
      headers: { 'content-type': 'application/json' },
      data: JSON.stringify({ json: input }),
    });
  };

  test('rejects share link creation with a controlled signer token', async ({ request }) => {
    const { envelope, controlledRecipient } = await seedDocumentWithControlledSigner();

    const res = await callShareDocument(request, {
      documentId: mapSecondaryIdToDocumentId(envelope.secondaryId),
      token: controlledRecipient.token,
    });

    expect(res.status()).toBe(403);
  });

  test('allows share link creation with a regular signer token', async ({ request }) => {
    const { envelope, regularRecipient } = await seedDocumentWithControlledSigner();

    const res = await callShareDocument(request, {
      documentId: mapSecondaryIdToDocumentId(envelope.secondaryId),
      token: regularRecipient.token,
    });

    expect(res.status()).toBe(200);
  });

  test('allows share link creation for a team member session without a recipient token', async ({ page }) => {
    const { owner, envelope } = await seedDocumentWithControlledSigner();

    await apiSignin({ page, email: owner.user.email });

    const res = await callShareDocument(page.context().request, {
      documentId: mapSecondaryIdToDocumentId(envelope.secondaryId),
    });

    expect(res.status()).toBe(200);
  });
});
