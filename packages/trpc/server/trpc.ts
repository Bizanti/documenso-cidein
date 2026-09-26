import { AppError, genericErrorCodeToTrpcErrorCodeMap } from '@documenso/lib/errors/app-error';
import {
  assertCanManageDocumentsById,
  isDocumentManagementProcedurePath,
} from '@documenso/lib/server-only/auth/document-authorization';
import { getApiTokenByToken } from '@documenso/lib/server-only/public-api/get-api-token-by-token';
import { assertUserNotDisabled } from '@documenso/lib/server-only/user/assert-user-not-disabled';
import type { TrpcApiLog } from '@documenso/lib/types/api-logs';
import type { ApiRequestMetadata } from '@documenso/lib/universal/extract-request-metadata';
import { alphaid } from '@documenso/lib/universal/id';
import { isAdmin } from '@documenso/lib/utils/is-admin';
import type { ProcedureType } from '@trpc/server';
import { initTRPC, TRPCError } from '@trpc/server';
import type { AnyZodObject } from 'zod';

import { dataTransformer } from '../utils/data-transformer';
import type { TrpcContext } from './context';
import {
  assertRestrictedAccountCanReadById,
  isRestrictedAccountAllowedToReadProcedurePath,
} from './restricted-account-read-policy';

// Can't import type from trpc-to-openapi because it breaks build, not sure why.
export type TrpcRouteMeta = {
  openapi?: {
    enabled?: boolean;
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
    path: `/${string}`;
    summary?: string;
    description?: string;
    protect?: boolean;
    tags?: string[];
    // eslint-disable-next-line @typescript-eslint/ban-types
    contentTypes?: ('application/json' | 'application/x-www-form-urlencoded' | (string & {}))[];
    deprecated?: boolean;
    requestHeaders?: AnyZodObject;
    responseHeaders?: AnyZodObject;
    successDescription?: string;
    errorResponses?: number[] | Record<number, string>;
  };
} & Record<string, unknown>;

const t = initTRPC
  .meta<TrpcRouteMeta>()
  .context<TrpcContext>()
  .create({
    transformer: dataTransformer,
    errorFormatter(opts) {
      const { shape, error, ctx } = opts;

      const originalError = error.cause;

      let data: Record<string, unknown> = shape.data;

      // Default unknown errors to 400, since if you're throwing an AppError it is expected
      // that you already know what you're doing.
      if (originalError instanceof AppError) {
        if (originalError.headers && ctx) {
          for (const [headerKey, headerValue] of Object.entries(originalError.headers)) {
            ctx.res.headers.append(headerKey, headerValue);
          }
        }

        data = {
          ...data,
          appError: AppError.toJSON(originalError),
          code: originalError.code,
          httpStatus: originalError.statusCode ?? genericErrorCodeToTrpcErrorCodeMap[originalError.code]?.status ?? 400,
        };
      }

      return {
        ...shape,
        data,
      };
    },
  });

/**
 * Middlewares
 */

/**
 * Refuse the procedures a restricted account has no business reaching.
 *
 * A sign only account is limited to signing the documents shared with it, so
 * both sides of the surface it could otherwise reach are closed here:
 *
 * - every write outside the self service prefixes, so a restricted account
 *   cannot manage documents, teams, organisations, tokens or webhooks;
 * - every read outside the signer allowlist in
 *   `restricted-account-read-policy.ts`, so the team and organisation surfaces
 *   cannot be listed or opened either. A 403 is returned rather than an empty
 *   list, because "you may not read this" must not be mistaken for "there is
 *   nothing to read".
 *
 * The decision is taken per request and the roles are read fresh from the
 * database rather than reused from the session or the API token the request came
 * with. That is what makes a role change take effect on the very next request
 * instead of surviving inside a long lived session.
 *
 * The signer flows are untouched: `procedure` and `maybeAuthenticatedProcedure`
 * are not covered, because signing a field, completing with a recipient token
 * and accepting an invitation are things a restricted account must keep doing.
 */
