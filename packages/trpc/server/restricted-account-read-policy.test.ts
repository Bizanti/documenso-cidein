import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { Role } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  assertRestrictedAccountCanReadById,
  isRestrictedAccountAllowedToReadProcedurePath,
  RESTRICTED_ACCOUNT_READ_MESSAGE,
} from './restricted-account-read-policy';

const mocks = vi.hoisted(() => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock('@documenso/prisma', () => ({ prisma: mocks.prisma }));

const account = (roles: Role[]) => ({ roles });

describe('isRestrictedAccountAllowedToReadProcedurePath', () => {
  it('closes the team and organisation reads', () => {
    for (const path of [
      'envelope.get',
      'envelope.find',
      'envelope.getMany',
      'envelope.editor.get',
      'envelope.field.get',
      'envelope.field.getSignatures',
      'envelope.item.getMany',
      'envelope.recipient.get',
      'envelope.auditLog.find',
      'document.find',
      'document.get',
      'document.getMany',
      'document.search',
      'document.findDocumentsInternal',
      'document.attachment.find',
      'document.auditLog.find',
      'template.findTemplates',
      'template.getTemplateById',
      'template.search',
      'folder.getFolders',
      'folder.findFolders',
      'folder.findFoldersInternal',
      'team.find',
      'team.get',
      'team.member.find',
      'team.member.getMany',
      'team.group.find',
      'organisation.get',
      'organisation.getMany',
      'organisation.getQuotaFlags',
      'organisation.member.find',
      'organisation.group.find',
      'organisation.member.invite.getMany',
      'recipient.getDocumentRecipient',
      'recipient.getTemplateRecipient',
      'field.getDocumentField',
      'field.getTemplateField',
      'api-token.getMany',
      'webhook.calls.find',
      'enterprise.organisation.email.find',
      'admin.user.get',
    ]) {
      expect(isRestrictedAccountAllowedToReadProcedurePath(path)).toBe(false);
    }
  });

  it('keeps the reads of the account itself open', () => {
    expect(isRestrictedAccountAllowedToReadProcedurePath('auth.passkey.find')).toBe(true);
    expect(isRestrictedAccountAllowedToReadProcedurePath('auth.getAuthMethods')).toBe(true);
    expect(isRestrictedAccountAllowedToReadProcedurePath('profile.findUserSecurityAuditLogs')).toBe(true);
  });

  it('keeps the "My signatures" reads open', () => {
    expect(isRestrictedAccountAllowedToReadProcedurePath('document.inbox.find')).toBe(true);
    expect(isRestrictedAccountAllowedToReadProcedurePath('document.inbox.getCount')).toBe(true);
  });

  it('keeps the reads a signer needs which no prefix covers open', () => {
    expect(isRestrictedAccountAllowedToReadProcedurePath('team.email.get')).toBe(true);
    expect(isRestrictedAccountAllowedToReadProcedurePath('document.getEnvelopeDownloadPolicies')).toBe(true);
  });

  it('does not open a path which merely starts like an allowed one', () => {
    expect(isRestrictedAccountAllowedToReadProcedurePath('authenticated.anything')).toBe(false);
    expect(isRestrictedAccountAllowedToReadProcedurePath('profiles.get')).toBe(false);
    expect(isRestrictedAccountAllowedToReadProcedurePath('document.inboxes.find')).toBe(false);
    expect(isRestrictedAccountAllowedToReadProcedurePath('team.email.update')).toBe(false);
  });

  it('closes a router which does not exist yet rather than leaving it open', () => {
    expect(isRestrictedAccountAllowedToReadProcedurePath('something.new')).toBe(false);
    expect(isRestrictedAccountAllowedToReadProcedurePath('document.newRead')).toBe(false);
  });
});

describe('assertRestrictedAccountCanReadById', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('reads the roles fresh from the database on every call', async () => {
    mocks.prisma.user.findUnique.mockResolvedValue(account([Role.SIGN_ONLY]));

    await expect(assertRestrictedAccountCanReadById({ userId: 42 })).rejects.toThrow(AppError);

    expect(mocks.prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 42 },
      select: { roles: true },
    });
  });

  it('rejects a sign only account with a 403', async () => {
    mocks.prisma.user.findUnique.mockResolvedValue(account([Role.SIGN_ONLY]));

    try {
      await assertRestrictedAccountCanReadById({ userId: 42 });
      expect.unreachable('The account should have been rejected');
    } catch (error) {
      expect((error as AppError).code).toBe(AppErrorCode.FORBIDDEN);
      expect((error as AppError).statusCode).toBe(403);
      expect((error as AppError).message).toContain(RESTRICTED_ACCOUNT_READ_MESSAGE);
    }
  });

  it('rejects an invalid role combination', async () => {
    mocks.prisma.user.findUnique.mockResolvedValue(account([]));

    await expect(assertRestrictedAccountCanReadById({ userId: 42 })).rejects.toThrow(AppError);

    mocks.prisma.user.findUnique.mockResolvedValue(account([Role.USER, Role.SIGN_ONLY]));

    await expect(assertRestrictedAccountCanReadById({ userId: 42 })).rejects.toThrow(AppError);
  });

  it('rejects when the account no longer exists instead of assuming it is allowed', async () => {
    mocks.prisma.user.findUnique.mockResolvedValue(null);

    await expect(assertRestrictedAccountCanReadById({ userId: 42 })).rejects.toThrow(AppError);
  });

  it('allows an unrestricted account', async () => {
    mocks.prisma.user.findUnique.mockResolvedValue(account([Role.USER]));

    await expect(assertRestrictedAccountCanReadById({ userId: 42 })).resolves.toBeUndefined();

    mocks.prisma.user.findUnique.mockResolvedValue(account([Role.ADMIN]));

    await expect(assertRestrictedAccountCanReadById({ userId: 42 })).resolves.toBeUndefined();
  });

  it('does not care how long the session has lived: the current roles decide', async () => {
    mocks.prisma.user.findUnique.mockResolvedValueOnce(account([Role.USER]));
    await expect(assertRestrictedAccountCanReadById({ userId: 42 })).resolves.toBeUndefined();

    mocks.prisma.user.findUnique.mockResolvedValueOnce(account([Role.SIGN_ONLY]));
    await expect(assertRestrictedAccountCanReadById({ userId: 42 })).rejects.toThrow(AppError);
  });
});
