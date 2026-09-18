import {
  DOWNLOAD_DENIAL_MESSAGE,
  getEnvelopeItemViewDenial,
  getRecipientDownloadPolicy,
} from '@documenso/lib/server-only/document/download-policy';
import { prisma } from '@documenso/prisma';
import { sValidator } from '@hono/standard-validator';
import type { Prisma } from '@prisma/client';
import { Hono } from 'hono';
import { z } from 'zod';

import type { HonoEnv } from '../../../router';
import { shouldRestrictTokenFileAccess } from '../files.helpers';
import { handleEnvelopeItemPdfRequest } from './get-envelope-item-pdf';

const route = new Hono<HonoEnv>();

const ZGetEnvelopeItemByTokenParamsSchema = z.object({
  token: z.string().min(1),
  envelopeId: z.string().min(1),
  envelopeItemId: z.string().min(1),
  documentDataId: z.string().min(1),
  version: z.enum(['initial', 'current']),
});

/**
 * Returns a PDF file for an envelope item using a token.
 */
route.get(
  '/token/:token/envelope/:envelopeId/envelopeItem/:envelopeItemId/dataId/:documentDataId/:version/item.pdf',
  sValidator('param', ZGetEnvelopeItemByTokenParamsSchema),
  async (c) => {
    const { token, envelopeId, envelopeItemId, documentDataId, version } = c.req.valid('param');

    if (!token) {
      return c.json({ error: 'Not found' }, 404);
    }

    // Recipient token based query.
    let envelopeItemWhereQuery: Prisma.EnvelopeItemWhereInput = {
      id: envelopeItemId,
      documentDataId,
      envelope: {
        id: envelopeId,
        recipients: {
          some: {
            token,
          },
        },
      },
    };

    // QR token based query.
    if (token.startsWith('qr_')) {
      envelopeItemWhereQuery = {
        id: envelopeItemId,
        documentDataId,
        envelope: {
          id: envelopeId,
          qrToken: token,
        },
      };
    }

    // Validate envelope access.
    const envelopeItem = await prisma.envelopeItem.findFirst({
      where: envelopeItemWhereQuery,
      include: {
        documentData: true,
        envelope: {
          select: {
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

    const { status, completedAt, documentMeta } = envelopeItem.envelope;

    // Controlled signers may view the document while signing, but not the
    // final document once the envelope is completed or rejected.
    const isRestricted = await shouldRestrictTokenFileAccess({
      token,
      envelopeId,
      status,
    });

    if (isRestricted) {
      return c.json({ error: 'Controlled signers are not permitted to access the final document' }, 403);
    }

    // The viewer hands out the same stored bytes as the download routes, so it
    // answers to the same policy. Recipients never hold team privileges.
    const downloadPolicy = await getRecipientDownloadPolicy({
      status,
      completedAt,
      downloadWindowHours: documentMeta?.downloadWindowHours,
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
      status,
    });
  },
);

export default route;
