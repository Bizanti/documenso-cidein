import { DocumentStatus, OrganisationMemberRole, RecipientRole, TeamMemberRole } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApiRequestMetadata } from '../../universal/extract-request-metadata';
import {
  getResendSignedDocumentSkipReason,
  getSignedDocumentResendCc,
  resendSignedDocument,
} from './resend-signed-document';

const mocks = vi.hoisted(() => ({
  prisma: {
    user: {
      findFirstOrThrow: vi.fn(),
    },
    envelope: {
      findUnique: vi.fn(),
    },
    documentAuditLog: {
      create: vi.fn(),
    },
  },
  getEnvelopeWhereInput: vi.fn(),
  getTeamById: vi.fn(),
  getTeamMembers: vi.fn(),
  getEmailContext: vi.fn(),
  getFileServerSide: vi.fn(),
  renderEmailWithI18N: vi.fn(),
  assertOrganisationRatesAndLimits: vi.fn(),
  sendMail: vi.fn(),
}));

vi.mock('@documenso/prisma', () => ({ prisma: mocks.prisma }));
vi.mock('../../client-only/providers/i18n-server', () => ({
  getI18nInstance: vi.fn(async () => ({
    _: (descriptor: { message?: string; id: string }) => descriptor.message ?? descriptor.id,
  })),
}));
vi.mock('../../universal/upload/get-file.server', () => ({ getFileServerSide: mocks.getFileServerSide }));
vi.mock('../../utils/render-email-with-i18n', () => ({ renderEmailWithI18N: mocks.renderEmailWithI18N }));
vi.mock('../email/get-email-context', () => ({ getEmailContext: mocks.getEmailContext }));
vi.mock('../envelope/get-envelope-by-id', () => ({ getEnvelopeWhereInput: mocks.getEnvelopeWhereInput }));
vi.mock('../rate-limit/assert-organisation-rates-and-limits', () => ({
  assertOrganisationRatesAndLimits: mocks.assertOrganisationRatesAndLimits,
}));
vi.mock('../team/get-team', () => ({ getTeamById: mocks.getTeamById }));
vi.mock('../team/get-team-members', () => ({ getTeamMembers: mocks.getTeamMembers }));

const teamMember = (
  email: string,
  teamRole: TeamMemberRole,
  name: string | null = null,
  organisationRole: OrganisationMemberRole = OrganisationMemberRole.MEMBER,
) => ({
  id: `org_member_${email}`,
  userId: 1,
  createdAt: new Date(),
  email,
  name,
  avatarImageId: null,
  teamRole,
  organisationRole,
});

const requestMetadata: ApiRequestMetadata = {
  requestMetadata: {
    ipAddress: '127.0.0.1',
    userAgent: 'vitest',
  },
  source: 'app',
  auth: 'session',
};

const user = {
  id: 1,
  email: 'owner@example.com',
  name: 'Owner',
  disabled: false,
};

const recipient = {
  id: 1,
  email: 'signer@example.com',
  name: 'Signer',
  role: RecipientRole.SIGNER,
  token: 'recipient_token',
};

const envelope = {
  id: 'envelope_1',
  userId: user.id,
  teamId: 1,
  title: '[TEST] Resend signed document',
  internalVersion: 2,
  status: DocumentStatus.COMPLETED,
  completedAt: new Date('2026-01-01T12:00:00.000Z'),
  documentMeta: null,
  recipients: [recipient],
  envelopeItems: [
    {
      id: 'envelope_item_1',
      title: 'Envelope item',
      documentData: {
        id: 'document_data_1',
        type: 'BYTES_64',
        data: '',
      },
    },
  ],
  team: {
    id: 1,
    name: 'Team',
    url: 'team',
    teamEmail: null,
  },
};

const emailContext = {
  branding: {},
  settings: {},
  claims: { flags: {} },
  allowedEmails: [],
  emailsDisabled: false,
  organisationId: 'organisation_1',
  organisationType: 'ORGANISATION',
  senderEmail: {
    name: 'Documenso',
    address: 'no-reply@example.com',
  },
  replyToEmail: undefined,
  emailLanguage: 'en',
  emailTransport: {
    sendMail: mocks.sendMail,
  },
};

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

  it('copies the organisation members holding the SGC role', () => {
    const cc = getSignedDocumentResendCc({
      teamMembers: [
        teamMember('team-sgc@example.com', TeamMemberRole.SGC, 'Team SGC'),
        teamMember('org-sgc@example.com', TeamMemberRole.MEMBER, 'Organisation SGC', OrganisationMemberRole.SGC),
        teamMember(
          'org-manager@example.com',
          TeamMemberRole.MEMBER,
          'Organisation Manager',
          OrganisationMemberRole.MANAGER,
        ),
      ],
      recipientEmails: ['signer@example.com'],
    });

    expect(cc).toEqual([
      { address: 'team-sgc@example.com', name: 'Team SGC' },
      { address: 'org-sgc@example.com', name: 'Organisation SGC' },
    ]);
  });

  it('de-duplicates an address that holds both the team and the organisation SGC role', () => {
    const cc = getSignedDocumentResendCc({
      teamMembers: [
        teamMember('sgc@example.com', TeamMemberRole.SGC),
        teamMember('sgc@example.com', TeamMemberRole.MEMBER, null, OrganisationMemberRole.SGC),
      ],
      recipientEmails: [],
    });

    expect(cc).toHaveLength(1);
  });

  it('does not copy organisation admins and managers', () => {
    const cc = getSignedDocumentResendCc({
      teamMembers: [
        teamMember('org-admin@example.com', TeamMemberRole.MEMBER, null, OrganisationMemberRole.ADMIN),
        teamMember('org-manager@example.com', TeamMemberRole.MEMBER, null, OrganisationMemberRole.MANAGER),
      ],
      recipientEmails: [],
    });

    expect(cc).toEqual([]);
  });
});

