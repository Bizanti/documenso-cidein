import { Role } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { isValidRoleCombination } from '../constants/roles';
import { isSignOnly } from './is-sign-only';

describe('isSignOnly', () => {
  it('is true for the sign only role', () => {
    expect(isSignOnly({ roles: [Role.SIGN_ONLY] })).toBe(true);
  });

  it('wins over the user role when the stored data is inconsistent', () => {
    expect(isSignOnly({ roles: [Role.SIGN_ONLY, Role.USER] })).toBe(true);
  });

  it('wins over the admin role when the stored data is inconsistent', () => {
    expect(isSignOnly({ roles: [Role.SIGN_ONLY, Role.ADMIN] })).toBe(true);
  });

  it('is false for combinations without the sign only role', () => {
    expect(isSignOnly({ roles: [Role.USER] })).toBe(false);
    expect(isSignOnly({ roles: [Role.USER, Role.ADMIN] })).toBe(false);
  });

  it('is false for an empty combination, which is intentional', () => {
    // The sign only check only answers whether the restriction is stored on the
    // user. An empty combination is invalid data, and the fail-safe belongs to
    // the authorization guard which requires a valid combination as well, as
    // documented below.
    expect(isSignOnly({ roles: [] })).toBe(false);
  });

  it('documents the guard that closes the empty combination', () => {
    // Mirrors the guard the server side authorization uses: an invalid
    // combination, such as an empty one, is never allowed.
    const canUploadDocuments = (roles: Role[]) => isValidRoleCombination(roles) && !isSignOnly({ roles });

    expect(canUploadDocuments([])).toBe(false);
    expect(canUploadDocuments([Role.SIGN_ONLY])).toBe(false);
    expect(canUploadDocuments([Role.SIGN_ONLY, Role.USER])).toBe(false);
    expect(canUploadDocuments([Role.USER])).toBe(true);
    expect(canUploadDocuments([Role.USER, Role.ADMIN])).toBe(true);
  });
});
