import { Role } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppError } from '../../errors/app-error';
import { resolveAccountForAuthorization } from './resolve-account-for-authorization';

const mocks = vi.hoisted(() => ({
  prisma: {
    user: {
      findMany: vi.fn(),
    },
  },
  logger: {
    error: vi.fn(),
  },
}));

vi.mock('@documenso/prisma', () => ({ prisma: mocks.prisma }));
vi.mock('../../utils/logger', () => ({ logger: mocks.logger }));

describe('resolveAccountForAuthorization', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns null when the lookup confirmed there is no account', async () => {
    mocks.prisma.user.findMany.mockResolvedValue([]);

    await expect(resolveAccountForAuthorization('external@example.com')).resolves.toBeNull();

    expect(mocks.prisma.user.findMany).toHaveBeenCalledWith({
      where: {
        email: {
          equals: 'external@example.com',
          mode: 'insensitive',
        },
      },
      select: {
        id: true,
        email: true,
        roles: true,
      },
      orderBy: {
        id: 'asc',
      },
    });
  });

  it('returns the account behind the address', async () => {
    mocks.prisma.user.findMany.mockResolvedValue([{ id: 7, email: 'signer@example.com', roles: [Role.SIGN_ONLY] }]);

    await expect(resolveAccountForAuthorization('signer@example.com')).resolves.toEqual({
      id: 7,
      email: 'signer@example.com',
      roles: [Role.SIGN_ONLY],
    });
  });

  it('normalises the address before looking it up', async () => {
    mocks.prisma.user.findMany.mockResolvedValue([]);

    await resolveAccountForAuthorization('  Signer@Example.com ');

    expect(mocks.prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          email: {
            equals: 'signer@example.com',
            mode: 'insensitive',
          },
        },
      }),
    );
  });

  it('treats an empty address as an external recipient', async () => {
    await expect(resolveAccountForAuthorization('   ')).resolves.toBeNull();
    expect(mocks.prisma.user.findMany).not.toHaveBeenCalled();
  });

  it('never resolves to allow when the lookup fails', async () => {
    mocks.prisma.user.findMany.mockRejectedValue(new Error('database is down'));

    await expect(resolveAccountForAuthorization('signer@example.com')).rejects.toThrow(AppError);

    // The failure is recorded so it can be retried under the caller's policy.
    expect(mocks.logger.error).toHaveBeenCalled();
  });

  it('never resolves to allow when the address maps to more than one account', async () => {
    mocks.prisma.user.findMany.mockResolvedValue([
      { id: 7, email: 'signer@example.com', roles: [Role.USER] },
      { id: 8, email: 'signer@example.com', roles: [Role.SIGN_ONLY] },
    ]);

    await expect(resolveAccountForAuthorization('signer@example.com')).rejects.toThrow(AppError);
  });
});
