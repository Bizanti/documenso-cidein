import { Role } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppError, AppErrorCode } from '../../errors/app-error';
import {
  assertAccountAllowedToDownloadById,
  assertCanManageDocuments,
  assertCanManageDocumentsById,
  isAllowedToManageDocuments,
  isDocumentManagementProcedurePath,
  isRestrictedAccount,
} from './document-authorization';

const mocks = vi.hoisted(() => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock('@documenso/prisma', () => ({ prisma: mocks.prisma }));

const account = (roles: Role[]) => ({ roles });

describe('isRestrictedAccount', () => {
  it('treats the sign only role as a restriction', () => {
    expect(isRestrictedAccount(account([Role.SIGN_ONLY]))).toBe(true);
  });

  it('lets the regular roles through', () => {
    expect(isRestrictedAccount(account([Role.USER]))).toBe(false);
    expect(isRestrictedAccount(account([Role.ADMIN]))).toBe(false);
    expect(isRestrictedAccount(account([Role.USER, Role.ADMIN]))).toBe(false);
  });

  it('keeps the restriction when the sign only role shares the account', () => {
    expect(isRestrictedAccount(account([Role.USER, Role.SIGN_ONLY]))).toBe(true);
    expect(isRestrictedAccount(account([Role.ADMIN, Role.SIGN_ONLY]))).toBe(true);
  });

  it('treats an unknown combination as restricted', () => {
    expect(isRestrictedAccount(account([]))).toBe(true);
  });

  it('is the negation of the guard the routes assert', () => {
    expect(isAllowedToManageDocuments(account([Role.USER]))).toBe(true);
    expect(isAllowedToManageDocuments(account([Role.SIGN_ONLY]))).toBe(false);
  });
});

describe('assertCanManageDocuments', () => {
  it('rejects a sign only account with a 403', () => {
    expect(() => assertCanManageDocuments(account([Role.SIGN_ONLY]))).toThrow(AppError);

    try {
      assertCanManageDocuments(account([Role.SIGN_ONLY]));
    } catch (error) {
      expect((error as AppError).code).toBe(AppErrorCode.FORBIDDEN);
      expect((error as AppError).statusCode).toBe(403);
    }
  });

  it('rejects an invalid role combination', () => {
    expect(() => assertCanManageDocuments(account([]))).toThrow(AppError);
    expect(() => assertCanManageDocuments(account([Role.USER, Role.SIGN_ONLY]))).toThrow(AppError);
  });

  it('rejects a missing account instead of assuming it is allowed', () => {
    expect(() => assertCanManageDocuments(null)).toThrow(AppError);
    expect(() => assertCanManageDocuments(undefined)).toThrow(AppError);
  });

  it('allows an unrestricted account', () => {
    expect(() => assertCanManageDocuments(account([Role.USER]))).not.toThrow();
    expect(() => assertCanManageDocuments(account([Role.ADMIN]))).not.toThrow();
  });
});

describe('assertCanManageDocumentsById', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('reads the roles fresh from the database on every call', async () => {
    mocks.prisma.user.findUnique.mockResolvedValue(account([Role.SIGN_ONLY]));

    await expect(assertCanManageDocumentsById({ userId: 42 })).rejects.toThrow(AppError);

    expect(mocks.prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 42 },
      select: { roles: true },
    });
  });

  it('does not care how long the session has lived: the current roles decide', async () => {
    mocks.prisma.user.findUnique.mockResolvedValueOnce(account([Role.USER]));
    await expect(assertCanManageDocumentsById({ userId: 42 })).resolves.toBeUndefined();

    mocks.prisma.user.findUnique.mockResolvedValueOnce(account([Role.SIGN_ONLY]));
    await expect(assertCanManageDocumentsById({ userId: 42 })).rejects.toThrow(AppError);
  });

  it('rejects when the account no longer exists', async () => {
    mocks.prisma.user.findUnique.mockResolvedValue(null);

    await expect(assertCanManageDocumentsById({ userId: 42 })).rejects.toThrow(AppError);
  });
});

describe('assertAccountAllowedToDownloadById', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('rejects a sign only account with a 403', async () => {
    mocks.prisma.user.findUnique.mockResolvedValue(account([Role.SIGN_ONLY]));

    await expect(assertAccountAllowedToDownloadById({ userId: 42 })).rejects.toThrow(AppError);

    try {
      await assertAccountAllowedToDownloadById({ userId: 42 });
    } catch (error) {
      expect((error as AppError).code).toBe(AppErrorCode.FORBIDDEN);
      expect((error as AppError).statusCode).toBe(403);
    }
  });

  it('allows an unrestricted account', async () => {
    mocks.prisma.user.findUnique.mockResolvedValue(account([Role.USER]));

    await expect(assertAccountAllowedToDownloadById({ userId: 42 })).resolves.toBeUndefined();
  });
});

describe('isDocumentManagementProcedurePath', () => {
  it('guards the document management routers', () => {
    for (const path of [
      'envelope.create',
      'document.create',
      'template.create',
      'folder.create',
      'field.createDocumentField',
      'recipient.createDocumentRecipient',
      'team.create',
      'organisation.create',
      'enterprise.createOrganisationEmail',
      'apiToken.create',
      'webhook.create',
      'embeddingPresign.create',
      'admin.user.update',
    ]) {
      expect(isDocumentManagementProcedurePath(path)).toBe(true);
    }
  });

  it('keeps the self service routers open, because they only manage the account itself', () => {
    expect(isDocumentManagementProcedurePath('auth.passkey.create')).toBe(false);
    expect(isDocumentManagementProcedurePath('profile.updateProfile')).toBe(false);
    expect(isDocumentManagementProcedurePath('profile.deleteAccount')).toBe(false);
  });

  it('guards a router which does not exist yet rather than leaving it open', () => {
    expect(isDocumentManagementProcedurePath('something.new')).toBe(true);
  });
});
