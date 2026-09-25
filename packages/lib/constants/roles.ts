import { Role } from '@prisma/client';

import { AppError, AppErrorCode } from '../errors/app-error';

/**
 * The role combinations which are considered valid for a user.
 *
 * The sign only role is a restricted profile rather than an extra permission,
 * so it is mutually exclusive with the user and admin roles.
 */
export const VALID_ROLE_COMBINATIONS: Role[][] = [[Role.USER], [Role.USER, Role.ADMIN], [Role.ADMIN], [Role.SIGN_ONLY]];

/**
 * Build a key which allows role combinations to be compared regardless of the
 * order the roles are stored in.
 */
const getRoleCombinationKey = (roles: readonly Role[]) => [...roles].sort().join(',');

/**
 * Find the valid role combination matching the given roles.
 */
const getValidRoleCombination = (roles: readonly Role[]) => {
  const key = getRoleCombinationKey(roles);

  return VALID_ROLE_COMBINATIONS.find((combination) => getRoleCombinationKey(combination) === key);
};

/**
 * Whether the given roles are one of the valid role combinations.
 *
 * Unknown and empty combinations are invalid, which allows callers to apply the
 * sign only restriction whenever inconsistent data is found.
 */
export const isValidRoleCombination = (roles: readonly Role[]) => getValidRoleCombination(roles) !== undefined;

/**
 * Validate a role combination and return it in its canonical order.
 *
 * @throws {AppError} When the combination is invalid.
 */
export const validateRoleCombination = (roles: readonly Role[]) => {
  const combination = getValidRoleCombination(roles);

  if (!combination) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: `Invalid role combination: ${roles.join(', ') || 'none'}`,
    });
  }

  return [...combination];
};

/**
 * Get the roles a sign only user should end up with after being promoted.
 *
 * Promoting a restricted user replaces the sign only role with the user role
 * instead of adding to it, and never grants the admin role. Any other role is
 * dropped since the restriction wins over inconsistent data.
 */
export const getRolesAfterPromotion = (roles: readonly Role[]) => {
  if (!roles.includes(Role.SIGN_ONLY)) {
    return [...roles];
  }

  return [Role.USER];
};
