import { Role } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppError, AppErrorCode } from '../../errors/app-error';
import { createUser, onCreateUserHook } from './create-user';

const mocks = vi.hoisted(() => ({
  prisma: {
    user: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
  },
  hash: vi.fn(),
  createPersonalOrganisation: vi.fn(),
}));

vi.mock('@documenso/prisma', () => ({ prisma: mocks.prisma }));
vi.mock('@node-rs/bcrypt', () => ({ hash: mocks.hash }));
vi.mock('../organisation/create-organisation', () => ({
  createPersonalOrganisation: mocks.createPersonalOrganisation,
}));

const buildUser = (roles: Role[]) => ({ id: 1, roles });

const getCreatedUserData = () => mocks.prisma.user.create.mock.calls[0][0].data;

describe('createUser', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.hash.mockResolvedValue('hashed-password');
    mocks.prisma.user.findFirst.mockResolvedValue(null);
    mocks.prisma.user.create.mockResolvedValue(buildUser([Role.SIGN_ONLY]));
  });

  it('hands out the restricted profile on a self service signup', async () => {
    await createUser({ name: 'Signer', email: 'Signer@Example.com', password: 'password' });

    expect(getCreatedUserData().roles).toEqual([Role.SIGN_ONLY]);
    expect(getCreatedUserData().email).toBe('signer@example.com');
  });

  it('does not give the new account a personal organisation', async () => {
    await createUser({ name: 'Signer', email: 'signer@example.com', password: 'password' });

    expect(mocks.createPersonalOrganisation).not.toHaveBeenCalled();
  });

  it('refuses an email which is already registered', async () => {
    mocks.prisma.user.findFirst.mockResolvedValue({ id: 2 });

    const error = await createUser({ name: 'Signer', email: 'signer@example.com', password: 'password' }).catch(
      (err) => err,
    );

    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe(AppErrorCode.ALREADY_EXISTS);
    expect(mocks.prisma.user.create).not.toHaveBeenCalled();
  });
});

describe('onCreateUserHook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a personal organisation for an account holding the user profile', async () => {
    await onCreateUserHook(buildUser([Role.USER]));

    expect(mocks.createPersonalOrganisation).toHaveBeenCalledWith({ userId: 1 });
  });

  it('creates a personal organisation for an account holding a privileged profile', async () => {
    await onCreateUserHook(buildUser([Role.USER, Role.ADMIN]));

    expect(mocks.createPersonalOrganisation).toHaveBeenCalledWith({ userId: 1 });
  });

  it('does not create a personal organisation for a restricted account', async () => {
    await onCreateUserHook(buildUser([Role.SIGN_ONLY]));

    expect(mocks.createPersonalOrganisation).not.toHaveBeenCalled();
  });

  it('does not create a personal organisation for an inconsistent profile', async () => {
    await onCreateUserHook(buildUser([Role.USER, Role.SIGN_ONLY]));
    await onCreateUserHook(buildUser([]));

    expect(mocks.createPersonalOrganisation).not.toHaveBeenCalled();
  });

  it('does not create a personal organisation when the signup path asks for it', async () => {
    await onCreateUserHook(buildUser([Role.USER]), { skipPersonalOrganisation: true });

    expect(mocks.createPersonalOrganisation).not.toHaveBeenCalled();
  });
});
