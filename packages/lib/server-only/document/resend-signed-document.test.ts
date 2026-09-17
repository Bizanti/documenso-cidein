import { OrganisationMemberRole, TeamMemberRole } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { getSignedDocumentResendCc } from './resend-signed-document';

vi.mock('@documenso/prisma', () => ({ prisma: {} }));
vi.mock('../../client-only/providers/i18n-server', () => ({ getI18nInstance: vi.fn() }));

const teamMember = (email: string, teamRole: TeamMemberRole, name: string | null = null) => ({
  id: `org_member_${email}`,
  userId: 1,
  createdAt: new Date(),
  email,
  name,
  avatarImageId: null,
  teamRole,
  organisationRole: OrganisationMemberRole.MEMBER,
});

describe('getSignedDocumentResendCc', () => {
  it('copies the team members holding the SGC role', () => {
    const cc = getSignedDocumentResendCc({
      teamMembers: [
        teamMember('admin@example.com', TeamMemberRole.ADMIN),
        teamMember('sgc@example.com', TeamMemberRole.SGC, 'SGC Person'),
        teamMember('manager@example.com', TeamMemberRole.MANAGER),
        teamMember('member@example.com', TeamMemberRole.MEMBER),
      ],
      recipientEmails: ['signer@example.com'],
    });

    expect(cc).toEqual([{ address: 'sgc@example.com', name: 'SGC Person' }]);
  });

  it('does not copy addresses that already receive the email', () => {
    const cc = getSignedDocumentResendCc({
      teamMembers: [teamMember('SGC@example.com', TeamMemberRole.SGC)],
      recipientEmails: ['sgc@example.com'],
    });

    expect(cc).toEqual([]);
  });

  it('de-duplicates repeated SGC addresses', () => {
    const cc = getSignedDocumentResendCc({
      teamMembers: [
        teamMember('sgc@example.com', TeamMemberRole.SGC),
        teamMember('sgc@example.com', TeamMemberRole.SGC),
      ],
      recipientEmails: [],
    });

    expect(cc).toHaveLength(1);
  });

  it('returns an empty list when the team has no SGC members', () => {
    const cc = getSignedDocumentResendCc({
      teamMembers: [teamMember('admin@example.com', TeamMemberRole.ADMIN)],
      recipientEmails: ['signer@example.com'],
    });

    expect(cc).toEqual([]);
  });
});
