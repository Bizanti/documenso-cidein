import { DocumentStatus, OrganisationMemberRole, RecipientRole, Role, TeamMemberRole } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getDownloadWindowHours } from '../site-settings/get-download-window-hours';
import { getMemberOrganisationRole } from '../team/get-member-roles';
import { getTeamById } from '../team/get-team';
import {
  buildEnvelopeDownloadPolicy,
  canDownloadDocument,
  DOWNLOAD_DENIAL_REASON,
  getDownloadWindowExpiresAt,
  getEnvelopeDownloadPolicy,
  getEnvelopeItemDownloadDenial,
  getEnvelopeItemViewDenial,
  getRecipientDownloadPolicy,
  getUserDownloadPolicy,
  isDownloadWindowExpired,
  isFinalDocumentStatus,
  toDownloadVersion,
} from './download-policy';

const mocks = vi.hoisted(() => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock('@documenso/prisma', () => ({ prisma: mocks.prisma }));
vi.mock('../site-settings/get-download-window-hours');
vi.mock('../team/get-member-roles');
vi.mock('../team/get-team');

const HOUR_IN_MS = 60 * 60 * 1000;

const completedAt = new Date('2026-01-01T12:00:00.000Z');

const hoursAfter = (date: Date, hours: number) => new Date(date.getTime() + hours * HOUR_IN_MS);

describe('isFinalDocumentStatus', () => {
  it('treats completed and rejected envelopes as final', () => {
    expect(isFinalDocumentStatus(DocumentStatus.COMPLETED)).toBe(true);
    expect(isFinalDocumentStatus(DocumentStatus.REJECTED)).toBe(true);
  });

  it('does not treat in-flight envelopes as final', () => {
    expect(isFinalDocumentStatus(DocumentStatus.DRAFT)).toBe(false);
    expect(isFinalDocumentStatus(DocumentStatus.PENDING)).toBe(false);
    expect(isFinalDocumentStatus(DocumentStatus.CANCELLED)).toBe(false);
  });
});

describe('getDownloadWindowExpiresAt', () => {
  it('returns null when downloads do not expire', () => {
    expect(getDownloadWindowExpiresAt({ completedAt, windowHours: null })).toBeNull();
  });

  it('returns null when the envelope has not finished yet', () => {
    expect(getDownloadWindowExpiresAt({ completedAt: null, windowHours: 48 })).toBeNull();
  });

  it('adds the window to the completion date', () => {
    expect(getDownloadWindowExpiresAt({ completedAt, windowHours: 48 })).toEqual(hoursAfter(completedAt, 48));
  });
});

describe('isDownloadWindowExpired', () => {
  it('is false before the window elapses and true at the boundary', () => {
    expect(
      isDownloadWindowExpired({
        status: DocumentStatus.COMPLETED,
        completedAt,
        windowHours: 48,
        now: hoursAfter(completedAt, 47),
      }),
    ).toBe(false);

    expect(
      isDownloadWindowExpired({
        status: DocumentStatus.COMPLETED,
        completedAt,
        windowHours: 48,
        now: hoursAfter(completedAt, 48),
      }),
    ).toBe(true);
  });

  it('never expires in-flight envelopes', () => {
    expect(
      isDownloadWindowExpired({
        status: DocumentStatus.PENDING,
        completedAt,
        windowHours: 1,
        now: hoursAfter(completedAt, 100),
      }),
    ).toBe(false);
  });

  it('never expires when there is no window', () => {
    expect(
      isDownloadWindowExpired({
        status: DocumentStatus.COMPLETED,
        completedAt,
        windowHours: null,
        now: hoursAfter(completedAt, 1000),
      }),
    ).toBe(false);
  });
});

describe('buildEnvelopeDownloadPolicy', () => {
  it('restricts downloads to ADMIN and SGC once the window has elapsed', () => {
    const now = hoursAfter(completedAt, 49);

    const forMember = buildEnvelopeDownloadPolicy({
      status: DocumentStatus.COMPLETED,
      completedAt,
      windowHours: 48,
      role: TeamMemberRole.MEMBER,
      now,
    });

    expect(forMember).toMatchObject({
      isDownloadWindowExpired: true,
      canDownloadSigned: false,
      canDownloadOriginal: false,
    });

    const forManager = buildEnvelopeDownloadPolicy({
      status: DocumentStatus.COMPLETED,
      completedAt,
      windowHours: 48,
      role: TeamMemberRole.MANAGER,
      now,
    });

    expect(forManager.canDownloadSigned).toBe(false);

    const forAdmin = buildEnvelopeDownloadPolicy({
      status: DocumentStatus.COMPLETED,
      completedAt,
      windowHours: 48,
      role: TeamMemberRole.ADMIN,
      now,
    });

    expect(forAdmin).toMatchObject({
      isDownloadWindowExpired: true,
      canDownloadSigned: true,
      canDownloadOriginal: true,
      isSgcPrivileged: true,
    });

    const forSgc = buildEnvelopeDownloadPolicy({
      status: DocumentStatus.COMPLETED,
      completedAt,
      windowHours: 48,
      role: TeamMemberRole.SGC,
      now,
    });

    expect(forSgc).toMatchObject({
      isDownloadWindowExpired: true,
      canDownloadSigned: true,
      canDownloadOriginal: true,
      isSgcPrivileged: true,
    });
  });

  it('only offers the signed copy to non-privileged members once a final copy exists', () => {
    const policy = buildEnvelopeDownloadPolicy({
      status: DocumentStatus.COMPLETED,
      completedAt,
      windowHours: 48,
      role: TeamMemberRole.MEMBER,
      now: hoursAfter(completedAt, 1),
    });

    expect(policy).toMatchObject({
      isDownloadWindowExpired: false,
      canDownloadSigned: true,
      canDownloadOriginal: false,
    });
  });

  it('never offers the original to recipients of a final document', () => {
    const policy = buildEnvelopeDownloadPolicy({
      status: DocumentStatus.COMPLETED,
      completedAt,
      windowHours: 48,
      role: null,
      now: hoursAfter(completedAt, 49),
    });

    expect(policy).toMatchObject({
      canDownloadSigned: false,
      canDownloadOriginal: false,
      isSgcPrivileged: false,
    });
  });

  it('keeps the working copy downloadable while the document is not final', () => {
    const policy = buildEnvelopeDownloadPolicy({
      status: DocumentStatus.PENDING,
      completedAt: null,
      windowHours: 48,
      role: null,
    });

    expect(policy).toMatchObject({
      isDownloadWindowExpired: false,
      canDownloadSigned: true,
      canDownloadOriginal: true,
    });
  });

  it('does not expire downloads when the window is null', () => {
    const policy = buildEnvelopeDownloadPolicy({
      status: DocumentStatus.COMPLETED,
      completedAt,
      windowHours: null,
      role: TeamMemberRole.MEMBER,
      now: hoursAfter(completedAt, 100000),
    });

    expect(policy).toMatchObject({
      downloadWindowHours: null,
      downloadWindowExpiresAt: null,
      isDownloadWindowExpired: false,
      canDownloadSigned: true,
      canDownloadOriginal: false,
    });
  });
});

describe('getEnvelopeDownloadPolicy', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('prefers the document override over the global setting', async () => {
    vi.mocked(getDownloadWindowHours).mockResolvedValue(24);

    const policy = await getEnvelopeDownloadPolicy({
      status: DocumentStatus.COMPLETED,
      completedAt,
      downloadWindowHours: 48,
      role: TeamMemberRole.MEMBER,
    });

    expect(policy.downloadWindowHours).toBe(48);
    expect(policy.downloadWindowExpiresAt).toEqual(hoursAfter(completedAt, 48));
  });

  it('falls back to the global setting when there is no override', async () => {
    vi.mocked(getDownloadWindowHours).mockResolvedValue(24);

    const policy = await getEnvelopeDownloadPolicy({
      status: DocumentStatus.COMPLETED,
      completedAt,
      downloadWindowHours: null,
      role: TeamMemberRole.MEMBER,
    });

    expect(policy.downloadWindowHours).toBe(24);
    expect(policy.downloadWindowExpiresAt).toEqual(hoursAfter(completedAt, 24));
  });

  it('does not expire downloads when the global setting is disabled', async () => {
    vi.mocked(getDownloadWindowHours).mockResolvedValue(null);

    const policy = await getEnvelopeDownloadPolicy({
      status: DocumentStatus.COMPLETED,
      completedAt,
      role: TeamMemberRole.MEMBER,
    });

    expect(policy.downloadWindowHours).toBeNull();
    expect(policy.isDownloadWindowExpired).toBe(false);
    expect(policy.canDownloadSigned).toBe(true);
  });
});

