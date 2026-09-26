import { prisma } from '@documenso/prisma';
import { OrganisationMemberRole, OrganisationType, type Prisma, Role, TeamMemberRole } from '@prisma/client';

import type { FindResultResponse } from '../../types/search-params';
import { deletedServiceAccountEmail } from '../user/service-accounts/deleted-account';
import { legacyServiceAccountEmail } from '../user/service-accounts/legacy-service-account';

/**
 * The internal organisation roles which rule an account out of the review.
 *
 * Every member of an organisation owns the personal organisation created with
 * their account, so the shared organisation membership is what decides whether
 * an account does more than sign.
 */
const PRIVILEGED_ORGANISATION_ROLES: OrganisationMemberRole[] = [
  OrganisationMemberRole.ADMIN,
  OrganisationMemberRole.MANAGER,
  OrganisationMemberRole.SGC,
];

/**
 * The team roles which rule an account out of the review.
 */
const PRIVILEGED_TEAM_ROLES: TeamMemberRole[] = [TeamMemberRole.ADMIN, TeamMemberRole.MANAGER, TeamMemberRole.SGC];

export type FindSignOnlyCandidatesOptions = {
  query?: string;
  page?: number;
  perPage?: number;
};

/**
 * Build the filter of the accounts which can be reviewed as signing only
 * candidates.
 *
 * An account is listed when it holds the plain user role, has never authored an
 * envelope and holds no privileged role in a shared organisation or team. The
 * review never proposes an account which owns or administers a space, since
 * moving one of those to the restricted profile would take the space away from
 * the people using it.
 */
const getSignOnlyCandidatesWhereQuery = ({ query }: { query?: string }): Prisma.UserWhereInput => {
  const searchQuery = query
    ? {
        OR: [
          { email: { contains: query, mode: 'insensitive' as const } },
          { name: { contains: query, mode: 'insensitive' as const } },
        ],
      }
    : {};

  return {
    // Platform administrators and accounts which are already restricted are not
    // candidates for a profile change.
    roles: { equals: [Role.USER] },
    disabled: false,
    email: {
      notIn: [legacyServiceAccountEmail(), deletedServiceAccountEmail()],
    },
    // A personal organisation is expected and is kept as it is.
    ownedOrganisations: {
      none: {
        type: OrganisationType.ORGANISATION,
      },
    },
    organisationMember: {
      none: {
        organisation: {
          type: OrganisationType.ORGANISATION,
        },
        organisationGroupMembers: {
          some: {
            group: {
              OR: [
                { organisationRole: { in: PRIVILEGED_ORGANISATION_ROLES } },
                { teamGroups: { some: { teamRole: { in: PRIVILEGED_TEAM_ROLES } } } },
              ],
            },
          },
        },
      },
    },
    // Accounts which authored an envelope, an api token or a webhook use more
    // than the signing side of the product.
    envelopes: { none: {} },
    apiTokens: { none: {} },
    webhooks: { none: {} },
    ...searchQuery,
  };
};

/**
 * List the existing accounts which can be reviewed as signing only candidates.
 *
 * This is a review list, not a migration: nothing is written and no account is
 * converted. Every row carries the evidence needed to decide (last sign in,
 * organisation count and the signing assignments held by the account email) so
 * a reviewer can pick the accounts which only ever sign.
 *
 * The candidate list can be read with the administrative route
 * `admin.user.findSignOnlyCandidates`, or directly from a script:
 *
 * ```ts
 * const page = await findSignOnlyCandidates({ page: 1, perPage: 100 });
 * ```
 */
export const findSignOnlyCandidates = async ({ query, page = 1, perPage = 20 }: FindSignOnlyCandidatesOptions) => {
  const where = getSignOnlyCandidatesWhereQuery({ query });

  const [users, count] = await Promise.all([
    prisma.user.findMany({
      where,
      select: {
        id: true,
        name: true,
        email: true,
        createdAt: true,
        lastSignedIn: true,
        roles: true,
        _count: {
          select: {
            organisationMember: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
      skip: Math.max(page - 1, 0) * perPage,
      take: perPage,
    }),
    prisma.user.count({ where }),
  ]);

  const recipientCounts =
    users.length > 0
      ? await prisma.recipient.groupBy({
          by: ['email'],
          where: {
            email: { in: users.map((user) => user.email) },
            documentDeletedAt: null,
          },
          _count: {
            _all: true,
            signedAt: true,
          },
        })
      : [];

  const recipientCountByEmail = new Map(recipientCounts.map((row) => [row.email, row._count]));

  const data = users.map((user) => {
    const emailCounts = recipientCountByEmail.get(user.email);

    return {
      id: user.id,
      name: user.name,
      email: user.email,
      roles: user.roles,
      createdAt: user.createdAt,
      lastSignedIn: user.lastSignedIn,
      organisationCount: user._count.organisationMember,
      recipientCount: emailCounts?._all ?? 0,
      signedRecipientCount: emailCounts?.signedAt ?? 0,
    };
  });

  return {
    data,
    count,
    currentPage: Math.max(page, 1),
    perPage,
    totalPages: Math.ceil(count / perPage),
  } satisfies FindResultResponse<typeof data>;
};
