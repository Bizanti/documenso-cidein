import { OrganisationMemberRole, OrganisationType, Role, TeamMemberRole } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { findSignOnlyCandidates } from './find-sign-only-candidates';

const mocks = vi.hoisted(() => ({
  prisma: {
    user: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
    recipient: {
      groupBy: vi.fn(),
    },
  },
}));

vi.mock('@documenso/prisma', () => ({ prisma: mocks.prisma }));

const getCandidateWhereQuery = () => mocks.prisma.user.findMany.mock.calls[0][0].where;

describe('findSignOnlyCandidates', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.prisma.recipient.groupBy.mockResolvedValue([]);
    mocks.prisma.user.count.mockResolvedValue(0);
    mocks.prisma.user.findMany.mockResolvedValue([]);
  });

  it('only proposes accounts holding the plain user profile', async () => {
    await findSignOnlyCandidates({});

    expect(getCandidateWhereQuery().roles).toEqual({ equals: [Role.USER] });
    expect(getCandidateWhereQuery().disabled).toBe(false);
    expect(getCandidateWhereQuery().email.notIn).toHaveLength(2);
  });

  it('never proposes the owner of a shared organisation', async () => {
    await findSignOnlyCandidates({});

    expect(getCandidateWhereQuery().ownedOrganisations).toEqual({
      none: {
        type: OrganisationType.ORGANISATION,
      },
    });
  });

  it('never proposes an account with a privileged organisation or team role', async () => {
    await findSignOnlyCandidates({});

    expect(getCandidateWhereQuery().organisationMember).toEqual({
      none: {
        organisation: {
          type: OrganisationType.ORGANISATION,
        },
        organisationGroupMembers: {
          some: {
            group: {
              OR: [
                {
                  organisationRole: {
                    in: [OrganisationMemberRole.ADMIN, OrganisationMemberRole.MANAGER, OrganisationMemberRole.SGC],
                  },
                },
                {
                  teamGroups: {
                    some: {
                      teamRole: { in: [TeamMemberRole.ADMIN, TeamMemberRole.MANAGER, TeamMemberRole.SGC] },
                    },
                  },
                },
              ],
            },
          },
        },
      },
    });
  });

  it('never proposes an account which authored documents or credentials', async () => {
    await findSignOnlyCandidates({});

    expect(getCandidateWhereQuery().envelopes).toEqual({ none: {} });
    expect(getCandidateWhereQuery().apiTokens).toEqual({ none: {} });
    expect(getCandidateWhereQuery().webhooks).toEqual({ none: {} });
  });

  it('searches by email and name', async () => {
    await findSignOnlyCandidates({ query: 'signer' });

    expect(getCandidateWhereQuery().OR).toEqual([
      { email: { contains: 'signer', mode: 'insensitive' } },
      { name: { contains: 'signer', mode: 'insensitive' } },
    ]);
  });

  it('returns the evidence needed to review each candidate', async () => {
    mocks.prisma.user.findMany.mockResolvedValue([
      {
        id: 42,
        name: 'Signer',
        email: 'signer@example.com',
        roles: [Role.USER],
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        lastSignedIn: new Date('2026-02-01T00:00:00.000Z'),
        _count: { organisationMember: 1 },
      },
      {
        id: 43,
        name: null,
        email: 'other@example.com',
        roles: [Role.USER],
        createdAt: new Date('2026-01-02T00:00:00.000Z'),
        lastSignedIn: new Date('2026-02-02T00:00:00.000Z'),
        _count: { organisationMember: 0 },
      },
    ]);

    mocks.prisma.recipient.groupBy.mockResolvedValue([
      {
        email: 'signer@example.com',
        _count: { _all: 3, signedAt: 2 },
      },
    ]);

    mocks.prisma.user.count.mockResolvedValue(2);

    const result = await findSignOnlyCandidates({ page: 2, perPage: 10 });

    expect(mocks.prisma.recipient.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ['email'],
        where: {
          email: { in: ['signer@example.com', 'other@example.com'] },
          documentDeletedAt: null,
        },
      }),
    );

    expect(result.data).toEqual([
      {
        id: 42,
        name: 'Signer',
        email: 'signer@example.com',
        roles: [Role.USER],
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        lastSignedIn: new Date('2026-02-01T00:00:00.000Z'),
        organisationCount: 1,
        recipientCount: 3,
        signedRecipientCount: 2,
      },
      {
        id: 43,
        name: null,
        email: 'other@example.com',
        roles: [Role.USER],
        createdAt: new Date('2026-01-02T00:00:00.000Z'),
        lastSignedIn: new Date('2026-02-02T00:00:00.000Z'),
        organisationCount: 0,
        recipientCount: 0,
        signedRecipientCount: 0,
      },
    ]);

    expect(result.count).toBe(2);
    expect(result.currentPage).toBe(2);
    expect(result.perPage).toBe(10);
    expect(result.totalPages).toBe(1);

    expect(mocks.prisma.user.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 10, take: 10 }));
  });

  it('does not query signing assignments when the page is empty', async () => {
    const result = await findSignOnlyCandidates({});

    expect(mocks.prisma.recipient.groupBy).not.toHaveBeenCalled();
    expect(result.data).toEqual([]);
    expect(result.currentPage).toBe(1);
  });
});
