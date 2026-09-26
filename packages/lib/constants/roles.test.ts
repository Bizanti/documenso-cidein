import { Role } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { AppError, AppErrorCode } from '../errors/app-error';
import {
  getRolesAfterPromotion,
  isValidRoleCombination,
  VALID_ROLE_COMBINATIONS,
  validateRoleCombination,
} from './roles';

describe('VALID_ROLE_COMBINATIONS', () => {
  it('only contains combinations accepted by the validator', () => {
    for (const combination of VALID_ROLE_COMBINATIONS) {
      expect(isValidRoleCombination(combination)).toBe(true);
    }
  });

  it('never mixes the sign only role with another role', () => {
    for (const combination of VALID_ROLE_COMBINATIONS) {
      if (combination.includes(Role.SIGN_ONLY)) {
        expect(combination).toEqual([Role.SIGN_ONLY]);
      }
    }
  });
});

describe('isValidRoleCombination', () => {
  it('accepts every valid combination regardless of the role order', () => {
    for (const combination of VALID_ROLE_COMBINATIONS) {
      expect(isValidRoleCombination(combination)).toBe(true);
      expect(isValidRoleCombination([...combination].reverse())).toBe(true);
    }
  });

  it('rejects the sign only role when it is combined with another role', () => {
    expect(isValidRoleCombination([Role.SIGN_ONLY, Role.USER])).toBe(false);
    expect(isValidRoleCombination([Role.USER, Role.SIGN_ONLY])).toBe(false);
    expect(isValidRoleCombination([Role.SIGN_ONLY, Role.ADMIN])).toBe(false);
    expect(isValidRoleCombination([Role.SIGN_ONLY, Role.USER, Role.ADMIN])).toBe(false);
  });

  it('rejects unknown combinations', () => {
    expect(isValidRoleCombination([])).toBe(false);
    expect(isValidRoleCombination([Role.USER, Role.USER])).toBe(false);
  });
});

describe('validateRoleCombination', () => {
  it('returns the combination in its canonical order', () => {
    expect(validateRoleCombination([Role.ADMIN, Role.USER])).toEqual([Role.USER, Role.ADMIN]);
  });

  it('does not expose the exported combinations to mutation', () => {
    const roles = validateRoleCombination([Role.SIGN_ONLY]);
    roles.push(Role.USER);

    expect(VALID_ROLE_COMBINATIONS).toContainEqual([Role.SIGN_ONLY]);
  });

  it('rejects an invalid combination with an invalid request AppError', () => {
    const getThrownError = () => {
      try {
        validateRoleCombination([Role.SIGN_ONLY, Role.USER]);
      } catch (error) {
        return error;
      }

      return null;
    };

    const error = getThrownError();

    expect(error).toBeInstanceOf(AppError);
    expect(AppError.parseError(error).code).toBe(AppErrorCode.INVALID_REQUEST);
  });
});

describe('getRolesAfterPromotion', () => {
  it('replaces the sign only role with the user role', () => {
    expect(getRolesAfterPromotion([Role.SIGN_ONLY])).toEqual([Role.USER]);
  });

  it('never keeps the sign only role alongside the user role', () => {
    expect(getRolesAfterPromotion([Role.SIGN_ONLY, Role.USER])).toEqual([Role.USER]);
  });

  it('never promotes to admin from inconsistent data', () => {
    expect(getRolesAfterPromotion([Role.SIGN_ONLY, Role.ADMIN])).toEqual([Role.USER]);
    expect(getRolesAfterPromotion([Role.SIGN_ONLY, Role.USER, Role.ADMIN])).toEqual([Role.USER]);
  });

  it('leaves a combination without the sign only role untouched', () => {
    expect(getRolesAfterPromotion([Role.USER])).toEqual([Role.USER]);
    expect(getRolesAfterPromotion([Role.USER, Role.ADMIN])).toEqual([Role.USER, Role.ADMIN]);
  });
});