const assertRestrictedAccountCannotReachProcedure = async ({
  userId,
  type,
  path,
}: {
  userId: number;
  type: ProcedureType;
  path: string;
}) => {
  if (type === 'mutation') {
    if (isDocumentManagementProcedurePath(path)) {
      await assertCanManageDocumentsById({ userId });
    }

    return;
  }

  if (type === 'query' && !isRestrictedAccountAllowedToReadProcedurePath(path)) {
    await assertRestrictedAccountCanReadById({ userId });
  }
};

export const authenticatedMiddleware = t.middleware(async ({ ctx, next, path, meta, type }) => {
  // Auth-independent log bindings. `auth` is set per-branch below since it
  // depends on which auth path was taken; `ctx.metadata.auth` here is still
  // `null` (the resolved value is set in the `next()` call below).
  const baseLogAttributes: TrpcApiLog = {
    path,
    auth: null,
    source: ctx.metadata.source,
    trpcMiddleware: 'authenticated',
    unverifiedTeamId: ctx.teamId,
  };

  const authorizationHeader = ctx.req.headers.get('authorization');

  const isApiV2 = Boolean(meta?.openapi?.path);

  // Taken from `authenticatedMiddleware` in `@documenso/api/v1/middleware/authenticated.ts`.
  if (authorizationHeader && isApiV2) {
    // Support for both "Authorization: Bearer api_xxx" and "Authorization: api_xxx"
    const [token] = (authorizationHeader || '').split('Bearer ').filter((s) => s.length > 0);

    if (!token) {
      throw new Error('Token was not provided for authenticated middleware');
    }

    const apiToken = await getApiTokenByToken({ token });

    // Reject API requests from a disabled account. The token may still be
    // present in the DB (e.g. before `disableUser` runs) so we enforce here.
    assertUserNotDisabled(apiToken.user);

    // An API token acts as the account it belongs to, so the closure applies to
    // the API surface exactly as it does to the session one.
    await assertRestrictedAccountCannotReachProcedure({ userId: apiToken.user.id, type, path });

    const trpcApiV2Logger = ctx.logger.child({
      ...baseLogAttributes,
      auth: 'api',
      userId: apiToken.user.id,
      apiTokenId: apiToken.id,
    } satisfies TrpcApiLog);

    trpcApiV2Logger.info({
      position: 'trpcProcedure',
    });

    return await next({
      ctx: {
        ...ctx,
        logger: trpcApiV2Logger,
        user: apiToken.user,
        teamId: apiToken.teamId,
        session: null,
        metadata: {
          ...ctx.metadata,
          auditUser: apiToken.team
            ? {
                id: null,
                email: null,
                name: apiToken.team.name,
              }
            : {
                id: apiToken.user.id,
                email: apiToken.user.email,
                name: apiToken.user.name,
              },
          auth: 'api',
        } satisfies ApiRequestMetadata,
      },
    });
  }

  if (!ctx.session) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'Invalid session or API token.',
    });
  }

  // Reject session requests from a disabled account. The session may still be
  // valid (sessions aren't invalidated by `disableUser`), so we gate every
  // authenticated TRPC call here.
  assertUserNotDisabled(ctx.user);

  // Close every write and every non signer read for a restricted account, reading
  // its roles fresh from the database instead of trusting the ones the session was
  // created with.
  await assertRestrictedAccountCannotReachProcedure({ userId: ctx.user.id, type, path });

  // Recreate the logger with a sub request ID to differentiate between batched
  // requests, as well as identifying attributes so every subsequent log line
  // (including errors) inherits them.
  const trpcSessionLogger = ctx.logger.child({
    ...baseLogAttributes,
    auth: 'session',
    nonBatchedRequestId: alphaid(),
    userId: ctx.user.id,
    apiTokenId: null,
  } satisfies TrpcApiLog);

  trpcSessionLogger.info({
    position: 'trpcProcedure',
  });

  return await next({
    ctx: {
      ...ctx,
      teamId: ctx.teamId || -1,
      logger: trpcSessionLogger,
      user: ctx.user,
      session: ctx.session,
      metadata: {
        ...ctx.metadata,
        auditUser: {
          id: ctx.user.id,
          name: ctx.user.name,
          email: ctx.user.email,
        },
        auth: 'session',
      } satisfies ApiRequestMetadata,
    },
  });
});

