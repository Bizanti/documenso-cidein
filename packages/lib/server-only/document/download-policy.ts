import type { TeamMemberRole } from '@prisma/client';
import { DocumentStatus } from '@prisma/client';

import { hasSgcDownloadPrivileges } from '../../utils/teams';
import { getDownloadWindowHours } from '../site-settings/get-download-window-hours';

export type TDocumentDownloadVersion = 'original' | 'signed' | 'pending';

/**
 * Download denials surfaced to clients, so the UI can explain a blocked
 * download instead of showing a bare 403.
 */
export const DOWNLOAD_DENIAL_REASON = {
  DOWNLOAD_WINDOW_EXPIRED: 'DOWNLOAD_WINDOW_EXPIRED',
  ORIGINAL_DOWNLOAD_FORBIDDEN: 'ORIGINAL_DOWNLOAD_FORBIDDEN',
} as const;

export type TDownloadDenialReason = (typeof DOWNLOAD_DENIAL_REASON)[keyof typeof DOWNLOAD_DENIAL_REASON];

/**
 * Envelope statuses in which the stored document data represents the final
 * document: completed, or rejected with the collected signatures burned in.
 */
export const isFinalDocumentStatus = (status: DocumentStatus): boolean => {
  return status === DocumentStatus.COMPLETED || status === DocumentStatus.REJECTED;
};

/**
 * The window to apply for an envelope: its own override when set, otherwise the
 * global site setting, otherwise `null` for unlimited downloads.
 */
export const resolveDownloadWindowHours = async (override?: number | null): Promise<number | null> => {
  if (override !== undefined && override !== null) {
    return override;
  }

  return await getDownloadWindowHours();
};

type GetDownloadWindowExpiresAtOptions = {
  completedAt: Date | null | undefined;
  windowHours: number | null;
};

export const getDownloadWindowExpiresAt = ({
  completedAt,
  windowHours,
}: GetDownloadWindowExpiresAtOptions): Date | null => {
  if (!completedAt || windowHours === null) {
    return null;
  }

  return new Date(completedAt.getTime() + windowHours * 60 * 60 * 1000);
};

type IsDownloadWindowExpiredOptions = {
  status: DocumentStatus;
  completedAt: Date | null | undefined;
  windowHours: number | null;
  now?: Date;
};

/**
 * Whether the download window has elapsed. The window starts when the envelope
 * reaches a final status, so it never applies to drafts or in-flight envelopes.
 */
export const isDownloadWindowExpired = ({
  status,
  completedAt,
  windowHours,
  now = new Date(),
}: IsDownloadWindowExpiredOptions): boolean => {
  if (!isFinalDocumentStatus(status)) {
    return false;
  }

  const expiresAt = getDownloadWindowExpiresAt({ completedAt, windowHours });

  if (!expiresAt) {
    return false;
  }

  return now.getTime() >= expiresAt.getTime();
};

export type EnvelopeDownloadPolicy = {
  /**
   * The window applied to this envelope, in hours. `null` means downloads do not expire.
   */
  downloadWindowHours: number | null;
  downloadWindowExpiresAt: Date | null;
  isDownloadWindowExpired: boolean;

  /**
   * Whether the viewer holds the SGC download privileges (team ADMIN/SGC).
   */
  isSgcPrivileged: boolean;

  canDownloadSigned: boolean;
  canDownloadOriginal: boolean;
};

type GetEnvelopeDownloadPolicyOptions = {
  status: DocumentStatus;
  completedAt: Date | null | undefined;

  /**
   * Per-envelope override. Falls back to the global site setting when nullish.
   */
  downloadWindowHours?: number | null;

  /**
   * Team role of the session user. Recipient (token) access passes `null`, which
   * is treated as non-privileged.
   */
  role?: TeamMemberRole | null;
  now?: Date;
};

type BuildEnvelopeDownloadPolicyOptions = Omit<GetEnvelopeDownloadPolicyOptions, 'downloadWindowHours'> & {
  /**
   * The already resolved window, in hours. `null` means downloads do not expire.
   */
  windowHours: number | null;
};

/**
 * Builds the download policy from an already resolved window, for callers that
 * evaluate many envelopes against the same global setting.
 *
 * Rules:
 * - Once the envelope is final (signed copy exists) the original is restricted to
 *   team ADMIN/SGC. While the envelope is still draft or pending the original is the
 *   only available version, so it stays available to anyone with access.
 * - Past the download window only team ADMIN/SGC may download.
 */
export const buildEnvelopeDownloadPolicy = ({
  status,
  completedAt,
  windowHours,
  role,
  now,
}: BuildEnvelopeDownloadPolicyOptions): EnvelopeDownloadPolicy => {
  const isSgcPrivileged = role ? hasSgcDownloadPrivileges(role) : false;
  const hasWindowExpired = isDownloadWindowExpired({
    status,
    completedAt,
    windowHours,
    now,
  });

  return {
    downloadWindowHours: windowHours,
    downloadWindowExpiresAt: getDownloadWindowExpiresAt({ completedAt, windowHours }),
    isDownloadWindowExpired: hasWindowExpired,
    isSgcPrivileged,
    canDownloadSigned: hasWindowExpired ? isSgcPrivileged : true,
    canDownloadOriginal: isFinalDocumentStatus(status) ? isSgcPrivileged : true,
  };
};

/**
 * Resolves what the given viewer may download for an envelope.
 */
export const getEnvelopeDownloadPolicy = async ({
  status,
  completedAt,
  downloadWindowHours,
  role,
  now,
}: GetEnvelopeDownloadPolicyOptions): Promise<EnvelopeDownloadPolicy> => {
  return buildEnvelopeDownloadPolicy({
    status,
    completedAt,
    windowHours: await resolveDownloadWindowHours(downloadWindowHours),
    role,
    now,
  });
};

type GetEnvelopeItemDownloadDenialOptions = {
  version: TDocumentDownloadVersion;
  policy: EnvelopeDownloadPolicy;
};

/**
 * The reason a download must be denied, or `null` when it is allowed.
 */
export const getEnvelopeItemDownloadDenial = ({
  version,
  policy,
}: GetEnvelopeItemDownloadDenialOptions): TDownloadDenialReason | null => {
  if (version === 'original') {
    return policy.canDownloadOriginal ? null : DOWNLOAD_DENIAL_REASON.ORIGINAL_DOWNLOAD_FORBIDDEN;
  }

  return policy.canDownloadSigned ? null : DOWNLOAD_DENIAL_REASON.DOWNLOAD_WINDOW_EXPIRED;
};

export const DOWNLOAD_DENIAL_MESSAGE: Record<TDownloadDenialReason, string> = {
  [DOWNLOAD_DENIAL_REASON.DOWNLOAD_WINDOW_EXPIRED]:
    'The download window for this document has expired. Only team administrators can download it.',
  [DOWNLOAD_DENIAL_REASON.ORIGINAL_DOWNLOAD_FORBIDDEN]:
    'The original document can only be downloaded by team administrators.',
};
