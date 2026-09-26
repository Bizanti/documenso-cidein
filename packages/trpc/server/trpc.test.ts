import { AppError, AppErrorCode, genericErrorCodeToTrpcErrorCodeMap } from '@documenso/lib/errors/app-error';
import { Role } from '@prisma/client';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import type { OpenApiRouter } from 'trpc-to-openapi';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { dataTransformer } from '../utils/data-transformer';
import { createOpenApiFetchHandler } from '../utils/openapi-fetch-handler';

import type { TrpcContext } from './context';
import {
  authenticatedProcedure,
  documentManagementProcedure,
  maybeAuthenticatedProcedure,
  procedure,
  router,
} from './trpc';

const mocks = vi.hoisted(() => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
    },
  },
  getApiTokenByToken: vi.fn(),
}));

vi.mock('@documenso/prisma', () => ({ prisma: mocks.prisma }));

vi.mock('@documenso/lib/server-only/public-api/get-api-token-by-token', () => ({
  getApiTokenByToken: mocks.getApiTokenByToken,
}));

const account = (roles: Role[]) => ({ roles });

const readEnvelopeFindHandler = vi.fn(() => 'envelope.find');

/**
 * A router mounted at the paths the guard decides on: a team scoped read, the
 * reads a signer still needs, and the signer flows.
 */
const testRouter = router({
  envelope: router({
    find: authenticatedProcedure.query(readEnvelopeFindHandler),
    get: authenticatedProcedure
      .meta({ openapi: { enabled: true, method: 'GET', path: '/envelope/{id}' } })
      .input(z.object({ id: z.string() }))
      .output(z.object({ ok: z.string() }))
      .query(() => ({ ok: 'envelope.get' })),
  }),
  document: router({
    find: authenticatedProcedure.query(() => 'document.find'),
    create: documentManagementProcedure.mutation(() => 'document.create'),
    inbox: router({
      // Marked as an API route so the API token branch can be exercised on an
      // allowed read as well as on a blocked one.
      find: authenticatedProcedure
        .meta({ openapi: { enabled: true, method: 'GET', path: '/document/inbox' } })
        .input(z.object({}))
        .output(z.object({ ok: z.string() }))
        .query(() => ({ ok: 'document.inbox.find' })),
    }),
  }),
  profile: router({
    findUserSecurityAuditLogs: authenticatedProcedure.query(() => 'profile.findUserSecurityAuditLogs'),
    updateProfile: authenticatedProcedure.mutation(() => 'profile.updateProfile'),
  }),
  team: router({
    email: router({
      get: authenticatedProcedure.query(() => 'team.email.get'),
    }),
  }),
  signing: router({
    status: procedure.query(() => 'signing.status'),
    completeWithToken: maybeAuthenticatedProcedure.mutation(() => 'signing.completeWithToken'),
  }),
});

const createLogger = () => {
  const logger = {
    child: () => logger,
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  };

  return logger;
};

const createSessionContext = ({ userId }: { userId: number }) =>
  ({
    logger: createLogger(),
    session: { id: 'session_1', userId, expires: new Date(Date.now() + 60_000), createdAt: new Date() },
    user: { id: userId, email: 'signer@example.com', name: 'Signer', roles: [Role.SIGN_ONLY], disabled: false },
    teamId: undefined,
    req: new Request('http://localhost/api/trpc'),
    res: new Response(),
    metadata: { requestMetadata: {}, source: 'app', auth: null },
  }) as unknown as TrpcContext;

const createApiContext = () =>
  ({
    logger: createLogger(),
    session: null,
    user: null,
    teamId: undefined,
    req: new Request('http://localhost/api/v2/envelope/env_1', {
      headers: { authorization: 'Bearer api_token' },
    }),
    res: new Response(),
    metadata: { requestMetadata: {}, source: 'apiV2', auth: null },
  }) as unknown as TrpcContext;

/**
 * The guard throws an `AppError` from inside the middleware, which tRPC wraps in
 * a `TRPCError` carrying it as the cause. That cause is what the shared error
 * formatter turns into `appError` plus `httpStatus: 403` on the wire.
 */
const expectForbidden = async (call: () => Promise<unknown>) => {
  try {
    await call();
    expect.unreachable('The call should have been rejected');
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause;

    expect(cause).toBeInstanceOf(AppError);
    expect((cause as AppError).code).toBe(AppErrorCode.FORBIDDEN);
    expect((cause as AppError).statusCode).toBe(403);
  }
};

const callAppQuery = ({ path, userId = 42 }: { path: string; userId?: number }) => {
  const input = encodeURIComponent(JSON.stringify(dataTransformer.serialize({})));

  return fetchRequestHandler({
    endpoint: '/api/trpc',
    router: testRouter,
    createContext: () => createSessionContext({ userId }),
    req: new Request(`http://localhost/api/trpc/${path}?input=${input}`),
  });
};

const callApiV2 = async (path: string) =>
  createOpenApiFetchHandler({
    endpoint: '/api/v2',
    router: testRouter as unknown as OpenApiRouter,
    createContext: async () => createApiContext(),
    req: new Request(`http://localhost/api/v2${path}`, {
      headers: { authorization: 'Bearer api_token' },
    }),
    onError: () => {},
    responseMeta: (opts) => {
      if (opts.errors[0]?.cause instanceof AppError) {
        const appError = AppError.parseError(opts.errors[0].cause);

        return { status: genericErrorCodeToTrpcErrorCodeMap[appError.code]?.status ?? 400 };
      }

      return {};
    },
  });

