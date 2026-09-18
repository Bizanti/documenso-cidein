import { getOptionalSession } from '@documenso/auth/server/lib/utils/get-session';
import {
  DOWNLOAD_DENIAL_MESSAGE,
  getEnvelopeItemViewDenial,
  getUserDownloadPolicy,
  isFinalDocumentStatus,
} from '@documenso/lib/server-only/document/download-policy';
import { verifyEmbeddingPresignToken } from '@documenso/lib/server-only/embedding-presign/verify-embedding-presign-token';
import type { DocumentDataVersion } from '@documenso/lib/types/document';
import { sha256 } from '@documenso/lib/universal/crypto';
import { getFileServerSide } from '@documenso/lib/universal/upload/get-file.server';
import { prisma } from '@documenso/prisma';
import { sValidator } from '@hono/standard-validator';
import type { DocumentData, DocumentStatus, EnvelopeItem } from '@prisma/client';
import { type Context, Hono } from 'hono';
import { z } from 'zod';

import type { HonoEnv } from '../../../router';
import { checkEnvelopeFileAccess } from '../files.helpers';

const route = new Hono<HonoEnv>();

const ZGetEnvelopeItemPdfRequestParamsSchema = z.object({
  envelopeId: z.string().min(1),
  envelopeItemId: z.string().min(1),
  documentDataId: z.string().min(1),
  version: z.enum(['initial', 'current']),
});

const ZGetEnvelopeItemPdfRequestQuerySchema = z.object({
  presignToken: z.string().optional(),
});

/**
 * Returns a PDF file for an envelope item.
 */
route.get(
  '/envelope/:envelopeId/envelopeItem/:envelopeItemId/dataId/:documentDataId/:version/item.pdf',
  sValidator('param', ZGetEnvelopeItemPdfRequestParamsSchema),
  sValidator('query', ZGetEnvelopeItemPdfRequestQuerySchema),
  async (c) => {
    const { envelopeId, envelopeItemId, documentDataId, version } = c.req.valid('param');

    const { presignToken } = c.req.valid('query');

    const session = await getOptionalSession(c);

    let userId = session.user?.id;

    // Check presignToken if provided
    if (presignToken) {
      const verifiedToken = await verifyEmbeddingPresignToken({
        token: presignToken,
      }).catch(() => undefined);

      userId = verifiedToken?.userId;
    }

    if (!userId) {
      return c.json({ error: 'Not found' }, 404);
    }

    // Note: We authenticate whether the user can access this in the `getTeamById` below.
    const envelopeItem = await prisma.envelopeItem.findFirst({
      where: {
        id: envelopeItemId,
        envelopeId,
        documentDataId,
      },
      include: {
        documentData: true,
        envelope: {
          select: {
            id: true,
            type: true,
            teamId: true,
            templateType: true,
            status: true,
            completedAt: true,
            documentMeta: {
              select: {
                downloadWindowHours: true,
              },
            },
          },
        },
      },
    });

    if (!envelopeItem) {
      return c.json({ error: 'Not found' }, 404);
    }

    // Check whether the user has access to the document.
    const hasAccess = await checkEnvelopeFileAccess({
      userId,
      teamId: envelopeItem.envelope.teamId,
      envelopeType: envelopeItem.envelope.type,
      templateType: envelopeItem.envelope.templateType,
    });

    if (!hasAccess) {
      return c.json({ error: 'Not found' }, 404);
    }

    // The viewer hands out the same stored bytes as the download routes, so it
    // answers to the same policy.
    const downloadPolicy = await getUserDownloadPolicy({
      userId,
      teamId: envelopeItem.envelope.teamId,
      status: envelopeItem.envelope.status,
      completedAt: envelopeItem.envelope.completedAt,
      downloadWindowHours: envelopeItem.envelope.documentMeta?.downloadWindowHours,
    });

    const viewDenial = getEnvelopeItemViewDenial({
      version,
      policy: downloadPolicy,
    });

    if (viewDenial) {
      return c.json({ error: DOWNLOAD_DENIAL_MESSAGE[viewDenial], code: viewDenial }, 403);
    }

    return await handleEnvelopeItemPdfRequest({
      c,
      envelopeItem,
      version,
      status: envelopeItem.envelope.status,
    });
  },
);

type HandleEnvelopeItemPdfRequestOptions = {
  c: Context<HonoEnv>;
  envelopeItem: EnvelopeItem & {
    documentData: DocumentData;
  };
  version: DocumentDataVersion;

  /**
   * The status of the envelope the item belongs to, which decides how long the
   * response may be cached.
   */
  status: DocumentStatus;
};

export const handleEnvelopeItemPdfRequest = async ({
  c,
  envelopeItem,
  version,
  status,
}: HandleEnvelopeItemPdfRequestOptions) => {
  // Determine which PDF data to use based on version requested.
  const documentDataToUse =
    version === 'current' ? envelopeItem.documentData.data : envelopeItem.documentData.initialData;

  const etag = Buffer.from(sha256(documentDataToUse)).toString('hex');

  if (c.req.header('If-None-Match') === etag) {
    return c.status(304);
  }

  const file = await getFileServerSide({
    type: envelopeItem.documentData.type,
    data: documentDataToUse,
  }).catch((error) => {
    console.error(error);

    return null;
  });

  if (!file) {
    return c.json({ error: 'Not found' }, 404);
  }

  // Note: Only set these headers on success.
  c.header('Content-Type', 'application/pdf');
  c.header('ETag', etag);

  // While the envelope is in flight the item is content addressed by
  // `documentDataId` and no policy limits who may read it, so the URL can be
  // cached for as long as it stays valid.
  //
  // Once the envelope is final the served version is policy governed: the
  // original is limited to ADMIN/SGC and the signed copy to the download
  // window, so no cache may outlive the policy.
  c.header(
    'Cache-Control',
    isFinalDocumentStatus(status) ? 'no-store, private' : 'private, max-age=31536000, immutable',
  );

  return c.body(file);
};

export default route;
