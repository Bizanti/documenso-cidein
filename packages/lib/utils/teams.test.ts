import type { TeamGroup } from '@documenso/prisma/generated/types';
import { TeamMemberRole } from '@documenso/prisma/generated/types';
import { DocumentVisibility } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { TEAM_DOCUMENT_VISIBILITY_MAP, TEAM_ROLES_WITH_SGC_DOWNLOAD_PRIVILEGES } from '../constants/teams';
import {
  canAccessTeamDocument,
  canExecuteTeamAction,
  getHighestTeamRoleInGroup,
  hasSgcDownloadPrivileges,
  isMemberAdmin,
  isMemberManagerOrAbove,
  isMemberSgc,
  isTeamRoleWithinUserHierarchy,
} from './teams';

describe('TEAM_ROLES_WITH_SGC_DOWNLOAD_PRIVILEGES', () => {
  it('grants SGC download privileges to ADMIN and SGC only', () => {
    expect(TEAM_ROLES_WITH_SGC_DOWNLOAD_PRIVILEGES).toEqual([TeamMemberRole.ADMIN, TeamMemberRole.SGC]);
  });
});

describe('hasSgcDownloadPrivileges', () => {
  it('returns true for ADMIN and SGC', () => {
    expect(hasSgcDownloadPrivileges(TeamMemberRole.ADMIN)).toBe(true);
    expect(hasSgcDownloadPrivileges(TeamMemberRole.SGC)).toBe(true);
  });

  it('returns false for MANAGER and MEMBER', () => {
    expect(hasSgcDownloadPrivileges(TeamMemberRole.MANAGER)).toBe(false);
    expect(hasSgcDownloadPrivileges(TeamMemberRole.MEMBER)).toBe(false);
  });
});

describe('isMemberSgc', () => {
  it('returns true only for SGC', () => {
    expect(isMemberSgc(TeamMemberRole.SGC)).toBe(true);
    expect(isMemberSgc(TeamMemberRole.ADMIN)).toBe(false);
    expect(isMemberSgc(TeamMemberRole.MANAGER)).toBe(false);
    expect(isMemberSgc(TeamMemberRole.MEMBER)).toBe(false);
  });
});

describe('isMemberManagerOrAbove', () => {
  it('includes SGC between ADMIN and MANAGER', () => {
    expect(isMemberManagerOrAbove(TeamMemberRole.ADMIN)).toBe(true);
    expect(isMemberManagerOrAbove(TeamMemberRole.SGC)).toBe(true);
    expect(isMemberManagerOrAbove(TeamMemberRole.MANAGER)).toBe(true);
    expect(isMemberManagerOrAbove(TeamMemberRole.MEMBER)).toBe(false);
  });
});

describe('isMemberAdmin', () => {
  it('returns true only for ADMIN, not SGC', () => {
    expect(isMemberAdmin(TeamMemberRole.ADMIN)).toBe(true);
    expect(isMemberAdmin(TeamMemberRole.SGC)).toBe(false);
  });
});

describe('team permissions', () => {
  it('does not allow SGC to delete the team', () => {
    expect(canExecuteTeamAction('DELETE_TEAM', TeamMemberRole.SGC)).toBe(false);
    expect(canExecuteTeamAction('DELETE_TEAM', TeamMemberRole.ADMIN)).toBe(true);
  });

  it('does not allow SGC to manage the team', () => {
    expect(canExecuteTeamAction('MANAGE_TEAM', TeamMemberRole.SGC)).toBe(false);
  });

  it('grants SGC the same document visibility as ADMIN', () => {
    expect(TEAM_DOCUMENT_VISIBILITY_MAP[TeamMemberRole.SGC]).toEqual(
      TEAM_DOCUMENT_VISIBILITY_MAP[TeamMemberRole.ADMIN],
    );
  });

  it('resolves visibility through canAccessTeamDocument for every role', () => {
    expect(canAccessTeamDocument(TeamMemberRole.ADMIN, DocumentVisibility.ADMIN)).toBe(true);
    expect(canAccessTeamDocument(TeamMemberRole.ADMIN, DocumentVisibility.MANAGER_AND_ABOVE)).toBe(true);
    expect(canAccessTeamDocument(TeamMemberRole.ADMIN, DocumentVisibility.EVERYONE)).toBe(true);

    expect(canAccessTeamDocument(TeamMemberRole.SGC, DocumentVisibility.ADMIN)).toBe(true);
    expect(canAccessTeamDocument(TeamMemberRole.SGC, DocumentVisibility.MANAGER_AND_ABOVE)).toBe(true);
    expect(canAccessTeamDocument(TeamMemberRole.SGC, DocumentVisibility.EVERYONE)).toBe(true);

    expect(canAccessTeamDocument(TeamMemberRole.MANAGER, DocumentVisibility.ADMIN)).toBe(false);
    expect(canAccessTeamDocument(TeamMemberRole.MANAGER, DocumentVisibility.MANAGER_AND_ABOVE)).toBe(true);

    expect(canAccessTeamDocument(TeamMemberRole.MEMBER, DocumentVisibility.MANAGER_AND_ABOVE)).toBe(false);
    expect(canAccessTeamDocument(TeamMemberRole.MEMBER, DocumentVisibility.EVERYONE)).toBe(true);
  });
});

describe('TEAM_MEMBER_ROLE_HIERARCHY', () => {
  it('allows ADMIN to manage SGC', () => {
    expect(isTeamRoleWithinUserHierarchy(TeamMemberRole.ADMIN, TeamMemberRole.SGC)).toBe(true);
  });

  it('does not allow MANAGER to manage SGC', () => {
    expect(isTeamRoleWithinUserHierarchy(TeamMemberRole.MANAGER, TeamMemberRole.SGC)).toBe(false);
  });

  it('allows SGC to manage MANAGER and MEMBER but not ADMIN', () => {
    expect(isTeamRoleWithinUserHierarchy(TeamMemberRole.SGC, TeamMemberRole.MANAGER)).toBe(true);
    expect(isTeamRoleWithinUserHierarchy(TeamMemberRole.SGC, TeamMemberRole.MEMBER)).toBe(true);
    expect(isTeamRoleWithinUserHierarchy(TeamMemberRole.SGC, TeamMemberRole.ADMIN)).toBe(false);
  });
});

describe('getHighestTeamRoleInGroup', () => {
  const teamGroup = (teamRole: TeamMemberRole): TeamGroup => ({
    id: `team_group_test_${teamRole.toLowerCase()}`,
    organisationGroupId: `org_group_test_${teamRole.toLowerCase()}`,
    teamId: 1,
    teamRole,
  });

  it('ranks SGC above MANAGER and below ADMIN', () => {
    expect(getHighestTeamRoleInGroup([teamGroup(TeamMemberRole.MANAGER), teamGroup(TeamMemberRole.SGC)])).toBe(
      TeamMemberRole.SGC,
    );

    expect(getHighestTeamRoleInGroup([teamGroup(TeamMemberRole.SGC), teamGroup(TeamMemberRole.ADMIN)])).toBe(
      TeamMemberRole.ADMIN,
    );

    expect(getHighestTeamRoleInGroup([teamGroup(TeamMemberRole.MEMBER)])).toBe(TeamMemberRole.MEMBER);
  });
});
