import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { Role } from '@prisma/client';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { dataTransformer } from '../../utils/data-transformer';
import type { TrpcContext } from '../context';
import { router } from '../trpc';
import { profileRouter } from './router';

const mocks = vi.hoisted(() => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
    },
  },
  setAvatarImage: vi.fn(),
}));

vi.mock('@documenso/prisma', () => ({ prisma: mocks.prisma }));

vi.mock('@documenso/lib/server-only/profile/set-avatar-image', () => ({
  setAvatarImage: mocks.setAvatarImage,
}));

const bytes = 'iVBORw0KGgo=';

/**
 * Mounted the way `appRouter` mounts it, because the shared write closure
 * decides on the whole procedure path: it is the `profile.` prefix which exempts
 * this route from that closure, and the guard under test is what closes the team
 * and organisation targets inside it.
 */
const testRouter = router({
  profile: profileRouter,
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

/**
 * The roles on `user` are the session's, which for a restricted account may be
 * stale; the roles the guard decides on come from the database mock instead.
 */
const createContext = ({ userId = 42, roles = [Role.SIGN_ONLY] }: { userId?: number; roles?: Role[] } = {}) =>
  ({
    logger: createLogger(),
    session: { id: 'session_1', userId, expires: new Date(Date.now() + 60_000), createdAt: new Date() },
    user: { id: userId, email: 'signer@example.com', name: 'Signer', roles, avatarImageId: null, disabled: false },
    teamId: undefined,
    req: new Request('http://localhost/api/trpc'),
    res: new Response(),
    metadata: { requestMetadata: {}, source: 'app', auth: null },
  }) as unknown as TrpcContext;

const caller = (options?: { userId?: number; roles?: Role[] }) => testRouter.createCaller(createContext(options));

const account = (roles: Role[]) => ({ roles });

/**
 * The guard throws an `AppError` from inside the route, which tRPC wraps in a
 * `TRPCError` carrying it as the cause. That cause is what the shared error
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

describe('profile.setProfileImage avatar targets', () => {
  beforeEach(() => {
    vi.resetAllMocks();

    mocks.setAvatarImage.mockResolvedValue('avatar_1');
  });

  it('refuses a team avatar for a restricted account with a 403, before the service is reached', async () => {
    mocks.prisma.user.findUnique.mockResolvedValue(account([Role.SIGN_ONLY]));

    await expectForbidden(() => caller().profile.setProfileImage({ bytes, teamId: 1, organisationId: null }));

    expect(mocks.setAvatarImage).not.toHaveBeenCalled();
    expect(mocks.prisma.user.findUnique).toHaveBeenCalledWith({ where: { id: 42 }, select: { roles: true } });
  });

  it('refuses an organisation avatar for a restricted account with a 403, before the service is reached', async () => {
    mocks.prisma.user.findUnique.mockResolvedValue(account([Role.SIGN_ONLY]));

    await expectForbidden(() => caller().profile.setProfileImage({ bytes, teamId: null, organisationId: 'org_1' }));

    expect(mocks.setAvatarImage).not.toHaveBeenCalled();
  });

  it('refuses a shared avatar when a restricted account only carries the sign only role in the database', async () => {
    // The session still describes an unrestricted account: the roles the guard
    // reads are the fresh ones, so the stale session does not open the route.
    mocks.prisma.user.findUnique.mockResolvedValue(account([Role.SIGN_ONLY]));

    await expectForbidden(() =>
      caller({ roles: [Role.USER] }).profile.setProfileImage({ bytes, teamId: 1, organisationId: null }),
    );

    expect(mocks.setAvatarImage).not.toHaveBeenCalled();
  });

  it('treats an invalid role combination as restricted for a shared avatar', async () => {
    mocks.prisma.user.findUnique.mockResolvedValue(account([Role.USER, Role.SIGN_ONLY]));

    await expectForbidden(() =>
      caller({ roles: [Role.USER] }).profile.setProfileImage({ bytes, teamId: null, organisationId: 'org_1' }),
    );

    expect(mocks.setAvatarImage).not.toHaveBeenCalled();
  });

  it('refuses an unknown account for a shared avatar', async () => {
    mocks.prisma.user.findUnique.mockResolvedValue(null);

    await expectForbidden(() => caller().profile.setProfileImage({ bytes, teamId: 1, organisationId: null }));

    expect(mocks.setAvatarImage).not.toHaveBeenCalled();
  });

  it('keeps the account avatar of a restricted account, and reads no roles for it', async () => {
    mocks.prisma.user.findUnique.mockResolvedValue(account([Role.SIGN_ONLY]));

    await expect(caller().profile.setProfileImage({ bytes, teamId: null, organisationId: null })).resolves.toBe(
      'avatar_1',
    );

    expect(mocks.setAvatarImage).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 42,
        target: { type: 'user' },
        bytes,
      }),
    );

    // The account's own avatar is self service: the guard stays out of it.
    expect(mocks.prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('keeps the removal of the account avatar of a restricted account allowed', async () => {
    mocks.prisma.user.findUnique.mockResolvedValue(account([Role.SIGN_ONLY]));

    await expect(
      caller().profile.setProfileImage({ bytes: null, teamId: null, organisationId: null }),
    ).resolves.toBe('avatar_1');

    expect(mocks.setAvatarImage).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 42,
        target: { type: 'user' },
        bytes: null,
      }),
    );
  });

  it('keeps the removal of a team avatar of a restricted account refused', async () => {
    mocks.prisma.user.findUnique.mockResolvedValue(account([Role.SIGN_ONLY]));

    await expectForbidden(() => caller().profile.setProfileImage({ bytes: null, teamId: 1, organisationId: null }));

    expect(mocks.setAvatarImage).not.toHaveBeenCalled();
  });

  it('leaves a team avatar of an unrestricted account to the membership check of the service', async () => {
    mocks.prisma.user.findUnique.mockResolvedValue(account([Role.USER]));

    await expect(caller().profile.setProfileImage({ bytes, teamId: 7, organisationId: null })).resolves.toBe(
      'avatar_1',
    );

    expect(mocks.setAvatarImage).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 42,
        target: { type: 'team', teamId: 7 },
        bytes,
      }),
    );
  });

  it('leaves an organisation avatar of an unrestricted account to the membership check of the service', async () => {
    mocks.prisma.user.findUnique.mockResolvedValue(account([Role.USER, Role.ADMIN]));

    await expect(
      caller().profile.setProfileImage({ bytes, teamId: null, organisationId: 'org_1' }),
    ).resolves.toBe('avatar_1');

    expect(mocks.setAvatarImage).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 42,
        target: { type: 'organisation', organisationId: 'org_1' },
        bytes,
      }),
    );
  });
});

describe('profile.setProfileImage over HTTP', () => {
  const call = (input: { bytes: string | null; teamId: number | null; organisationId: string | null }) =>
    fetchRequestHandler({
      endpoint: '/api/trpc',
      router: testRouter,
      createContext: () => createContext(),
      req: new Request('http://localhost/api/trpc/profile.setProfileImage', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(dataTransformer.serialize(input)),
      }),
    });

  beforeEach(() => {
    vi.resetAllMocks();

    mocks.setAvatarImage.mockResolvedValue('avatar_1');
  });

  it('answers a blocked team avatar with a 403', async () => {
    mocks.prisma.user.findUnique.mockResolvedValue(account([Role.SIGN_ONLY]));

    const response = await call({ bytes, teamId: 1, organisationId: null });
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error.json.data.code).toBe('FORBIDDEN');
    expect(body.error.json.data.httpStatus).toBe(403);
    expect(body.error.json.data.appError.statusCode).toBe(403);
    expect(mocks.setAvatarImage).not.toHaveBeenCalled();
  });

  it('answers an allowed account avatar with its data', async () => {
    mocks.prisma.user.findUnique.mockResolvedValue(account([Role.SIGN_ONLY]));

    const response = await call({ bytes, teamId: null, organisationId: null });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(dataTransformer.deserialize(body.result.data)).toBe('avatar_1');
  });
});
