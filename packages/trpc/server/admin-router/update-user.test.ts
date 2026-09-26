import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { Role } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TrpcContext } from '../context';
import { router } from '../trpc';

import { updateUserRoute } from './update-user';
import type { TUpdateUserRequest } from './update-user.types';

const mocks = vi.hoisted(() => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
    },
  },
  updateUser: vi.fn(),
  countActiveRecipientAssignments: vi.fn(),
  recordUserProfileChange: vi.fn(),
  invalidateUserSessions: vi.fn(),
}));

vi.mock('@documenso/prisma', () => ({ prisma: mocks.prisma }));

vi.mock('@documenso/lib/server-only/admin/update-user', () => ({
  updateUser: mocks.updateUser,
}));

vi.mock('@documenso/lib/server-only/audit/recipient-assignments', () => ({
  countActiveRecipientAssignments: mocks.countActiveRecipientAssignments,
}));

vi.mock('@documenso/lib/server-only/audit/user-profile-change', () => ({
  recordUserProfileChange: mocks.recordUserProfileChange,
}));

vi.mock('@documenso/auth/server/lib/session/session', () => ({
  invalidateUserSessions: mocks.invalidateUserSessions,
}));

const ADMIN_USER_ID = 1;
const TARGET_USER_ID = 2;
const TARGET_EMAIL = 'signer@example.com';