describe('getUserDownloadPolicy', () => {
  beforeEach(() => {
    vi.resetAllMocks();

    // An unrestricted account by default, which is what the window and privilege
    // rules below are about.
    mocks.prisma.user.findUnique.mockResolvedValue({ roles: [Role.USER] });
  });

  const mockTeamRole = (
    role: TeamMemberRole,
    organisationRole: OrganisationMemberRole = OrganisationMemberRole.MEMBER,
  ) => {
    vi.mocked(getTeamById).mockResolvedValue({
      currentTeamRole: role,
      organisationId: 'organisation_1',
    } as unknown as Awaited<ReturnType<typeof getTeamById>>);

    vi.mocked(getMemberOrganisationRole).mockResolvedValue(organisationRole);
  };

  it('keeps the original and post-window access for ADMIN and SGC', async () => {
    vi.mocked(getDownloadWindowHours).mockResolvedValue(1);

    mockTeamRole(TeamMemberRole.SGC);

    const policy = await getUserDownloadPolicy({
      userId: 1,
      teamId: 1,
      status: DocumentStatus.COMPLETED,
      completedAt,
      now: hoursAfter(completedAt, 49),
    });

    expect(policy).toMatchObject({
      isDownloadWindowExpired: true,
      isSgcPrivileged: true,
      canDownloadSigned: true,
      canDownloadOriginal: true,
    });
  });

  it('keeps the original and post-window access for an organisation SGC member with a lower team role', async () => {
    vi.mocked(getDownloadWindowHours).mockResolvedValue(1);

    mockTeamRole(TeamMemberRole.MEMBER, OrganisationMemberRole.SGC);

    const policy = await getUserDownloadPolicy({
      userId: 1,
      teamId: 1,
      status: DocumentStatus.COMPLETED,
      completedAt,
      now: hoursAfter(completedAt, 49),
    });

    expect(policy).toMatchObject({
      isDownloadWindowExpired: true,
      isSgcPrivileged: true,
      canDownloadSigned: true,
      canDownloadOriginal: true,
    });
  });

  it('keeps the original and post-window access for an organisation admin', async () => {
    vi.mocked(getDownloadWindowHours).mockResolvedValue(1);

    mockTeamRole(TeamMemberRole.MEMBER, OrganisationMemberRole.ADMIN);

    const policy = await getUserDownloadPolicy({
      userId: 1,
      teamId: 1,
      status: DocumentStatus.COMPLETED,
      completedAt,
      now: hoursAfter(completedAt, 49),
    });

    expect(policy).toMatchObject({
      isSgcPrivileged: true,
      canDownloadSigned: true,
      canDownloadOriginal: true,
    });
  });

  it('restricts organisation managers and members without the SGC privileges', async () => {
    vi.mocked(getDownloadWindowHours).mockResolvedValue(1);

    for (const organisationRole of [OrganisationMemberRole.MANAGER, OrganisationMemberRole.MEMBER]) {
      mockTeamRole(TeamMemberRole.MEMBER, organisationRole);

      const policy = await getUserDownloadPolicy({
        userId: 1,
        teamId: 1,
        status: DocumentStatus.COMPLETED,
        completedAt,
        now: hoursAfter(completedAt, 49),
      });

      expect(policy).toMatchObject({
        isSgcPrivileged: false,
        canDownloadSigned: false,
        canDownloadOriginal: false,
      });
    }
  });

  it('treats users without an organisation role as non privileged', async () => {
    vi.mocked(getDownloadWindowHours).mockResolvedValue(1);

    mockTeamRole(TeamMemberRole.MEMBER);
    vi.mocked(getMemberOrganisationRole).mockRejectedValue(new Error('Roles not found'));

    const policy = await getUserDownloadPolicy({
      userId: 1,
      teamId: 1,
      status: DocumentStatus.COMPLETED,
      completedAt,
      now: hoursAfter(completedAt, 49),
    });

    expect(policy).toMatchObject({
      isSgcPrivileged: false,
      canDownloadSigned: false,
      canDownloadOriginal: false,
    });
  });

  it('restricts non privileged team roles', async () => {
    vi.mocked(getDownloadWindowHours).mockResolvedValue(1);

    mockTeamRole(TeamMemberRole.MANAGER);

    const expiredPolicy = await getUserDownloadPolicy({
      userId: 1,
      teamId: 1,
      status: DocumentStatus.COMPLETED,
      completedAt,
      now: hoursAfter(completedAt, 49),
    });

    expect(expiredPolicy).toMatchObject({
      isDownloadWindowExpired: true,
      canDownloadSigned: false,
      canDownloadOriginal: false,
    });

    vi.mocked(getDownloadWindowHours).mockResolvedValue(48);

    const activePolicy = await getUserDownloadPolicy({
      userId: 1,
      teamId: 1,
      status: DocumentStatus.COMPLETED,
      completedAt,
      now: hoursAfter(completedAt, 1),
    });

    expect(activePolicy).toMatchObject({
      isDownloadWindowExpired: false,
      canDownloadSigned: true,
      canDownloadOriginal: false,
    });
  });

  it('treats users outside the envelope team as non privileged', async () => {
    vi.mocked(getDownloadWindowHours).mockResolvedValue(null);
    vi.mocked(getTeamById).mockRejectedValue(new Error('Team not found'));

    const policy = await getUserDownloadPolicy({
      userId: 1,
      teamId: 1,
      status: DocumentStatus.COMPLETED,
      completedAt,
    });

    expect(policy).toMatchObject({
      isSgcPrivileged: false,
      canDownloadOriginal: false,
    });
  });

  it('keeps the working copy available while the document is not final', async () => {
    vi.mocked(getDownloadWindowHours).mockResolvedValue(1);

    mockTeamRole(TeamMemberRole.MEMBER);

    const policy = await getUserDownloadPolicy({
      userId: 1,
      teamId: 1,
      status: DocumentStatus.PENDING,
      completedAt: null,
    });

    expect(policy).toMatchObject({
      canDownloadSigned: true,
      canDownloadOriginal: true,
    });
  });

  it('closes the downloads of a sign only account, with the roles read fresh from the database', async () => {
    vi.mocked(getDownloadWindowHours).mockResolvedValue(null);

    // Even a privileged team role does not reopen them.
    mockTeamRole(TeamMemberRole.SGC);

    mocks.prisma.user.findUnique.mockResolvedValue({ roles: [Role.SIGN_ONLY] });

    const policy = await getUserDownloadPolicy({
      userId: 1,
      teamId: 1,
      status: DocumentStatus.COMPLETED,
      completedAt,
    });

    expect(mocks.prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 1 },
      select: { roles: true },
    });

    expect(policy.isAccountDownloadBlocked).toBe(true);
    expect(getEnvelopeItemDownloadDenial({ version: 'signed', policy })).toBe(
      DOWNLOAD_DENIAL_REASON.ACCOUNT_DOWNLOAD_FORBIDDEN,
    );
    expect(getEnvelopeItemDownloadDenial({ version: 'original', policy })).toBe(
      DOWNLOAD_DENIAL_REASON.ACCOUNT_DOWNLOAD_FORBIDDEN,
    );
  });

  it('treats an invalid role combination as restricted', async () => {
    vi.mocked(getDownloadWindowHours).mockResolvedValue(null);

    mockTeamRole(TeamMemberRole.ADMIN);

    mocks.prisma.user.findUnique.mockResolvedValue({ roles: [Role.USER, Role.SIGN_ONLY] });

    const policy = await getUserDownloadPolicy({
      userId: 1,
      teamId: 1,
      status: DocumentStatus.PENDING,
      completedAt: null,
    });

    expect(policy.isAccountDownloadBlocked).toBe(true);
  });

  it('closes the downloads when the account no longer exists', async () => {
    vi.mocked(getDownloadWindowHours).mockResolvedValue(null);

    mockTeamRole(TeamMemberRole.ADMIN);

    mocks.prisma.user.findUnique.mockResolvedValue(null);

    const policy = await getUserDownloadPolicy({
      userId: 1,
      teamId: 1,
      status: DocumentStatus.PENDING,
      completedAt: null,
    });

    expect(policy.isAccountDownloadBlocked).toBe(true);
  });

  it('keeps the viewer open for a restricted account', async () => {
    vi.mocked(getDownloadWindowHours).mockResolvedValue(null);

    mockTeamRole(TeamMemberRole.SGC);

    mocks.prisma.user.findUnique.mockResolvedValue({ roles: [Role.SIGN_ONLY] });

    const policy = await getUserDownloadPolicy({
      userId: 1,
      teamId: 1,
      status: DocumentStatus.PENDING,
      completedAt: null,
    });

    // The download is closed, the rendering used to sign is not: what the viewer
    // shows can still be kept by whoever sees it, which is why the block lives on
    // the download and export routes instead.
    expect(getEnvelopeItemDownloadDenial({ version: 'signed', policy })).toBe(
      DOWNLOAD_DENIAL_REASON.ACCOUNT_DOWNLOAD_FORBIDDEN,
    );
    expect(getEnvelopeItemViewDenial({ version: 'current', policy })).toBeNull();
    expect(getEnvelopeItemViewDenial({ version: 'initial', policy })).toBeNull();
  });
});

