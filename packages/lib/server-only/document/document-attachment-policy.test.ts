import { RecipientRole, Role } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  canAttachDocumentPdfToAddressee,
  filterAddresseesAllowedToReceiveDocumentPdf,
} from './document-attachment-policy';

const mocks = vi.hoisted(() => ({
  resolveAccountForAuthorization: vi.fn(),
}));

vi.mock('../auth/resolve-account-for-authorization', () => ({
  resolveAccountForAuthorization: mocks.resolveAccountForAuthorization,
}));

describe('canAttachDocumentPdfToAddressee', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('refuses a controlled signer recipient', async () => {
    const canAttach = await canAttachDocumentPdfToAddressee({
      email: 'signer@example.com',
      recipientRole: RecipientRole.CONTROLLED_SIGNER,
    });

    expect(canAttach).toBe(false);
    // The recipient role already decides, so no account lookup is needed.
    expect(mocks.resolveAccountForAuthorization).not.toHaveBeenCalled();
  });

  it('allows the recipient roles which receive the document', async () => {
    mocks.resolveAccountForAuthorization.mockResolvedValue(null);

    await expect(
      canAttachDocumentPdfToAddressee({ email: 'signer@example.com', recipientRole: RecipientRole.SIGNER }),
    ).resolves.toBe(true);
  });

  it('allows an addressee with no account, who is ruled by the recipient role alone', async () => {
    mocks.resolveAccountForAuthorization.mockResolvedValue(null);

    await expect(canAttachDocumentPdfToAddressee({ email: 'external@example.com' })).resolves.toBe(true);
  });

  it('refuses an addressee whose account is sign only', async () => {
    mocks.resolveAccountForAuthorization.mockResolvedValue({
      id: 7,
      email: 'signer@example.com',
      roles: [Role.SIGN_ONLY],
    });

    await expect(canAttachDocumentPdfToAddressee({ email: 'signer@example.com' })).resolves.toBe(false);
  });

  it('refuses an addressee whose account has an invalid role combination', async () => {
    mocks.resolveAccountForAuthorization.mockResolvedValue({
      id: 7,
      email: 'signer@example.com',
      roles: [Role.USER, Role.SIGN_ONLY],
    });

    await expect(canAttachDocumentPdfToAddressee({ email: 'signer@example.com' })).resolves.toBe(false);
  });

  it('allows an addressee with an unrestricted account', async () => {
    mocks.resolveAccountForAuthorization.mockResolvedValue({ id: 7, email: 'signer@example.com', roles: [Role.USER] });

    await expect(canAttachDocumentPdfToAddressee({ email: 'signer@example.com' })).resolves.toBe(true);
  });

  it('never resolves to allow when the account could not be resolved', async () => {
    mocks.resolveAccountForAuthorization.mockRejectedValue(new Error('database is down'));

    await expect(canAttachDocumentPdfToAddressee({ email: 'signer@example.com' })).resolves.toBe(false);
  });
});

describe('filterAddresseesAllowedToReceiveDocumentPdf', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('keeps only the addresses which may receive the document', async () => {
    mocks.resolveAccountForAuthorization.mockImplementation(async (email: string) =>
      email === 'restricted@example.com' ? { id: 7, email, roles: [Role.SIGN_ONLY] } : null,
    );

    await expect(
      filterAddresseesAllowedToReceiveDocumentPdf([
        'external@example.com',
        'restricted@example.com',
        'member@example.com',
      ]),
    ).resolves.toEqual(['external@example.com', 'member@example.com']);
  });

  it('keeps nothing when no address can be resolved', async () => {
    mocks.resolveAccountForAuthorization.mockRejectedValue(new Error('database is down'));

    await expect(filterAddresseesAllowedToReceiveDocumentPdf(['a@example.com', 'b@example.com'])).resolves.toEqual([]);
  });
});
