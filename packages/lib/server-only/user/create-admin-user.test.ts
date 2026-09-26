import { Role } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppError, AppErrorCode } from '../../errors/app-error';
import { createAdminUser } from './create-admin-user';

const mocks = vi.hoisted(() => ({
  prisma: {
    user: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
  },
}));

vi.mock('@documenso/prisma', () => ({ prisma: mocks.prisma }));

const getCreatedUserData = () => mocks.prisma.user.create.mock.calls[0][0].data;

describe('createAdminUser', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.prisma.user.findFirst.mockResolvedValue(null);
    mocks.prisma.user.create.mockResolvedValue({ id: 1 });
  });

  it('hands out the restricted profile by default', async () => {
    await createAdminUser({ name: 'Signer', email: 'Signer@Example.com' });

    expect(getCreatedUserData().roles).toEqual([Role.SIGN_ONLY]);
    expect(getCreatedUserData().email).toBe('signer@example.com');
  });

  it('still asks the account to set a password and verifies the email', async () => {
    await createAdminUser({ name: 'Signer', email: 'signer@example.com' });

    expect(getCreatedUserData().password).toBeNull();
    expect(getCreatedUserData().emailVerified).toBeInstanceOf(Date);
  });

  it('refuses an email which is already registered', async () => {
    mocks.prisma.user.findFirst.mockResolvedValue({ id: 2 });

    const error = await createAdminUser({ name: 'Signer', email: 'signer@example.com' }).catch((err) => err);

    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe(AppErrorCode.ALREADY_EXISTS);
    expect(mocks.prisma.user.create).not.toHaveBeenCalled();
  });
});
