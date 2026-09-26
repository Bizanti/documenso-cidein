import { DocumentStatus, RecipientRole, Role } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TrpcContext } from '../context';
import { router } from '../trpc';
import { getEnvelopeDownloadPoliciesRoute } from './get-envelope-download-policies';

const mocks = vi.hoisted(() => ({
  prisma: {
    envelope: {
      findMany: vi.fn(),
    },
    recipient: {
      findMany: vi.fn(),
    },
    siteSettings: {
      findFirst: vi.fn(),
    },
    user: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock('@documenso/prisma', () => ({ prisma: mocks.prisma }));

const testRouter = router({
  getEnvelopeDownloadPolicies: getEnvelopeDownloadPoliciesRoute,
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

const createContext = () =>
  ({
    logger: createLogger(),
    session: null,
    user: null,
    teamId: undefined,
    req: new Request('http://localhost/api/trpc'),
    res: new Response(),
    metadata: { requestMetadata: {}, source: 'app', auth: null },
  }) as unknown as TrpcContext;

const caller = () => testRouter.createCaller(createContext());

const envelope = () => ({
  id: 'env_1',
  status: DocumentStatus.COMPLETED,
  completedAt: new Date('2026-01-01T00:00:00Z'),
  teamId: 1,
  qrToken: null,
  documentMeta: { downloadWindowHours: null },
});

const request = () => caller().getEnvelopeDownloadPolicies({ envelopeIds: ['env_1'], tokens: ['token_1'] });

describe('getEnvelopeDownloadPolicies', () => {
  beforeEach(() => {
    vi.resetAllMocks();

    mocks.prisma.envelope.findMany.mockResolvedValue([envelope()]);
    mocks.prisma.recipient.findMany.mockResolvedValue([
      { envelopeId: 'env_1', role: RecipientRole.SIGNER, email: 'signer@example.com' },
    ]);
    mocks.prisma.siteSettings.findFirst.mockResolvedValue(null);
  });

  it('resolves the account behind the recipient of a token and blocks its downloads when restricted', async () => {
    mocks.prisma.user.findMany.mockResolvedValue([{ id: 42, email: 'signer@example.com', roles: [Role.SIGN_ONLY] }]);

    const { data } = await request();

    expect(mocks.prisma.user.findMany).toHaveBeenCalledWith({
      where: { email: { equals: 'signer@example.com', mode: 'insensitive' } },
      select: { id: true, email: true, roles: true },
      orderBy: { id: 'asc' },
    });

    expect(data).toHaveLength(1);
    expect(data[0].downloadDenialReason).toBe('ACCOUNT_DOWNLOAD_FORBIDDEN');
    expect(data[0].canDownloadSigned).toBe(false);
    expect(data[0].canDownloadOriginal).toBe(false);
  });

  it('leaves the downloads of an unrestricted recipient account open', async () => {
    mocks.prisma.user.findMany.mockResolvedValue([{ id: 42, email: 'signer@example.com', roles: [Role.USER] }]);

    const { data } = await request();

    expect(data[0].downloadDenialReason).toBeNull();
    expect(data[0].canDownloadSigned).toBe(true);
  });

  it('treats an invalid role combination as restricted', async () => {
    mocks.prisma.user.findMany.mockResolvedValue([
      { id: 42, email: 'signer@example.com', roles: [Role.USER, Role.SIGN_ONLY] },
    ]);

    const { data } = await request();

    expect(data[0].downloadDenialReason).toBe('ACCOUNT_DOWNLOAD_FORBIDDEN');
    expect(data[0].canDownloadSigned).toBe(false);
  });

  it('applies the recipient role alone when the address belongs to no account', async () => {
    mocks.prisma.user.findMany.mockResolvedValue([]);

    const { data } = await request();

    expect(data[0].downloadDenialReason).toBeNull();
  });

  it('keeps a controlled signer unable to download', async () => {
    mocks.prisma.recipient.findMany.mockResolvedValue([
      { envelopeId: 'env_1', role: RecipientRole.CONTROLLED_SIGNER, email: 'signer@example.com' },
    ]);
    mocks.prisma.user.findMany.mockResolvedValue([{ id: 42, email: 'signer@example.com', roles: [Role.USER] }]);

    const { data } = await request();

    expect(data[0].downloadDenialReason).toBe('ACCOUNT_DOWNLOAD_FORBIDDEN');
    expect(data[0].canDownloadSigned).toBe(false);
  });

  it('resolves the account of each recipient address once', async () => {
    mocks.prisma.envelope.findMany.mockResolvedValue([envelope(), { ...envelope(), id: 'env_2' }]);
    mocks.prisma.recipient.findMany.mockResolvedValue([
      { envelopeId: 'env_1', role: RecipientRole.SIGNER, email: 'signer@example.com' },
      { envelopeId: 'env_2', role: RecipientRole.SIGNER, email: 'SIGNER@example.com' },
    ]);
    mocks.prisma.user.findMany.mockResolvedValue([{ id: 42, email: 'signer@example.com', roles: [Role.USER] }]);

    const { data } = await request();

    expect(mocks.prisma.user.findMany).toHaveBeenCalledTimes(1);
    expect(data).toHaveLength(2);
    expect(data[0].downloadDenialReason).toBeNull();
    expect(data[1].downloadDenialReason).toBeNull();
  });
});