const testRouter = router({
  user: {
    update: updateUserRoute,
  },
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

const createAdminContext = () =>
  ({
    logger: createLogger(),
    session: {
      id: 'session_1',
      userId: ADMIN_USER_ID,
      expires: new Date(Date.now() + 60_000),
      createdAt: new Date(),
    },
    user: {
      id: ADMIN_USER_ID,
      email: 'admin@example.com',
      name: 'Admin',
      roles: [Role.USER, Role.ADMIN],
      disabled: false,
    },
    teamId: undefined,
    req: new Request('http://localhost/api/trpc'),
    res: new Response(),
    metadata: { requestMetadata: {}, source: 'app', auth: null },
  }) as unknown as TrpcContext;

/**
 * Answer both account reads of the call from the same mock: the read the admin
 * middleware performs on the administrator, and the read the route performs on
 * the account which is being edited.
 */
const mockAccounts = ({ roles }: { roles: Role[] }) => {
  mocks.prisma.user.findUnique.mockImplementation(async ({ where }: { where: { id: number } }) =>
    where.id === ADMIN_USER_ID
      ? { roles: [Role.USER, Role.ADMIN] }
      : { id: TARGET_USER_ID, email: TARGET_EMAIL, roles },
  );
};

const callUpdateUser = async (input: TUpdateUserRequest) =>
  await testRouter.createCaller(createAdminContext()).user.update(input);

/**
 * The AppError thrown by the route reaches the caller as the `cause` of the
 * `TRPCError` which tRPC wraps it in.
 */
const getAppError = async (call: () => Promise<unknown>) => {
  try {
    await call();
    expect.unreachable('The call should have been rejected');
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause;

    expect(cause).toBeInstanceOf(AppError);

    return cause as AppError;
  }
};

describe('admin.user.update role profiles', () => {
  beforeEach(() => {
    vi.resetAllMocks();

    mocks.countActiveRecipientAssignments.mockResolvedValue(0);
    mocks.updateUser.mockResolvedValue(undefined);
    mocks.recordUserProfileChange.mockResolvedValue({ changedFields: ['roles'] });
    mocks.invalidateUserSessions.mockResolvedValue(1);
  });

  it('stores the requested sign only profile instead of promoting the account', async () => {
    mockAccounts({ roles: [Role.USER] });

    await callUpdateUser({ id: TARGET_USER_ID, roles: [Role.SIGN_ONLY] });

    expect(mocks.updateUser).toHaveBeenCalledWith({
      id: TARGET_USER_ID,
      name: undefined,
      email: undefined,
      roles: [Role.SIGN_ONLY],
    });

    // The audit record carries the restriction which was stored, and the
    // profile change is effective on the next request.
    expect(mocks.recordUserProfileChange).toHaveBeenCalledWith(
      expect.objectContaining({
        previous: { roles: [Role.USER], email: TARGET_EMAIL },
        next: { roles: [Role.SIGN_ONLY], email: TARGET_EMAIL },
      }),
    );
    expect(mocks.invalidateUserSessions).toHaveBeenCalledWith({ userId: TARGET_USER_ID, metadata: {} });
  });

  it('stores the user profile when the administrator promotes a restricted account', async () => {
    mockAccounts({ roles: [Role.SIGN_ONLY] });

    await callUpdateUser({ id: TARGET_USER_ID, roles: [Role.USER] });

    expect(mocks.updateUser).toHaveBeenCalledWith({
      id: TARGET_USER_ID,
      name: undefined,
      email: undefined,
      roles: [Role.USER],
    });
  });

  it('keeps a restricted account restricted when its current profile is submitted unchanged', async () => {
    mockAccounts({ roles: [Role.SIGN_ONLY] });
    mocks.recordUserProfileChange.mockResolvedValue({ changedFields: [] });

    // The panel submits the profile it has loaded, so editing any other field of
    // a restricted account sends its current profile along.
    await callUpdateUser({ id: TARGET_USER_ID, name: 'New name', roles: [Role.SIGN_ONLY] });

    expect(mocks.updateUser).toHaveBeenCalledWith({
      id: TARGET_USER_ID,
      name: 'New name',
      email: undefined,
      roles: [Role.SIGN_ONLY],
    });
    expect(mocks.invalidateUserSessions).not.toHaveBeenCalled();
  });

  it('keeps the stored roles when the profile is not part of the edit', async () => {
    mockAccounts({ roles: [Role.SIGN_ONLY] });
    mocks.recordUserProfileChange.mockResolvedValue({ changedFields: [] });

    await callUpdateUser({ id: TARGET_USER_ID, name: 'New name' });

    // The roles are left out of the write, so the restricted profile survives an
    // edit which did not ask for a promotion.
    expect(mocks.updateUser).toHaveBeenCalledWith({
      id: TARGET_USER_ID,
      name: 'New name',
      email: undefined,
      roles: undefined,
    });

    expect(mocks.recordUserProfileChange).toHaveBeenCalledWith(
      expect.objectContaining({
        previous: { roles: [Role.SIGN_ONLY], email: TARGET_EMAIL },
        next: { roles: [Role.SIGN_ONLY], email: TARGET_EMAIL },
      }),
    );
    expect(mocks.invalidateUserSessions).not.toHaveBeenCalled();
  });

  it('rejects a profile which mixes the restriction with a permission', async () => {
    mockAccounts({ roles: [Role.USER] });

    const error = await getAppError(() => callUpdateUser({ id: TARGET_USER_ID, roles: [Role.SIGN_ONLY, Role.USER] }));

    expect(error.code).toBe(AppErrorCode.INVALID_REQUEST);
    expect(mocks.updateUser).not.toHaveBeenCalled();
  });

  it('rejects an empty profile', async () => {
    mockAccounts({ roles: [Role.USER] });

    const error = await getAppError(() => callUpdateUser({ id: TARGET_USER_ID, roles: [] }));

    expect(error.code).toBe(AppErrorCode.INVALID_REQUEST);
    expect(mocks.updateUser).not.toHaveBeenCalled();
  });

  it('stores the administrator profile in its canonical order', async () => {
    mockAccounts({ roles: [Role.USER] });

    await callUpdateUser({ id: TARGET_USER_ID, roles: [Role.ADMIN, Role.USER] });

    expect(mocks.updateUser).toHaveBeenCalledWith({
      id: TARGET_USER_ID,
      name: undefined,
      email: undefined,
      roles: [Role.USER, Role.ADMIN],
    });
  });

  it('refuses to restrict an account which still holds live signing assignments', async () => {
    mockAccounts({ roles: [Role.USER] });
    mocks.countActiveRecipientAssignments.mockResolvedValue(2);

    const error = await getAppError(() =>
      callUpdateUser({ id: TARGET_USER_ID, roles: [Role.SIGN_ONLY], email: 'restricted@example.com' }),
    );

    expect(error.code).toBe(AppErrorCode.INVALID_REQUEST);
    expect(mocks.countActiveRecipientAssignments).toHaveBeenCalledWith({ email: TARGET_EMAIL });
    expect(mocks.updateUser).not.toHaveBeenCalled();
  });
});