describe('authenticatedMiddleware read closure', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.prisma.user.findUnique.mockResolvedValue(account([Role.SIGN_ONLY]));
    mocks.getApiTokenByToken.mockResolvedValue({
      id: 'token_1',
      teamId: 1,
      team: { name: 'Team' },
      user: { id: 42, email: 'signer@example.com', name: 'Signer', roles: [Role.SIGN_ONLY], disabled: false },
    });
  });

  it('rejects the team scoped reads of a restricted account with a 403', async () => {
    const caller = testRouter.createCaller(createSessionContext({ userId: 42 }));

    await expectForbidden(() => caller.envelope.find());
    await expectForbidden(() => caller.document.find());

    // The handler is never reached, so a blocked read cannot leak by accident.
    expect(readEnvelopeFindHandler).not.toHaveBeenCalled();
  });

  it('keeps the reads the signer needs open', async () => {
    const caller = testRouter.createCaller(createSessionContext({ userId: 42 }));

    await expect(caller.document.inbox.find({})).resolves.toEqual({ ok: 'document.inbox.find' });
    await expect(caller.profile.findUserSecurityAuditLogs()).resolves.toBe('profile.findUserSecurityAuditLogs');
    await expect(caller.team.email.get()).resolves.toBe('team.email.get');
  });

  it('lets an unrestricted account read the team scoped reads', async () => {
    mocks.prisma.user.findUnique.mockResolvedValue(account([Role.USER]));

    const caller = testRouter.createCaller(createSessionContext({ userId: 42 }));

    await expect(caller.envelope.find()).resolves.toBe('envelope.find');
    await expect(caller.document.find()).resolves.toBe('document.find');
  });

  it('takes a role change into account on the next read, without a new session', async () => {
    const caller = testRouter.createCaller(createSessionContext({ userId: 42 }));

    mocks.prisma.user.findUnique.mockResolvedValueOnce(account([Role.USER]));
    await expect(caller.envelope.find()).resolves.toBe('envelope.find');

    // The same session: the roles are read fresh on every call.
    mocks.prisma.user.findUnique.mockResolvedValueOnce(account([Role.SIGN_ONLY]));
    await expectForbidden(() => caller.envelope.find());

    mocks.prisma.user.findUnique.mockResolvedValueOnce(account([Role.USER]));
    await expect(caller.envelope.find()).resolves.toBe('envelope.find');
  });

  it('keeps the write closure of a restricted account untouched', async () => {
    const caller = testRouter.createCaller(createSessionContext({ userId: 42 }));

    await expectForbidden(() => caller.document.create());
    await expect(caller.profile.updateProfile()).resolves.toBe('profile.updateProfile');
  });

  it('leaves the signer flows alone', async () => {
    const caller = testRouter.createCaller(createSessionContext({ userId: 42 }));

    await expect(caller.signing.status()).resolves.toBe('signing.status');
    await expect(caller.signing.completeWithToken()).resolves.toBe('signing.completeWithToken');
  });

  it('closes the reads of a restricted account reached with an API token', async () => {
    const caller = testRouter.createCaller(createApiContext());

    await expectForbidden(() => caller.envelope.get({ id: 'env_1' }));

    expect(mocks.getApiTokenByToken).toHaveBeenCalledWith({ token: 'api_token' });
    expect(mocks.prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 42 },
      select: { roles: true },
    });
  });

  it('keeps the allowed reads of a restricted account reached with an API token', async () => {
    const caller = testRouter.createCaller(createApiContext());

    await expect(caller.document.inbox.find({})).resolves.toEqual({ ok: 'document.inbox.find' });
  });

  it('lets an API token of an unrestricted account read the team scoped reads', async () => {
    mocks.getApiTokenByToken.mockResolvedValue({
      id: 'token_1',
      teamId: 1,
      team: { name: 'Team' },
      user: { id: 42, email: 'user@example.com', name: 'User', roles: [Role.USER], disabled: false },
    });
    mocks.prisma.user.findUnique.mockResolvedValue(account([Role.USER]));

    const caller = testRouter.createCaller(createApiContext());

    await expect(caller.envelope.get({ id: 'env_1' })).resolves.toEqual({ ok: 'envelope.get' });
  });
});

describe('authenticatedMiddleware over HTTP', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.prisma.user.findUnique.mockResolvedValue(account([Role.SIGN_ONLY]));
    mocks.getApiTokenByToken.mockResolvedValue({
      id: 'token_1',
      teamId: 1,
      team: { name: 'Team' },
      user: { id: 42, email: 'signer@example.com', name: 'Signer', roles: [Role.SIGN_ONLY], disabled: false },
    });
  });

  it('answers a blocked read of the app with a 403', async () => {
    const response = await callAppQuery({ path: 'envelope.find' });
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error.json.data.code).toBe('FORBIDDEN');
    expect(body.error.json.data.httpStatus).toBe(403);
    expect(body.error.json.data.appError.code).toBe('FORBIDDEN');
    expect(readEnvelopeFindHandler).not.toHaveBeenCalled();
  });

  it('answers an allowed read of the app with its data', async () => {
    const response = await callAppQuery({ path: 'document.inbox.find' });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(dataTransformer.deserialize(body.result.data)).toEqual({ ok: 'document.inbox.find' });
  });

  it('answers a blocked read of the API with a 403', async () => {
    const response = await callApiV2('/envelope/env_1');
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.data.code).toBe('FORBIDDEN');
    expect(body.data.httpStatus).toBe(403);
    expect(body.data.appError.code).toBe('FORBIDDEN');
  });

  it('answers a read the API is allowed to make', async () => {
    mocks.prisma.user.findUnique.mockResolvedValue(account([Role.USER]));

    const response = await callApiV2('/envelope/env_1');

    expect(response.status).toBe(200);
  });
});
