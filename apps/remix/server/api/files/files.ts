import { getOptionalSession } from '@documenso/auth/server/lib/utils/get-session';
import { APP_DOCUMENT_UPLOAD_SIZE_LIMIT } from '@documenso/lib/constants/app';
import { AppError } from '@documenso/lib/errors/app-error';
import { resolveAccountForAuthorization } from '@documenso/lib/server-only/auth/resolve-account-for-authorization';
import {
  canDownloadDocument,
  DOWNLOAD_DENIAL_MESSAGE,
  DOWNLOAD_DENIAL_REASON,
  getEnvelopeItemDownloadDenial,
  getRecipientDownloadPolicy,
  getUserDownloadPolicy,
} from '@documenso/lib/server-only/document/download-policy';
import { verifyEmbeddingPresignToken } from '@documenso/lib/server-only/embedding-presign/verify-embedding-presign-token';
import { putNormalizedPdfFileServerSide } from '@documenso/lib/universal/upload/put-file.server';
import { prisma } from '@documenso/prisma';
import { sValidator } from '@hono/standard-validator';
import type { Prisma } from '@prisma/client';
import { Hono } from 'hono';

import type { HonoEnv } from '../../router';
import {
  checkEnvelopeFileAccess,
  getFileTokenRecipient,
  handleEnvelopeItemFileRequest,
  isRoleRestrictedFromCompletedFile,
  resolveFileUploadUserId,
  shouldRestrictTokenFileAccess,
} from './files.helpers';
import {
  ZGetEnvelopeItemFileDownloadRequestParamsSchema,
  ZGetEnvelopeItemFileRequestParamsSchema,
  ZGetEnvelopeItemFileRequestQuerySchema,
  ZGetEnvelopeItemFileTokenDownloadRequestParamsSchema,
  ZGetEnvelopeItemFileTokenRequestParamsSchema,
  ZUploadPdfRequestSchema,
} from './files.types';
import getEnvelopeItemPdfRoute from './routes/get-envelope-item-pdf';
import getEnvelopeItemPdfByTokenRoute from './routes/get-envelope-item-pdf-by-token';