export const maybeAuthenticatedMiddleware = t.middleware(async ({ ctx, next, path, meta }) => {
  const baseLogAttributes: TrpcApiLog = {
    path,
    auth: null,
    source: ctx.metadata.source,
    trpcMiddleware: 'maybeAuthenticated',
    unverifiedTeamId: ctx.teamId,
  };

  const authorizationHeader = ctx.req.headers.get('authorization');

  const isApiV2 = Boolean(meta?.openapi?.path);

  // Taken from `authenticatedMiddleware` in `@documenso/api/v1/middleware/authenticated.ts`.
  if (authorizationHeader && isApiV2) {
    // Support for both "Authorization: Bearer api_xxx" and "Authorization: api_xxx"
    const [token] = (authorizationHeader || '').split('Bearer ').filter((s) => s.length > 0);

    if (!token) {
      throw new Error('Token was not provided for authenticated middleware');
    }

    const apiToken = await getApiTokenByToken({ token });

    // Reject API requests from a disabled account. Presenting an API token is
    // an explicit attempt to act under that account, so we don't downgrade to
    // anonymous here — we reject.
    assertUserNotDisabled(apiToken.user);

    // Attach identifying attributes to the logger so every subsequent log line
    // within this request (including errors) inherits them.
    const trpcApiV2Logger = ctx.logger.child({
      ...baseLogAttributes,
      auth: 'api',
      userId: apiToken.user.id,
      apiTokenId: apiToken.id,
    } satisfies TrpcApiLog);

    trpcApiV2Logger.info({
      position: 'trpcProcedure',
    });

    return await next({
      ctx: {
        ...ctx,
        logger: trpcApiV2Logger,
        user: apiToken.user,
        teamId: apiToken.teamId,
        session: null,
        metadata: {
          ...ctx.metadata,
          auditUser: apiToken.team
            ? {
                id: null,
                email: null,
                name: apiToken.team.name,
              }
            : {
                id: apiToken.user.id,
                email: apiToken.user.email,
                name: apiToken.user.name,
              },
          auth: 'api',
        } satisfies ApiRequestMetadata,
      },
    });
  }

  // Treat a disabled session as anonymous. Most routes wired through
  // `maybeAuthenticatedProcedure` are signer/invite flows that key off an
  // input token rather than `ctx.user`, so downgrading lets those keep
  // working while routes that genuinely need an account naturally fall
  // through to their own auth checks.
  const sessionUser = ctx.user && !ctx.user.disabled ? ctx.user : null;
  const sessionRecord = sessionUser ? ctx.session : null;

  // Resolve `auth` once so it stays in sync between the logger bindings and
  // the outgoing metadata.
  const auth = sessionRecord ? 'session' : null;

  // Recreate the logger with a sub request ID to differentiate between batched
  // requests, as well as identifying attributes so every subsequent log line
  // (including errors) inherits them.
  const trpcSessionLogger = ctx.logger.child({
    ...baseLogAttributes,
    auth,
    nonBatchedRequestId: alphaid(),
    userId: sessionUser?.id,
    apiTokenId: null,
  } satisfies TrpcApiLog);

  trpcSessionLogger.info({
    position: 'trpcProcedure',
  });

  return await next({
    ctx: {
      ...ctx,
      logger: trpcSessionLogger,
      user: sessionUser,
      session: sessionRecord,
      metadata: {
        ...ctx.metadata,
        auditUser: sessionUser
          ? {
              id: sessionUser.id,
              name: sessionUser.name,
              email: sessionUser.email,
            }
          : undefined,
        auth,
      } satisfies ApiRequestMetadata,
    },
  });
});

