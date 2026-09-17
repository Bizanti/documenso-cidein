import { DocumentStatus, TeamMemberRole } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getDownloadWindowHours } from '../site-settings/get-download-window-hours';
import {
  buildEnvelopeDownloadPolicy,
  DOWNLOAD_DENIAL_REASON,
  getDownloadWindowExpiresAt,
  getEnvelopeDownloadPolicy,
  getEnvelopeItemDownloadDenial,
  isDownloadWindowExpired,
  isFinalDocumentStatus,
} from './download-policy';

vi.mock('../site-settings/get-download-window-hours');

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
