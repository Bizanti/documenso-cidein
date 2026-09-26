import { prisma } from '@documenso/prisma';
import { type Prisma, type Role, UserSecurityAuditLogType } from '@prisma/client';

import type { RequestMetadata } from '../../universal/extract-request-metadata';
import { logger } from '../../utils/logger';

/**
 * The profile fields which are recorded when an administrator changes them.
 *
 * Both fields decide what an account is allowed to do, so every change made
 * through an administrative route leaves a record of the previous and the new
 * value.
 */
export type AuditedProfileField = 'roles' | 'email';

export type RecordUserProfileChangeOptions = {
  /**
   * The administrator which performed the change.
   */
  actorUserId: number;

  /**
   * The account whose profile was changed.
   */
  targetUserId: number;

  /**
   * The profile values before the change.
   */
  previous: {
    roles: readonly Role[];
    email: string;
  };

  /**
   * The profile values after the change.
   */
  next: {
    roles: readonly Role[];
    email: string;
  };

  metadata?: RequestMetadata;

  /**
   * An existing transaction to write the record in.
   */
  tx?: Prisma.TransactionClient;
};

/**
 * Compare two role combinations regardless of the order they are stored in.
 */
const isSameRoleCombination = (a: readonly Role[], b: readonly Role[]) =>
  a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',');

/**
 * Record an administrative change of a user profile.
 *
 * Writes a security audit log entry for the affected account so the change is
 * visible in the account's own audit log with the time it happened, and emits a
 * structured audit event carrying the administrator, the account and the
 * previous and new values of every field which changed.
 *
 * @returns The profile fields which actually changed.
 */
export const recordUserProfileChange = async ({
  actorUserId,
  targetUserId,
  previous,
  next,
  metadata,
  tx,
}: RecordUserProfileChangeOptions) => {
  const changedFields: AuditedProfileField[] = [];

  if (!isSameRoleCombination(previous.roles, next.roles)) {
    changedFields.push('roles');
  }

  if (previous.email !== next.email) {
    changedFields.push('email');
  }

  if (changedFields.length === 0) {
    return { changedFields };
  }

  const client = tx ?? prisma;

  await client.userSecurityAuditLog.create({
    data: {
      userId: targetUserId,
      type: UserSecurityAuditLogType.ACCOUNT_PROFILE_UPDATE,
      ipAddress: metadata?.ipAddress,
      userAgent: metadata?.userAgent,
    },
  });

  logger.info({
    auditEvent: 'USER_PROFILE_CHANGE',
    actorUserId,
    targetUserId,
    changedFields,
    previousRoles: [...previous.roles].sort(),
    newRoles: [...next.roles].sort(),
    previousEmail: previous.email,
    newEmail: next.email,
    ipAddress: metadata?.ipAddress,
    userAgent: metadata?.userAgent,
  });

  return { changedFields };
};
