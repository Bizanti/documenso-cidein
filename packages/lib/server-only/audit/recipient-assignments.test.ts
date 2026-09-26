import { DocumentStatus } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { countActiveRecipientAssignments } from './recipient-assignments';

const mocks = vi.hoisted(() => ({
  prisma: {
    recipient: {
      count: vi.fn(),
    },
  },
}));

vi.mock('@documenso/prisma', () => ({ prisma: mocks.prisma }));

describe('countActiveRecipientAssignments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('only counts the signing assignments of envelopes which are still open', async () => {
    mocks.prisma.recipient.count.mockResolvedValue(2);

    const count = await countActiveRecipientAssignments({ email: 'signer@example.com' });

    expect(count).toBe(2);

    expect(mocks.prisma.recipient.count).toHaveBeenCalledWith({
      where: {
        email: {
          equals: 'signer@example.com',
          mode: 'insensitive',
        },
        documentDeletedAt: null,
        envelope: {
          deletedAt: null,
          status: {
            notIn: [DocumentStatus.COMPLETED, DocumentStatus.REJECTED, DocumentStatus.CANCELLED],
          },
        },
      },
    });
  });
});