describe('canDownloadDocument', () => {
  it('allows a viewer with neither a recipient role nor an account', () => {
    expect(canDownloadDocument({})).toBe(true);
    expect(canDownloadDocument({ recipient: null, account: null })).toBe(true);
  });

  it('allows the recipient roles which receive the document', () => {
    expect(canDownloadDocument({ recipient: { role: RecipientRole.SIGNER } })).toBe(true);
    expect(canDownloadDocument({ recipient: { role: RecipientRole.CC } })).toBe(true);
    expect(canDownloadDocument({ recipient: { role: RecipientRole.ASSISTANT } })).toBe(true);
  });

  it('denies a controlled signer', () => {
    expect(canDownloadDocument({ recipient: { role: RecipientRole.CONTROLLED_SIGNER } })).toBe(false);
  });

  it('denies a sign only account', () => {
    expect(canDownloadDocument({ account: { roles: [Role.SIGN_ONLY] } })).toBe(false);
  });

  it('denies an account whose role combination is not valid', () => {
    expect(canDownloadDocument({ account: { roles: [] } })).toBe(false);
    expect(canDownloadDocument({ account: { roles: [Role.USER, Role.SIGN_ONLY] } })).toBe(false);
  });

  it('allows an unrestricted account', () => {
    expect(canDownloadDocument({ account: { roles: [Role.USER] } })).toBe(true);
    expect(canDownloadDocument({ account: { roles: [Role.USER, Role.ADMIN] } })).toBe(true);
  });

  it('denies when either rule applies', () => {
    expect(
      canDownloadDocument({
        recipient: { role: RecipientRole.CONTROLLED_SIGNER },
        account: { roles: [Role.USER] },
      }),
    ).toBe(false);

    expect(
      canDownloadDocument({
        recipient: { role: RecipientRole.SIGNER },
        account: { roles: [Role.SIGN_ONLY] },
      }),
    ).toBe(false);
  });
});

