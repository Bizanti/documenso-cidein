import { OrganisationGroupType, OrganisationMemberInviteStatus, OrganisationMemberRole, Role } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { acceptOrganisationInvitation } from './accept-organisation-invitation';

const mocks = vi.hoisted(() => ({
  prisma: {
    organisationMemberInvite: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    organisationMember: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    user: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    organisation: {
      create: vi.fn(),
    },
    team: {
      create: vi.fn(),
    },
  },
  triggerJob: vi.fn(),
}));

vi.mock('@documenso/prisma', () => ({ prisma: mocks.prisma }));
vi.mock('../../jobs/client', () => ({ jobs: { triggerJob: mocks.triggerJob } }));
vi.mock('@documenso/ee/server-only/stripe/update-subscription-item-quantity', () => ({
  assertMemberCountWithinCap: vi.fn(),
  syncMemberCountWithStripeSeatPlan: vi.fn(),
}));

const MEMBER_GROUP_ID = 'group_member';
const ADMIN_GROUP_ID = 'group_admin';

const buildInvitation = (organisationRole: OrganisationMemberRole = OrganisationMemberRole.MEMBER) => {
  mocks.prisma.organisationMemberInvite.findFirst.mockResolvedValue({
    id: 'invite_1',
    email: 'signer@example.com',
    organisationId: 'org_1',
    organisationRole,
    status: OrganisationMemberInviteStatus.PENDING,
    organisation: {
      id: 'org_1',
      groups: [
        {
          id: MEMBER_GROUP_ID,
          name: null,
          type: OrganisationGroupType.INTERNAL_ORGANISATION,
          organisationRole: OrganisationMemberRole.MEMBER,
          organisationId: 'org_1',
        },
        {
          id: ADMIN_GROUP_ID,
          name: null,
          type: OrganisationGroupType.INTERNAL_ORGANISATION,
          organisationRole: OrganisationMemberRole.ADMIN,
          organisationId: 'org_1',
        },
      ],
      organisationClaim: {},
      subscription: null,
      members: [{ id: 'member_0' }],
    },
  });
};

const buildInvitee = (roles: Role[]) => {
  mocks.prisma.user.findFirst.mockResolvedValue({
    id: 7,
    roles,
  });
};

const getCreatedMembership = () => mocks.prisma.organisationMember.create.mock.calls[0][0].data;

describe('acceptOrganisationInvitation', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    buildInvitation();

    mocks.prisma.user.findFirst.mockResolvedValue({ id: 7, roles: [Role.USER] });
    mocks.prisma.organisationMember.findFirst.mockResolvedValue(null);
    mocks.prisma.organisationMember.create.mockResolvedValue({ id: 'member_1' });
    mocks.prisma.organisationMemberInvite.update.mockResolvedValue({});
  });

  it('does not promote a restricted account when it accepts an invitation', async () => {
    buildInvitee([Role.SIGN_ONLY]);

    await acceptOrganisationInvitation({ token: 'token_1' });

    expect(mocks.prisma.user.update).not.toHaveBeenCalled();
    expect(mocks.prisma.organisationMember.create).toHaveBeenCalledTimes(1);
    expect(getCreatedMembership().userId).toBe(7);
  });

  it('does not degrade an account which already holds a wider profile', async () => {
    buildInvitee([Role.USER, Role.ADMIN]);

    await acceptOrganisationInvitation({ token: 'token_1' });

    expect(mocks.prisma.user.update).not.toHaveBeenCalled();
    expect(mocks.prisma.organisationMember.create).toHaveBeenCalledTimes(1);
  });

  it('grants the organisation role of the invitation, not the profile of the account', async () => {
    buildInvitee([Role.SIGN_ONLY]);

    await acceptOrganisationInvitation({ token: 'token_1' });

    expect(getCreatedMembership().id).toBeTruthy();
    expect(getCreatedMembership().organisationId).toBe('org_1');
    expect(getCreatedMembership().organisationGroupMembers.create.groupId).toBe(MEMBER_GROUP_ID);
  });

  it('does not create a personal organisation or team when it accepts an invitation', async () => {
    buildInvitee([Role.SIGN_ONLY]);

    await acceptOrganisationInvitation({ token: 'token_1' });

    expect(mocks.prisma.organisation.create).not.toHaveBeenCalled();
    expect(mocks.prisma.team.create).not.toHaveBeenCalled();
  });

  it('does nothing when the account is already a member', async () => {
    buildInvitee([Role.SIGN_ONLY]);

    mocks.prisma.organisationMember.findFirst.mockResolvedValue({ id: 'member_1' });

    await acceptOrganisationInvitation({ token: 'token_1' });

    expect(mocks.prisma.organisationMember.create).not.toHaveBeenCalled();
    expect(mocks.prisma.user.update).not.toHaveBeenCalled();
  });
});
