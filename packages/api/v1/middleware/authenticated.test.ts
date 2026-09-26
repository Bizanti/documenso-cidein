import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import type { TsRestRequest } from '@ts-rest/serverless';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { authenticatedMiddleware } from './authenticated';

const mocks = vi.hoisted(() => ({
  getApiTokenByToken: vi.fn(),
  assertCanManageDocumentsById: vi.fn(),
  logger: {
    child: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock('@documenso/lib/server-only/public-api/get-api-token-by-token', () => ({
  getApiTokenByToken: mocks.getApiTokenByToken,
}));

vi.mock('@documenso/lib/server-only/auth/document-authorization', () => ({
  assertCanManageDocumentsById: mocks.assertCanManageDocumentsById,
}));

vi.mock('@documenso/lib/utils/logger', () => ({ logger: mocks.logger }));

const apiToken = {
  id: 'api_token_1',
  userId: 1,
  teamId: 1,
  user: {
    id: 1,
    email: 'signer@example.com',
    name: 'Signer',
    disabled: false,
  },
  team: {
    id: 1,
    name: 'Team',
    url: 'team',
  },
};

const callMiddleware = async ({
  method,
  handler,
}: {
  method: string;
  handler: () => Promise<{ status: number; body: unknown }>;
}) => {
  const wrapped = authenticatedMiddleware(async () => await handler());

  return await wrapped(
    { headers: { authorization: 'Bearer api_token_1' } },
    {
      request: new Request('https://example.com/api/v1/documents', {
        method,
        headers: {
          authorization: 'Bearer api_token_1',
        },
      }) as unknown as TsRestRequest,
      responseHeaders: new Headers(),
    },
  );
};

describe('api v1 authenticatedMiddleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.logger.child.mockReturnValue(mocks.logger);
    mocks.getApiTokenByToken.mockResolvedValue(apiToken);
    mocks.assertCanManageDocumentsById.mockResolvedValue(undefined);
  });

  it('answers 403 - not 401 - when the account is not allowed to write', async () => {
    mocks.assertCanManageDocumentsById.mockRejectedValue(
      new AppError(AppErrorCode.FORBIDDEN, {
        message: 'This account is restricted to signing documents which have been shared with it.',
        statusCode: 403,
      }),
    );

    const handler = vi.fn(async () => ({ status: 200, body: { ok: true } }));

    const response = await callMiddleware({ method: 'POST', handler });

    expect(response).toEqual({
      status: 403,
      body: {
        message: 'This account is restricted to signing documents which have been shared with it.',
      },
    });

    // The write never reached the route.
    expect(handler).not.toHaveBeenCalled();
  });

  it('keeps the closure off the read routes', async () => {
    const response = await callMiddleware({
      method: 'GET',
      handler: async () => ({ status: 200, body: { ok: true } }),
    });

    expect(response.status).toBe(200);
    expect(mocks.assertCanManageDocumentsById).not.toHaveBeenCalled();
  });

  it('checks the account on every write, with the roles read fresh from the database', async () => {
    const response = await callMiddleware({
      method: 'POST',
      handler: async () => ({ status: 200, body: { ok: true } }),
    });

    expect(response.status).toBe(200);
    expect(mocks.assertCanManageDocumentsById).toHaveBeenCalledWith({ userId: apiToken.user.id });
  });

  it('keeps the other failures as they were', async () => {
    mocks.getApiTokenByToken.mockRejectedValue(
      new AppError(AppErrorCode.UNAUTHORIZED, {
        message: 'Invalid API token',
      }),
    );

    const response = await callMiddleware({ method: 'POST', handler: async () => ({ status: 200, body: {} }) });

    expect(response).toEqual({
      status: 401,
      body: { message: 'Invalid API token' },
    });
  });

  it('answers 429 for a rate limited request', async () => {
    mocks.getApiTokenByToken.mockRejectedValue(
      new AppError(AppErrorCode.TOO_MANY_REQUESTS, {
        message: 'Rate limit exceeded',
        headers: { 'retry-after': '60' },
      }),
    );

    const response = await callMiddleware({ method: 'POST', handler: async () => ({ status: 200, body: {} }) });

    expect(response).toEqual({
      status: 429,
      body: { message: 'Rate limit exceeded' },
      headers: { 'retry-after': '60' },
    });
  });
});