export const filesRoute = new Hono<HonoEnv>()
  /**
   * Uploads a document file to the appropriate storage location and creates
   * a document data record.
   */
  .post('/upload-pdf', sValidator('form', ZUploadPdfRequestSchema), async (c) => {
    try {
      const userId = await resolveFileUploadUserId(c);

      if (!userId) {
        return c.json({ error: 'Unauthorized' }, 401);
      }

      const { file } = c.req.valid('form');

      if (!file) {
        return c.json({ error: 'No file provided' }, 400);
      }

      // Todo: (RR7) This is new.
      // Add file size validation.
      // Convert MB to bytes (1 MB = 1024 * 1024 bytes)
      const MAX_FILE_SIZE = APP_DOCUMENT_UPLOAD_SIZE_LIMIT * 1024 * 1024;

      if (file.size > MAX_FILE_SIZE) {
        return c.json({ error: 'File too large' }, 400);
      }

      const result = await putNormalizedPdfFileServerSide(file);

      return c.json(result);
    } catch (error) {
      console.error('Upload failed:', error);
      return c.json({ error: 'Upload failed' }, 500);
    }
  })
  .get(
    '/envelope/:envelopeId/envelopeItem/:envelopeItemId',
    sValidator('param', ZGetEnvelopeItemFileRequestParamsSchema),
    sValidator('query', ZGetEnvelopeItemFileRequestQuerySchema),
    async (c) => {
      const { envelopeId, envelopeItemId } = c.req.valid('param');
      const { token } = c.req.query();

      const session = await getOptionalSession(c);

      let userId = session.user?.id;

      if (token) {
        const presignToken = await verifyEmbeddingPresignToken({
          token,
        }).catch(() => undefined);

        userId = presignToken?.userId;
      }

      if (!userId) {
        return c.json({ error: 'Unauthorized' }, 401);
      }

      const envelope = await prisma.envelope.findFirst({
        where: {
          id: envelopeId,
        },
        include: {
          documentMeta: {
            select: {
              downloadWindowHours: true,
            },
          },
          envelopeItems: {
            where: {
              id: envelopeItemId,
            },
            include: {
              documentData: true,
            },
          },
        },
      });

      if (!envelope) {
        return c.json({ error: 'Envelope not found' }, 404);
      }

      const [envelopeItem] = envelope.envelopeItems;

      if (!envelopeItem) {
        return c.json({ error: 'Envelope item not found' }, 404);
      }

      const hasAccess = await checkEnvelopeFileAccess({
        userId,
        teamId: envelope.teamId,
        envelopeType: envelope.type,
        templateType: envelope.templateType,
      });

      if (!hasAccess) {
        return c.json({ error: 'User does not have access to the team that this envelope is associated with' }, 403);
      }

      // The viewer hands out the same stored bytes as the download routes, so it
      // answers to the same policy.
      const downloadPolicy = await getUserDownloadPolicy({
        userId,
        teamId: envelope.teamId,
        status: envelope.status,
        completedAt: envelope.completedAt,
        downloadWindowHours: envelope.documentMeta?.downloadWindowHours,
      });

      const viewDenial = getEnvelopeItemDownloadDenial({
        version: 'signed',
        policy: downloadPolicy,
      });

      if (viewDenial) {
        return c.json({ error: DOWNLOAD_DENIAL_MESSAGE[viewDenial], code: viewDenial }, 403);
      }

      if (!envelopeItem.documentData) {
        return c.json({ error: 'Document data not found' }, 404);
      }

      return await handleEnvelopeItemFileRequest({
        title: envelopeItem.title,
        status: envelope.status,
        documentData: envelopeItem.documentData,
        version: 'signed',
        isDownload: false,
        context: c,
      });
    },
  )
  .get(
    '/envelope/:envelopeId/envelopeItem/:envelopeItemId/download/:version?',
    sValidator('param', ZGetEnvelopeItemFileDownloadRequestParamsSchema),
    async (c) => {
      const logger = c.get('logger');

      try {
        const { envelopeId, envelopeItemId, version } = c.req.valid('param');

        const session = await getOptionalSession(c);

        if (!session.user) {
          return c.json({ error: 'Unauthorized' }, 401);
        }

        const envelope = await prisma.envelope.findFirst({
          where: {
            id: envelopeId,
          },
          include: {
            envelopeItems: {
              where: {
                id: envelopeItemId,
              },
              include: {
                documentData: true,
              },
            },
            recipients: {
              select: {
                role: true,
                signingStatus: true,
              },
            },
            documentMeta: {
              select: {
                downloadWindowHours: true,
              },
            },
          },
        });

        if (!envelope) {
          return c.json({ error: 'Envelope not found' }, 404);
        }

        const [envelopeItem] = envelope.envelopeItems;

        if (!envelopeItem) {
          return c.json({ error: 'Envelope item not found' }, 404);
        }

        const hasDownloadAccess = await checkEnvelopeFileAccess({
          userId: session.user.id,
          teamId: envelope.teamId,
          envelopeType: envelope.type,
          templateType: envelope.templateType,
        });

        if (!hasDownloadAccess) {
          return c.json(
            {
              error: 'User does not have access to the team that this envelope is associated with',
            },
            403,
          );
        }

        const downloadPolicy = await getUserDownloadPolicy({
          userId: session.user.id,
          teamId: envelope.teamId,
          status: envelope.status,
          completedAt: envelope.completedAt,
          downloadWindowHours: envelope.documentMeta?.downloadWindowHours,
        });

        const downloadDenial = getEnvelopeItemDownloadDenial({
          version,
          policy: downloadPolicy,
        });

        if (downloadDenial) {
          return c.json({ error: DOWNLOAD_DENIAL_MESSAGE[downloadDenial], code: downloadDenial }, 403);
        }

        if (!envelopeItem.documentData) {
          return c.json({ error: 'Document data not found' }, 404);
        }

        const baseOptions = {
          title: envelopeItem.title,
          documentData: envelopeItem.documentData,
          isDownload: true,
          context: c,
        } as const;

        if (version === 'pending') {
          return await handleEnvelopeItemFileRequest({
            ...baseOptions,
            version,
            envelopeItemId: envelopeItem.id,
            envelope,
          });
        }

        return await handleEnvelopeItemFileRequest({
          ...baseOptions,
          version,
          status: envelope.status,
        });
      } catch (error) {
        logger.error(error);

        if (error instanceof AppError) {
          const { status, body } = AppError.toRestAPIError(error);

          return c.json({ error: body.message, code: error.code }, status);
        }

        return c.json({ error: 'Internal server error' }, 500);
      }
    },
  )
  .get(
    '/token/:token/envelopeItem/:envelopeItemId',
    sValidator('param', ZGetEnvelopeItemFileTokenRequestParamsSchema),
    async (c) => {
      const { token, envelopeItemId } = c.req.valid('param');

      let envelopeWhereQuery: Prisma.EnvelopeItemWhereUniqueInput = {
        id: envelopeItemId,
        envelope: {
          recipients: {
            some: {
              token,
            },
          },
        },
      };

      if (token.startsWith('qr_')) {
        envelopeWhereQuery = {
          id: envelopeItemId,
          envelope: {
            qrToken: token,
          },
        };
      }

      const envelopeItem = await prisma.envelopeItem.findUnique({
        where: envelopeWhereQuery,
        include: {
          envelope: {
            include: {
              documentMeta: {
                select: {
                  downloadWindowHours: true,
                },
              },
            },
          },
          documentData: true,
        },
      });

      if (!envelopeItem) {
        return c.json({ error: 'Envelope item not found' }, 404);
      }

      // Controlled signers may view the document while signing, but not the
      // final document once the envelope is completed or rejected.
      const isViewRestricted = await shouldRestrictTokenFileAccess({
        token,
        envelopeId: envelopeItem.envelopeId,
        status: envelopeItem.envelope.status,
      });

      if (isViewRestricted) {
        return c.json({ error: 'Controlled signers are not permitted to access the final document' }, 403);
      }

      // The viewer hands out the same stored bytes as the download routes, so it
      // answers to the same policy. Recipients never hold team privileges.
      const downloadPolicy = await getRecipientDownloadPolicy({
        status: envelopeItem.envelope.status,
        completedAt: envelopeItem.envelope.completedAt,
        downloadWindowHours: envelopeItem.envelope.documentMeta?.downloadWindowHours,
      });

      const viewDenial = getEnvelopeItemDownloadDenial({
        version: 'signed',
        policy: downloadPolicy,
      });

      if (viewDenial) {
        return c.json({ error: DOWNLOAD_DENIAL_MESSAGE[viewDenial], code: viewDenial }, 403);
      }

      if (!envelopeItem.documentData) {
        return c.json({ error: 'Document data not found' }, 404);
      }

      return await handleEnvelopeItemFileRequest({
        title: envelopeItem.title,
        status: envelopeItem.envelope.status,
        documentData: envelopeItem.documentData,
        version: 'signed',
        isDownload: false,
        context: c,
      });
    },
  )
  .get(
    '/token/:token/envelopeItem/:envelopeItemId/download/:version?',
    sValidator('param', ZGetEnvelopeItemFileTokenDownloadRequestParamsSchema),
    async (c) => {
      const { token, envelopeItemId, version } = c.req.valid('param');

      let envelopeWhereQuery: Prisma.EnvelopeItemWhereUniqueInput = {
        id: envelopeItemId,
        envelope: {
          recipients: {
            some: {
              token,
            },
          },
        },
      };

      if (token.startsWith('qr_')) {
        envelopeWhereQuery = {
          id: envelopeItemId,
          envelope: {
            qrToken: token,
          },
        };
      }

      const envelopeItem = await prisma.envelopeItem.findUnique({
        where: envelopeWhereQuery,
        include: {
          envelope: {
            include: {
              documentMeta: {
                select: {
                  downloadWindowHours: true,
                },
              },
            },
          },
          documentData: true,
        },
      });

      if (!envelopeItem) {
        return c.json({ error: 'Envelope item not found' }, 404);
      }

      const recipient = await getFileTokenRecipient(token, envelopeItem.envelopeId);

      if (recipient && isRoleRestrictedFromCompletedFile(recipient.role)) {
        return c.json({ error: 'Controlled signers are not permitted to download this document' }, 403);
      }

      // A token hands the document to the recipient's address, so the account
      // behind it decides as well: a restricted account receives no copy, however
      // it reaches the document. An address with no account is an external
      // recipient, ruled by its recipient role alone, and a lookup which cannot be
      // completed throws rather than handing out the file.
      const recipientAccount = recipient ? await resolveAccountForAuthorization(recipient.email) : null;

      if (!canDownloadDocument({ account: recipientAccount ? { roles: recipientAccount.roles } : null })) {
        return c.json(
          {
            error: DOWNLOAD_DENIAL_MESSAGE[DOWNLOAD_DENIAL_REASON.ACCOUNT_DOWNLOAD_FORBIDDEN],
            code: DOWNLOAD_DENIAL_REASON.ACCOUNT_DOWNLOAD_FORBIDDEN,
          },
          403,
        );
      }

      const downloadPolicy = await getRecipientDownloadPolicy({
        status: envelopeItem.envelope.status,
        completedAt: envelopeItem.envelope.completedAt,
        downloadWindowHours: envelopeItem.envelope.documentMeta?.downloadWindowHours,
      });

      const downloadDenial = getEnvelopeItemDownloadDenial({
        version,
        policy: downloadPolicy,
      });

      if (downloadDenial) {
        return c.json({ error: DOWNLOAD_DENIAL_MESSAGE[downloadDenial], code: downloadDenial }, 403);
      }

      if (!envelopeItem.documentData) {
        return c.json({ error: 'Document data not found' }, 404);
      }

      return await handleEnvelopeItemFileRequest({
        title: envelopeItem.title,
        status: envelopeItem.envelope.status,
        documentData: envelopeItem.documentData,
        version,
        isDownload: true,
        context: c,
      });
    },
  );

// PDF routes for both tokens and auth based
// Is different to the other file endpoints since it uses documentDataId for hard caching.
filesRoute.route('/', getEnvelopeItemPdfRoute);
filesRoute.route('/', getEnvelopeItemPdfByTokenRoute);