describe('getRecipientDownloadPolicy', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getDownloadWindowHours).mockResolvedValue(null);
  });

  it('closes the download of a controlled signer while the document is still pending', async () => {
    const policy = await getRecipientDownloadPolicy({
      status: DocumentStatus.PENDING,
      completedAt: null,
      recipientRole: RecipientRole.CONTROLLED_SIGNER,
    });

    expect(policy.isAccountDownloadBlocked).toBe(true);
    expect(getEnvelopeItemDownloadDenial({ version: 'signed', policy })).toBe(
      DOWNLOAD_DENIAL_REASON.ACCOUNT_DOWNLOAD_FORBIDDEN,
    );
    // Signing the document still renders it.
    expect(getEnvelopeItemViewDenial({ version: 'current', policy })).toBeNull();
  });

  it('leaves the download of a signer to the window rules', async () => {
    const policy = await getRecipientDownloadPolicy({
      status: DocumentStatus.PENDING,
      completedAt: null,
      recipientRole: RecipientRole.SIGNER,
    });

    expect(policy.isAccountDownloadBlocked).toBe(false);
    expect(getEnvelopeItemDownloadDenial({ version: 'signed', policy })).toBeNull();
  });
});

describe('getEnvelopeItemDownloadDenial', () => {
  it('denies the original version when it is restricted', () => {
    const policy = buildEnvelopeDownloadPolicy({
      status: DocumentStatus.COMPLETED,
      completedAt,
      windowHours: 48,
      role: TeamMemberRole.MEMBER,
      now: hoursAfter(completedAt, 1),
    });

    expect(getEnvelopeItemDownloadDenial({ version: 'original', policy })).toBe(
      DOWNLOAD_DENIAL_REASON.ORIGINAL_DOWNLOAD_FORBIDDEN,
    );
    expect(getEnvelopeItemDownloadDenial({ version: 'signed', policy })).toBeNull();
  });

  it('denies the signed version past the download window', () => {
    const policy = buildEnvelopeDownloadPolicy({
      status: DocumentStatus.COMPLETED,
      completedAt,
      windowHours: 48,
      role: null,
      now: hoursAfter(completedAt, 49),
    });

    expect(getEnvelopeItemDownloadDenial({ version: 'signed', policy })).toBe(
      DOWNLOAD_DENIAL_REASON.DOWNLOAD_WINDOW_EXPIRED,
    );
  });

  it('allows privileged members to download both versions', () => {
    const policy = buildEnvelopeDownloadPolicy({
      status: DocumentStatus.COMPLETED,
      completedAt,
      windowHours: 48,
      role: TeamMemberRole.SGC,
      now: hoursAfter(completedAt, 49),
    });

    expect(getEnvelopeItemDownloadDenial({ version: 'original', policy })).toBeNull();
    expect(getEnvelopeItemDownloadDenial({ version: 'signed', policy })).toBeNull();
    expect(getEnvelopeItemDownloadDenial({ version: 'pending', policy })).toBeNull();
  });
});