describe('getResendSignedDocumentSkipReason', () => {
  it('skips the resend when emails are disabled, even with sendable recipients', () => {
    const reason = getResendSignedDocumentSkipReason({
      emailsDisabled: true,
      recipients: [{ email: 'signer@example.com' }],
    });

    expect(reason).toEqual('EMAILS_DISABLED');
  });

  it('skips the resend when no recipient has a sendable address', () => {
    const reason = getResendSignedDocumentSkipReason({
      emailsDisabled: false,
      recipients: [{ email: 'not-an-email' }, { email: '' }],
    });

    expect(reason).toEqual('NO_SENDABLE_RECIPIENTS');
  });

  it('does not skip the resend when at least one recipient can be delivered to', () => {
    const reason = getResendSignedDocumentSkipReason({
      emailsDisabled: false,
      recipients: [{ email: 'not-an-email' }, { email: 'signer@example.com' }],
    });

    expect(reason).toBeNull();
  });
});

describe('resendSignedDocument', () => {
  const resendOptions = {
    id: { type: 'documentId', id: 1 } as const,
    userId: user.id,
    teamId: envelope.teamId,
    recipientIds: [recipient.id],
    requestMetadata,
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mocks.prisma.user.findFirstOrThrow.mockResolvedValue(user);
    mocks.getEnvelopeWhereInput.mockResolvedValue({ envelopeWhereInput: { id: envelope.id } });
    mocks.prisma.envelope.findUnique.mockResolvedValue(envelope);
    mocks.getTeamById.mockResolvedValue({ currentTeamRole: TeamMemberRole.ADMIN });
    mocks.getTeamMembers.mockResolvedValue([]);
    mocks.getEmailContext.mockResolvedValue(emailContext);
    mocks.getFileServerSide.mockResolvedValue(new Uint8Array([1, 2, 3]));
    mocks.renderEmailWithI18N.mockResolvedValue('<html></html>');
  });

  it('reports the resend as not sent and logs nothing when the organisation has emails disabled', async () => {
    mocks.getEmailContext.mockResolvedValue({ ...emailContext, emailsDisabled: true });

    const result = await resendSignedDocument(resendOptions);

    expect(result).toEqual({ sent: false, reason: 'EMAILS_DISABLED' });

    expect(mocks.sendMail).not.toHaveBeenCalled();
    expect(mocks.prisma.documentAuditLog.create).not.toHaveBeenCalled();
    // Nothing is rendered or reserved when no email can go out.
    expect(mocks.getFileServerSide).not.toHaveBeenCalled();
    expect(mocks.assertOrganisationRatesAndLimits).not.toHaveBeenCalled();
  });

  it('reports the resend as not sent and logs nothing when no recipient can receive email', async () => {
    mocks.prisma.envelope.findUnique.mockResolvedValue({
      ...envelope,
      recipients: [{ ...recipient, email: 'not-an-email' }],
    });

    const result = await resendSignedDocument(resendOptions);

    expect(result).toEqual({ sent: false, reason: 'NO_SENDABLE_RECIPIENTS' });

    expect(mocks.sendMail).not.toHaveBeenCalled();
    expect(mocks.prisma.documentAuditLog.create).not.toHaveBeenCalled();
  });

  it('copies the organisation SGC members on the delivery', async () => {
    mocks.getTeamMembers.mockResolvedValue([
      teamMember('org-sgc@example.com', TeamMemberRole.MEMBER, 'Organisation SGC', OrganisationMemberRole.SGC),
    ]);

    const result = await resendSignedDocument(resendOptions);

    expect(result).toEqual({ sent: true });

    expect(mocks.sendMail.mock.calls[0][0]).toMatchObject({
      cc: [{ address: 'org-sgc@example.com', name: 'Organisation SGC' }],
    });
  });

  it('sends the document and logs the delivery when emails are enabled', async () => {
    const result = await resendSignedDocument({
      ...resendOptions,
      message: 'Please find the signed copy attached.',
    });

    expect(result).toEqual({ sent: true });

    expect(mocks.sendMail).toHaveBeenCalledTimes(1);
    expect(mocks.sendMail.mock.calls[0][0]).toMatchObject({
      to: [{ address: recipient.email, name: recipient.name }],
    });

    expect(mocks.prisma.documentAuditLog.create).toHaveBeenCalledTimes(1);
    expect(mocks.prisma.documentAuditLog.create.mock.calls[0][0]).toMatchObject({
      data: {
        envelopeId: envelope.id,
        type: 'EMAIL_SENT',
        data: {
          emailType: 'DOCUMENT_COMPLETED',
          recipientEmail: recipient.email,
          recipientId: recipient.id,
          isResending: true,
        },
      },
    });
  });
});
