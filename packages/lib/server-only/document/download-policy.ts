import type { RecipientRole, Role, TeamMemberRole } from '@prisma/client';
import { DocumentStatus } from '@prisma/client';

import type { DocumentDataVersion } from '../../types/document';
import { hasOrganisationSgcDownloadPrivileges } from '../../utils/organisations';
import { getRecipientRoleCapabilities } from '../../utils/recipients';
import { hasSgcDownloadPrivileges } from '../../utils/teams';
import {
  getAccountRolesById,
  isRestrictedAccount,
  RESTRICTED_ACCOUNT_DOWNLOAD_MESSAGE,
} from '../auth/document-authorization';
import { getDownloadWindowHours } from '../site-settings/get-download-window-hours';
import { getMemberOrganisationRole } from '../team/get-member-roles';
import { getTeamById } from '../team/get-team';

export type TDocumentDownloadVersion = 'original' | 'signed' | 'pending';

/**
 * Download denials surfaced to clients, so the UI can explain a blocked
 * download instead of showing a bare 403.
 */
export const DOWNLOAD_DENIAL_REASON = {
  DOWNLOAD_WINDOW_EXPIRED: 'DOWNLOAD_WINDOW_EXPIRED',
  ORIGINAL_DOWNLOAD_FORBIDDEN: 'ORIGINAL_DOWNLOAD_FORBIDDEN',
  ACCOUNT_DOWNLOAD_FORBIDDEN: 'ACCOUNT_DOWNLOAD_FORBIDDEN',
} as const;

export type TDownloadDenialReason = (typeof DOWNLOAD_DENIAL_REASON)[keyof typeof DOWNLOAD_DENIAL_REASON];

type CanDownloadDocumentOptions = {
  /**
   * The recipient the viewer is reaching the document through, when there is
   * one. Controlled signers never download.
   */
  recipient?: { role: RecipientRole } | null;

  /**
   * The account behind the request, with roles read fresh from the database.
   * Sign only accounts never download.
   */
  account?: { roles: readonly Role[] } | null;
};

/**
 * Rule O: whether the document may be downloaded by this viewer.
 *
 * Two independent restrictions deny a download:
 *
 * - the recipient role: a controlled signer signs, and explicitly does not
 *   receive the document, so it is never handed the bytes;
 * - the account: a sign only account has no download, wherever it reaches the
 *   document from.
 *
 * The rules are restrictions only: with no recipient and an unrestricted (or
 * absent) account the answer is yes, and the caller still has to apply its own
 * window and privilege rules on top.
 */
export const canDownloadDocument = ({ recipient, account }: CanDownloadDocumentOptions) => {
  if (recipient && !getRecipientRoleCapabilities(recipient.role).canDownload) {
    return false;
  }

  // An account whose roles are not a known combination is treated as restricted,
  // the same way the write guard treats it.
  if (account && isRestrictedAccount({ roles: [...account.roles] })) {
    return false;
  }

  return true;
};

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
   * Whether the viewer holds the SGC download privileges (team ADMIN/SGC, or an
   * organisation SGC/ADMIN role).
   */
  isSgcPrivileged: boolean;

  canDownloadSigned: boolean;
  canDownloadOriginal: boolean;

  /**
   * Whether the viewer's own account (or recipient role) takes downloads away
   * regardless of the window and privilege rules above.
   *
   * Kept separate from `canDownload*` because it only closes the download and
   * export surface: rendering the document to sign it stays allowed, and the
   * viewer denial is deliberately computed without it.
   */
  isAccountDownloadBlocked: boolean;
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

  /**
   * Whether the viewer holds the SGC privileges through their organisation role
   * instead of their team role. Combined with `role`.
   */
  isOrganisationSgcPrivileged?: boolean;

  /**
   * Roles of the account behind the request, read fresh from the database. Only
   * pass a value which came from the database.
   */
  accountRoles?: readonly Role[] | null;

  /**
   * Recipient role of a token viewer, when the caller knows it. Controlled
   * signers never download.
   */
  recipientRole?: RecipientRole | null;

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
 *   team ADMIN/SGC and organisation SGC/ADMIN members. While the envelope is still
 *   draft or pending the original is the only available version, so it stays
 *   available to anyone with access.
 * - Past the download window only those privileged viewers may download.
 */
export const buildEnvelopeDownloadPolicy = ({
  status,
  completedAt,
  windowHours,
  role,
  isOrganisationSgcPrivileged = false,
  accountRoles,
  recipientRole,
  now,
}: BuildEnvelopeDownloadPolicyOptions): EnvelopeDownloadPolicy => {
  const hasTeamSgcPrivileges = role ? hasSgcDownloadPrivileges(role) : false;
  const isSgcPrivileged = hasTeamSgcPrivileges || isOrganisationSgcPrivileged;
  const hasWindowExpired = isDownloadWindowExpired({
    status,
    completedAt,
    windowHours,
    now,
  });

  const isAccountDownloadBlocked = !canDownloadDocument({
    recipient: recipientRole ? { role: recipientRole } : null,
    account: accountRoles ? { roles: [...accountRoles] } : null,
  });

  return {
    downloadWindowHours: windowHours,
    downloadWindowExpiresAt: getDownloadWindowExpiresAt({ completedAt, windowHours }),
    isDownloadWindowExpired: hasWindowExpired,
    isSgcPrivileged,
    canDownloadSigned: hasWindowExpired ? isSgcPrivileged : true,
    canDownloadOriginal: isFinalDocumentStatus(status) ? isSgcPrivileged : true,
    isAccountDownloadBlocked,
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
  isOrganisationSgcPrivileged,
  accountRoles,
  recipientRole,
  now,
}: GetEnvelopeDownloadPolicyOptions): Promise<EnvelopeDownloadPolicy> => {
  return buildEnvelopeDownloadPolicy({
    status,
    completedAt,
    windowHours: await resolveDownloadWindowHours(downloadWindowHours),
    role,
    isOrganisationSgcPrivileged,
    accountRoles,
    recipientRole,
    now,
  });
};