export const adminMiddleware = t.middleware(async ({ ctx, next, path }) => {
  if (!ctx.session || !ctx.user) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'You must be logged in to perform this action.',
    });
  }

  // Disabled admins shouldn't be able to do anything either.
  assertUserNotDisabled(ctx.user);

  // An administrator whose roles are not a valid combination - for instance one
  // which also carries the sign only role - is a restricted account, and a
  // restricted account does not reach the admin surface at all. ADMIN on its own
  // is a valid combination and passes.
  await assertCanManageDocumentsById({ userId: ctx.user.id });

  const isUserAdmin = isAdmin(ctx.user);

  if (!isUserAdmin) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'Not authorized to perform this action.',
    });
  }

  // Recreate the logger with a sub request ID to differentiate between batched
  // requests, as well as identifying attributes so every subsequent log line
  // (including errors) inherits them.
  const trpcSessionLogger = ctx.logger.child({
    nonBatchedRequestId: alphaid(),
    unverifiedTeamId: ctx.teamId,
    path,
    auth: 'session',
    source: ctx.metadata.source,
    userId: ctx.user.id,
    apiTokenId: null,
    trpcMiddleware: 'admin',
  } satisfies TrpcApiLog);

  trpcSessionLogger.info({
    position: 'trpcProcedure',
  });

  return await next({
    ctx: {
      ...ctx,
      logger: trpcSessionLogger,
      user: ctx.user,
      session: ctx.session,
      metadata: {
        ...ctx.metadata,
        auditUser: {
          id: ctx.user.id,
          name: ctx.user.name,
          email: ctx.user.email,
        },
        auth: 'session',
      } satisfies ApiRequestMetadata,
    },
  });
});

export const procedureMiddleware = t.middleware(async ({ ctx, next, path }) => {
  // Recreate the logger with a sub request ID to differentiate between batched
  // requests, as well as identifying attributes so every subsequent log line
  // (including errors) inherits them.
  const trpcSessionLogger = ctx.logger.child({
    nonBatchedRequestId: alphaid(),
    unverifiedTeamId: ctx.teamId,
    path,
    auth: ctx.metadata.auth,
    source: ctx.metadata.source,
    userId: ctx.user?.id,
    apiTokenId: null,
    trpcMiddleware: 'procedure',
  } satisfies TrpcApiLog);

  trpcSessionLogger.info({
    position: 'trpcProcedure',
  });

  return await next({
    ctx: {
      ...ctx,
      logger: trpcSessionLogger,
    },
  });
});

/**
 * Routers and Procedures
 */
export const router = t.router;
export const procedure = t.procedure.use(procedureMiddleware);
export const authenticatedProcedure = t.procedure.use(authenticatedMiddleware);
// While this is functionally the same as `procedure`, it's useful for indicating purpose
export const maybeAuthenticatedProcedure = t.procedure.use(maybeAuthenticatedMiddleware);
export const adminProcedure = t.procedure.use(adminMiddleware);

/**
 * An `authenticatedProcedure` which also refuses restricted (sign only) accounts
 * with a 403.
 *
 * `authenticatedMiddleware` already applies the closure to every write which is
 * not self service; mounting it here marks the routes where the closure is part
 * of the route's contract, and keeps them closed even if a caller reaches the
 * handler through a chain that skips the shared middleware.
 *
 * Use it for every route that creates, modifies or deletes documents, folders,
 * recipients, teams, organisations, API tokens or webhooks.
 */
export const documentManagementProcedure = t.procedure.use(authenticatedMiddleware).use(async ({ ctx, next }) => {
  await assertCanManageDocumentsById({ userId: ctx.user.id });

  return await next();
});
