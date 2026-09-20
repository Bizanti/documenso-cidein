import { OrganisationGroupType, OrganisationMemberRole } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import {
  ORGANISATION_INTERNAL_GROUPS,
  ORGANISATION_MEMBER_ROLE_HIERARCHY,
  ORGANISATION_ROLES_WITH_SGC_DOWNLOAD_PRIVILEGES,
} from '../constants/organisations';
import {
  EXTENDED_ORGANISATION_MEMBER_ROLE_MAP,
  ORGANISATION_MEMBER_ROLE_MAP,
} from '../constants/organisations-translations';
import {
  canExecuteOrganisationAction,
  getHighestOrganisationRoleInGroup,
  hasOrganisationSgcDownloadPrivileges,
  isOrganisationRoleWithinUserHierarchy,
} from './organisations';

const ALL_ROLES = Object.values(OrganisationMemberRole).sort();

const organisationGroup = (organisationRole: OrganisationMemberRole) => ({
  type: OrganisationGroupType.INTERNAL_ORGANISATION,
  organisationRole,
});

describe('ORGANISATION_INTERNAL_GROUPS', () => {
  it('has an internal organisation group for SGC so the role can be assigned', () => {
    expect(ORGANISATION_INTERNAL_GROUPS).toContainEqual({
      organisationRole: OrganisationMemberRole.SGC,
      type: OrganisationGroupType.INTERNAL_ORGANISATION,
    });
  });

  it('covers every organisation member role', () => {
    expect(ORGANISATION_INTERNAL_GROUPS.map((group) => group.organisationRole).sort()).toEqual(ALL_ROLES);
  });
});

describe('organisation member role maps', () => {
  it('has a label for SGC in both maps', () => {
    expect(ORGANISATION_MEMBER_ROLE_MAP.SGC).toBeDefined();
    expect(EXTENDED_ORGANISATION_MEMBER_ROLE_MAP.SGC).toBeDefined();
  });

  it('covers every organisation member role', () => {
    expect(Object.keys(ORGANISATION_MEMBER_ROLE_MAP).sort()).toEqual(ALL_ROLES);
    expect(Object.keys(EXTENDED_ORGANISATION_MEMBER_ROLE_MAP).sort()).toEqual(ALL_ROLES);
  });
});

describe('ORGANISATION_MEMBER_ROLE_HIERARCHY', () => {
  it('allows an ADMIN to invite or update an SGC member', () => {
    expect(isOrganisationRoleWithinUserHierarchy(OrganisationMemberRole.ADMIN, OrganisationMemberRole.SGC)).toBe(true);
  });

  it('does not allow a MANAGER to invite or update an SGC member', () => {
    expect(isOrganisationRoleWithinUserHierarchy(OrganisationMemberRole.MANAGER, OrganisationMemberRole.SGC)).toBe(
      false,
    );
  });

  it('ranks SGC above MANAGER and below ADMIN', () => {
    expect(isOrganisationRoleWithinUserHierarchy(OrganisationMemberRole.SGC, OrganisationMemberRole.MANAGER)).toBe(
      true,
    );
    expect(isOrganisationRoleWithinUserHierarchy(OrganisationMemberRole.SGC, OrganisationMemberRole.MEMBER)).toBe(true);
    expect(isOrganisationRoleWithinUserHierarchy(OrganisationMemberRole.SGC, OrganisationMemberRole.ADMIN)).toBe(false);
  });

  it('gives every role a distinct priority so the highest role is unambiguous', () => {
    const priorities = ALL_ROLES.map((role) => ORGANISATION_MEMBER_ROLE_HIERARCHY[role].length);

    expect(new Set(priorities).size).toBe(ALL_ROLES.length);

    for (const role of ALL_ROLES) {
      expect(ORGANISATION_MEMBER_ROLE_HIERARCHY[role]).toContain(role);
    }
  });
});

describe('canExecuteOrganisationAction', () => {
  it('does not give SGC the organisation management permissions', () => {
    expect(canExecuteOrganisationAction('MANAGE_ORGANISATION', OrganisationMemberRole.SGC)).toBe(false);
    expect(canExecuteOrganisationAction('DELETE_ORGANISATION', OrganisationMemberRole.SGC)).toBe(false);
    expect(canExecuteOrganisationAction('MANAGE_BILLING', OrganisationMemberRole.SGC)).toBe(false);
  });

  it('keeps the existing admin and manager permissions', () => {
    expect(canExecuteOrganisationAction('MANAGE_ORGANISATION', OrganisationMemberRole.ADMIN)).toBe(true);
    expect(canExecuteOrganisationAction('MANAGE_ORGANISATION', OrganisationMemberRole.MANAGER)).toBe(true);
    expect(canExecuteOrganisationAction('DELETE_ORGANISATION', OrganisationMemberRole.MANAGER)).toBe(false);
  });
});

describe('ORGANISATION_ROLES_WITH_SGC_DOWNLOAD_PRIVILEGES', () => {
  it('grants the SGC download privileges to ADMIN and SGC only', () => {
    expect(ORGANISATION_ROLES_WITH_SGC_DOWNLOAD_PRIVILEGES).toEqual([
      OrganisationMemberRole.ADMIN,
      OrganisationMemberRole.SGC,
    ]);
  });
});

describe('hasOrganisationSgcDownloadPrivileges', () => {
  it('returns true for ADMIN and SGC', () => {
    expect(hasOrganisationSgcDownloadPrivileges(OrganisationMemberRole.ADMIN)).toBe(true);
    expect(hasOrganisationSgcDownloadPrivileges(OrganisationMemberRole.SGC)).toBe(true);
  });

  it('returns false for MANAGER and MEMBER', () => {
    expect(hasOrganisationSgcDownloadPrivileges(OrganisationMemberRole.MANAGER)).toBe(false);
    expect(hasOrganisationSgcDownloadPrivileges(OrganisationMemberRole.MEMBER)).toBe(false);
  });
});

describe('getHighestOrganisationRoleInGroup', () => {
  it('ranks SGC above MANAGER and below ADMIN', () => {
    expect(
      getHighestOrganisationRoleInGroup([
        organisationGroup(OrganisationMemberRole.MANAGER),
        organisationGroup(OrganisationMemberRole.SGC),
      ]),
    ).toBe(OrganisationMemberRole.SGC);

    expect(
      getHighestOrganisationRoleInGroup([
        organisationGroup(OrganisationMemberRole.SGC),
        organisationGroup(OrganisationMemberRole.ADMIN),
      ]),
    ).toBe(OrganisationMemberRole.ADMIN);

    expect(getHighestOrganisationRoleInGroup([organisationGroup(OrganisationMemberRole.MEMBER)])).toBe(
      OrganisationMemberRole.MEMBER,
    );
  });
});
