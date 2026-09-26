import { type Prisma, Role, UserSecurityAuditLogType } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { recordUserProfileChange } from './user-profile-change';

const mocks = vi.hoisted(() => ({
  prisma: {
    userSecurityAuditLog: {
      create: vi.fn(),
    },
  },
  logger: {
    info: vi.fn(),
  },
}));

vi.mock('@documenso/prisma', () => ({ prisma: mocks.prisma }));
vi.mock('../../utils/logger', () => ({ logger: mocks.logger }));

const requestMetadata = {
  ipAddress: '127.0.0.1',
  userAgent: 'vitest',
};

describe('recordUserProfileChange', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('records who changed the roles of an account and the previous and new values', async () => {
    const result = await recordUserProfileChange({
      actorUserId: 1,
      targetUserId: 42,
      previous: { roles: [Role.USER], email: 'signer@example.com' },
      next: { roles: [Role.SIGN_ONLY], email: 'signer@example.com' },
      metadata: requestMetadata,
    });

    expect(result).toEqual({ changedFields: ['roles'] });

    expect(mocks.prisma.userSecurityAuditLog.create).toHaveBeenCalledTimes(1);
    expect(mocks.prisma.userSecurityAuditLog.create).toHaveBeenCalledWith({
      data: {
        userId: 42,
        type: UserSecurityAuditLogType.ACCOUNT_PROFILE_UPDATE,
        ipAddress: '127.0.0.1',
        userAgent: 'vitest',
      },
    });

    expect(mocks.logger.info).toHaveBeenCalledTimes(1);
    expect(mocks.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        auditEvent: 'USER_PROFILE_CHANGE',
        actorUserId: 1,
        targetUserId: 42,
        changedFields: ['roles'],
        previousRoles: [Role.USER],
        newRoles: [Role.SIGN_ONLY],
        previousEmail: 'signer@example.com',
        newEmail: 'signer@example.com',
      }),
    );
  });

  it('records a promotion as the replacement of the sign only profile', async () => {
    const result = await recordUserProfileChange({
      actorUserId: 7,
      targetUserId: 42,
      previous: { roles: [Role.SIGN_ONLY], email: 'signer@example.com' },
      next: { roles: [Role.USER], email: 'signer@example.com' },
    });

    expect(result).toEqual({ changedFields: ['roles'] });

    expect(mocks.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        previousRoles: [Role.SIGN_ONLY],
        newRoles: [Role.USER],
      }),
    );
  });

  it('records an email change of an account', async () => {
    const result = await recordUserProfileChange({
      actorUserId: 1,
      targetUserId: 42,
      previous: { roles: [Role.SIGN_ONLY], email: 'before@example.com' },
      next: { roles: [Role.SIGN_ONLY], email: 'after@example.com' },
      metadata: requestMetadata,
    });

    expect(result).toEqual({ changedFields: ['email'] });

    expect(mocks.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        changedFields: ['email'],
        previousEmail: 'before@example.com',
        newEmail: 'after@example.com',
      }),
    );
  });

  it('records both fields when the roles and the email change at once', async () => {
    const result = await recordUserProfileChange({
      actorUserId: 1,
      targetUserId: 42,
      previous: { roles: [Role.USER], email: 'before@example.com' },
      next: { roles: [Role.SIGN_ONLY], email: 'after@example.com' },
    });

    expect(result).toEqual({ changedFields: ['roles', 'email'] });
  });

  it('writes nothing when the profile did not change', async () => {
    const result = await recordUserProfileChange({
      actorUserId: 1,
      targetUserId: 42,
      previous: { roles: [Role.USER], email: 'signer@example.com' },
      next: { roles: [Role.USER], email: 'signer@example.com' },
    });

    expect(result).toEqual({ changedFields: [] });
    expect(mocks.prisma.userSecurityAuditLog.create).not.toHaveBeenCalled();
    expect(mocks.logger.info).not.toHaveBeenCalled();
  });

  it('compares role combinations regardless of the order they are stored in', async () => {
    const result = await recordUserProfileChange({
      actorUserId: 1,
      targetUserId: 42,
      previous: { roles: [Role.USER, Role.ADMIN], email: 'signer@example.com' },
      next: { roles: [Role.ADMIN, Role.USER], email: 'signer@example.com' },
    });

    expect(result).toEqual({ changedFields: [] });
    expect(mocks.prisma.userSecurityAuditLog.create).not.toHaveBeenCalled();
  });

  it('writes the record through the provided transaction client', async () => {
    const tx = {
      userSecurityAuditLog: {
        create: vi.fn(),
      },
    } as unknown as Prisma.TransactionClient;

    await recordUserProfileChange({
      actorUserId: 1,
      targetUserId: 42,
      previous: { roles: [Role.USER], email: 'signer@example.com' },
      next: { roles: [Role.SIGN_ONLY], email: 'signer@example.com' },
      tx,
    });

    expect(tx.userSecurityAuditLog.create).toHaveBeenCalledTimes(1);
    expect(mocks.prisma.userSecurityAuditLog.create).not.toHaveBeenCalled();
  });
});