type GetUserDownloadPolicyOptions = {
  userId: number;
  teamId: number;
  status: DocumentStatus;
  completedAt: Date | null | undefined;
  downloadWindowHours?: number | null;
  now?: Date;
};

/**
 * Resolves the download policy for a user acting through a team (session or API
 * token), using their role in the envelope's team and, when that role is lower,
 * their organisation role.
 *
 * Organisation members holding the SGC role get the same privileges as a team SGC
 * member on every envelope of that organisation, even when the team they reach the
 * envelope through does not grant them the SGC role.
 *
 * Users outside that team - for example someone reaching an organisation template
 * through another team - are treated as non-privileged.
 *
 * The account roles are read fresh from the database on every call, so a sign
 * only account loses download access on the next download after being restricted,
 * no matter how long its session lives.
 */
export const getUserDownloadPolicy = async ({
  userId,
  teamId,
  ...options
}: GetUserDownloadPolicyOptions): Promise<EnvelopeDownloadPolicy> => {
  const team = await getTeamById({ userId, teamId }).catch(() => null);

  const organisationRole = team
    ? await getMemberOrganisationRole({
        organisationId: team.organisationId,
        reference: {
          type: 'User',
          id: userId,
        },
      }).catch(() => null)
    : null;

  const account = await getAccountRolesById({ userId });

  return await getEnvelopeDownloadPolicy({
    ...options,
    role: team?.currentTeamRole ?? null,
    isOrganisationSgcPrivileged: organisationRole !== null && hasOrganisationSgcDownloadPrivileges(organisationRole),
    // A deleted account cannot reach this point through a session or an API
    // token, and if it somehow does it downloads nothing.
    accountRoles: account?.roles ?? [],
  });
};

/**
 * Resolves the download policy for a recipient (file token) viewer, who never
 * holds team privileges.
 *
 * When the caller knows the recipient role it must pass it: controlled signers
 * never download the document.
 */
export const getRecipientDownloadPolicy = async ({
  status,
  completedAt,
  downloadWindowHours,
  recipientRole,
  now,
}: Omit<GetUserDownloadPolicyOptions, 'userId' | 'teamId'> & {
  recipientRole?: RecipientRole | null;
}): Promise<EnvelopeDownloadPolicy> => {
  return await getEnvelopeDownloadPolicy({
    status,
    completedAt,
    downloadWindowHours,
    role: null,
    recipientRole,
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
  // The account and recipient restrictions close the download surface outright,
  // so they are answered before the window and privilege rules.
  if (policy.isAccountDownloadBlocked) {
    return DOWNLOAD_DENIAL_REASON.ACCOUNT_DOWNLOAD_FORBIDDEN;
  }

  if (version === 'original') {
    return policy.canDownloadOriginal ? null : DOWNLOAD_DENIAL_REASON.ORIGINAL_DOWNLOAD_FORBIDDEN;
  }

  return policy.canDownloadSigned ? null : DOWNLOAD_DENIAL_REASON.DOWNLOAD_WINDOW_EXPIRED;
};

/**
 * The viewer routes (`item.pdf`) hand out the same two stored versions as the
 * download routes under different names: `initial` is the original document and
 * `current` is the document with the collected signatures.
 */
export const toDownloadVersion = (version: DocumentDataVersion): TDocumentDownloadVersion => {
  if (version === 'initial') {
    return 'original';
  }

  return 'signed';
};

type GetEnvelopeItemViewDenialOptions = {
  version: DocumentDataVersion;
  policy: EnvelopeDownloadPolicy;
};

/**
 * The reason a viewer request must be denied, or `null` when it is allowed.
 *
 * The account restriction is deliberately left out: the viewer exists so a
 * recipient can read the document in order to sign it, and a sign only account
 * is allowed to sign. What comes out of the viewer can be kept by whoever sees
 * it; what is not offered is the download route, the export routes and the
 * attachments.
 */
export const getEnvelopeItemViewDenial = ({
  version,
  policy,
}: GetEnvelopeItemViewDenialOptions): TDownloadDenialReason | null => {
  return getEnvelopeItemDownloadDenial({
    version: toDownloadVersion(version),
    policy: {
      ...policy,
      isAccountDownloadBlocked: false,
    },
  });
};

export const DOWNLOAD_DENIAL_MESSAGE: Record<TDownloadDenialReason, string> = {
  [DOWNLOAD_DENIAL_REASON.DOWNLOAD_WINDOW_EXPIRED]:
    'The download window for this document has expired. Only team administrators can download it.',
  [DOWNLOAD_DENIAL_REASON.ORIGINAL_DOWNLOAD_FORBIDDEN]:
    'The original document can only be downloaded by team administrators.',
  [DOWNLOAD_DENIAL_REASON.ACCOUNT_DOWNLOAD_FORBIDDEN]: RESTRICTED_ACCOUNT_DOWNLOAD_MESSAGE,
};
