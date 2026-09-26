import {
  assertMemberCountWithinCap,
  syncMemberCountWithStripeSeatPlan,
} from '@documenso/ee/server-only/stripe/update-subscription-item-quantity';
import { prisma } from '@documenso/prisma';
import type { OrganisationGroup, OrganisationMemberRole } from '@prisma/client';
import { OrganisationGroupType, OrganisationMemberInviteStatus, SubscriptionStatus } from '@prisma/client';

import { IS_BILLING_ENABLED } from '../../constants/app';
import { AppError, AppErrorCode } from '../../errors/app-error';
import { jobs } from '../../jobs/client';
import { generateDatabaseId } from '../../universal/id';

export type AcceptOrganisationInvitationOptions = {
  token: string;
};

/**
 * Accept an organisation invitation for the account which holds the invited
 * email address.
 *
 * Accepting an invitation grants organisation membership and nothing else: the
 * account profile (`User.roles`) is deliberately not written here.
 *
 * - A restricted account (SIGN_ONLY) is not promoted by joining an
 *   organisation, so an invitation is not a way to obtain a wider profile.
 * - An account which already holds a wider profile is not narrowed by the
 *   organisation role carried by the invitation, so accepting it never
 *   downgrades an administrator.
 * - No personal organisation or team is created: an invited account joins the
 *   organisation of the invitation, and a restricted account is expected to
 *   start without a workspace of its own.
 *
 * Widening or narrowing a profile stays an explicit administrative action.
 */
export const acceptOrganisationInvitation = async ({ token }: AcceptOrganisationInvitationOptions) => {
  const organisationMemberInvite = await prisma.organisationMemberInvite.findFirst({
    where: {
      token,
      status: {
        not: OrganisationMemberInviteStatus.DECLINED,
      },
    },
    include: {
      organisation: {
        include: {
          groups: true,
          organisationClaim: true,
          subscription: true,
          members: {
            select: {
              id: true,
            },
          },
        },
      },
    },
  });

  if (!organisationMemberInvite) {
    throw new AppError(AppErrorCode.NOT_FOUND);
  }

  if (organisationMemberInvite.status === OrganisationMemberInviteStatus.ACCEPTED) {
    return;
  }

  const user = await prisma.user.findFirst({
    where: {
      email: {
        equals: organisationMemberInvite.email,
        mode: 'insensitive',
      },
    },
    select: {
      id: true,
    },
  });

  if (!user) {
    throw new AppError(AppErrorCode.NOT_FOUND, {
      message: 'User must exist to accept an organisation invitation',
    });
  }

  const { organisation } = organisationMemberInvite;

  const isUserPartOfOrganisation = await prisma.organisationMember.findFirst({
    where: {
      userId: user.id,
      organisationId: organisation.id,
    },
  });

  if (isUserPartOfOrganisation) {
    return;
  }

  const newMemberCount = organisation.members.length + 1;

  // Billing occurs when a user accepts an invite.
  // Assert that the new member count is within the cap and sync the seat plan with Stripe.
  if (IS_BILLING_ENABLED()) {
    const { subscription, organisationClaim } = organisation;

    // A canceled subscription cannot have its seat quantity updated in Stripe,
    // and an organisation with lapsed billing should not gain new members.
    // Throw a deliberate error so the invite page can render an accurate
    // message instead of an opaque Stripe failure.
    if (subscription && subscription.status === SubscriptionStatus.INACTIVE) {
      throw new AppError('SUBSCRIPTION_INACTIVE', {
        message: 'The organisation subscription is inactive',
      });
    }

    // Organisations can exist without a subscription (e.g. after being
    // downgraded to the free plan). The claim cap remains authoritative in
    // that case, surfacing LIMIT_EXCEEDED instead of an opaque "subscription
    // not found" error.
    await assertMemberCountWithinCap(subscription, organisationClaim, newMemberCount);

    if (subscription) {
      await syncMemberCountWithStripeSeatPlan(subscription, organisationClaim, newMemberCount, 'grow');
    }
  }

  // Todo: Logging
  /**
   * Membership only: the account profile is left as it is, so a restricted
   * account keeps its restriction and an administrator is not narrowed by the
   * organisation role of the invitation.
   */
  await addUserToOrganisation({
    userId: user.id,
    organisationId: organisation.id,
    organisationGroups: organisation.groups,
    organisationMemberRole: organisationMemberInvite.organisationRole,
  });

  await prisma.organisationMemberInvite.update({
    where: {
      id: organisationMemberInvite.id,
    },
    data: {
      status: OrganisationMemberInviteStatus.ACCEPTED,
    },
  });
};

export const addUserToOrganisation = async ({
  userId,
  organisationId,
  organisationGroups,
  organisationMemberRole,
  bypassEmail = false,
}: {
  userId: number;
  organisationId: string;
  organisationGroups: OrganisationGroup[];
  organisationMemberRole: OrganisationMemberRole;
  bypassEmail?: boolean;
}) => {
  const organisationGroupToUse = organisationGroups.find(
    (group) =>
      group.type === OrganisationGroupType.INTERNAL_ORGANISATION && group.organisationRole === organisationMemberRole,
  );

  if (!organisationGroupToUse) {
    throw new AppError(AppErrorCode.UNKNOWN_ERROR, {
      message: 'Organisation group not found',
    });
  }

  await prisma.organisationMember.create({
    data: {
      id: generateDatabaseId('member'),
      userId,
      organisationId,
      organisationGroupMembers: {
        create: {
          id: generateDatabaseId('group_member'),
          groupId: organisationGroupToUse.id,
        },
      },
    },
  });

  if (!bypassEmail) {
    await jobs.triggerJob({
      name: 'send.organisation-member-joined.email',
      payload: {
        organisationId,
        memberUserId: userId,
      },
    });
  }
};