describe('toDownloadVersion', () => {
  it('maps the viewer versions onto the download versions', () => {
    expect(toDownloadVersion('initial')).toBe('original');
    expect(toDownloadVersion('current')).toBe('signed');
  });
});

describe('getEnvelopeItemViewDenial', () => {
  const policyFor = ({
    status,
    role,
    now,
    windowHours = 48,
  }: {
    status: DocumentStatus;
    role: TeamMemberRole | null;
    now: Date;
    windowHours?: number | null;
  }) =>
    buildEnvelopeDownloadPolicy({
      status,
      completedAt,
      windowHours,
      role,
      now,
    });

  it('denies the initial version to recipients and members of a final document', () => {
    const policy = policyFor({
      status: DocumentStatus.COMPLETED,
      role: TeamMemberRole.MEMBER,
      now: hoursAfter(completedAt, 1),
    });

    expect(getEnvelopeItemViewDenial({ version: 'initial', policy })).toBe(
      DOWNLOAD_DENIAL_REASON.ORIGINAL_DOWNLOAD_FORBIDDEN,
    );
    expect(getEnvelopeItemViewDenial({ version: 'current', policy })).toBeNull();
  });

  it('keeps the initial version for ADMIN and SGC', () => {
    const policy = policyFor({
      status: DocumentStatus.REJECTED,
      role: TeamMemberRole.SGC,
      now: hoursAfter(completedAt, 1),
    });

    expect(getEnvelopeItemViewDenial({ version: 'initial', policy })).toBeNull();
  });

  it('denies the current version once the download window elapses', () => {
    const policy = policyFor({
      status: DocumentStatus.COMPLETED,
      role: null,
      now: hoursAfter(completedAt, 49),
    });

    expect(getEnvelopeItemViewDenial({ version: 'current', policy })).toBe(
      DOWNLOAD_DENIAL_REASON.DOWNLOAD_WINDOW_EXPIRED,
    );
    expect(getEnvelopeItemViewDenial({ version: 'initial', policy })).toBe(
      DOWNLOAD_DENIAL_REASON.ORIGINAL_DOWNLOAD_FORBIDDEN,
    );
  });

  it('leaves both versions to privileged viewers past the window', () => {
    const policy = policyFor({
      status: DocumentStatus.COMPLETED,
      role: TeamMemberRole.ADMIN,
      now: hoursAfter(completedAt, 49),
    });

    expect(getEnvelopeItemViewDenial({ version: 'initial', policy })).toBeNull();
    expect(getEnvelopeItemViewDenial({ version: 'current', policy })).toBeNull();
  });

  it('keeps both versions while the document is not final', () => {
    const policy = policyFor({
      status: DocumentStatus.PENDING,
      role: null,
      now: hoursAfter(completedAt, 100),
    });

    expect(getEnvelopeItemViewDenial({ version: 'initial', policy })).toBeNull();
    expect(getEnvelopeItemViewDenial({ version: 'current', policy })).toBeNull();
  });

  it('keeps both versions while the window is disabled', () => {
    const policy = policyFor({
      status: DocumentStatus.COMPLETED,
      role: null,
      windowHours: null,
      now: hoursAfter(completedAt, 100000),
    });

    expect(getEnvelopeItemViewDenial({ version: 'current', policy })).toBeNull();
    expect(getEnvelopeItemViewDenial({ version: 'initial', policy })).toBe(
      DOWNLOAD_DENIAL_REASON.ORIGINAL_DOWNLOAD_FORBIDDEN,
    );
  });
});
