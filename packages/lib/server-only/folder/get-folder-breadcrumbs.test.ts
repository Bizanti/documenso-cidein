import { prisma } from '@documenso/prisma';
import { DocumentVisibility, TeamMemberRole } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getTeamById } from '../team/get-team';
import { getFolderBreadcrumbs } from './get-folder-breadcrumbs';

vi.mock('@documenso/prisma', () => ({
  prisma: {
    folder: {
      findFirst: vi.fn(),
    },
  },
}));

vi.mock('../team/get-team', () => ({
  getTeamById: vi.fn(),
}));

type FindFirstArgs = {
  where: {
    OR: [
      {
        visibility: {
          in: DocumentVisibility[];
        };
      },
      unknown,
    ];
  };
};

/**
 * Resolves the visibilities the breadcrumbs query filters on for a given role.
 */
const getFilteredVisibilities = async (role: TeamMemberRole) => {
  vi.mocked(getTeamById).mockResolvedValue({
    currentTeamRole: role,
  } as unknown as Awaited<ReturnType<typeof getTeamById>>);

  await getFolderBreadcrumbs({ userId: 1, teamId: 1, folderId: 'folder_test' });

  const [call] = vi.mocked(prisma.folder.findFirst).mock.calls;

  return (call[0] as unknown as FindFirstArgs).where.OR[0].visibility.in;
};

describe('getFolderBreadcrumbs', () => {
  beforeEach(() => {
    vi.mocked(prisma.folder.findFirst).mockReset();
    vi.mocked(prisma.folder.findFirst).mockResolvedValue(null);
    vi.mocked(getTeamById).mockReset();
  });

  it('grants ADMIN every visibility', async () => {
    const visibilities = await getFilteredVisibilities(TeamMemberRole.ADMIN);

    expect(visibilities).toHaveLength(3);
    expect(visibilities).toEqual(
      expect.arrayContaining([
        DocumentVisibility.EVERYONE,
        DocumentVisibility.MANAGER_AND_ABOVE,
        DocumentVisibility.ADMIN,
      ]),
    );
  });

  it('grants SGC the same visibilities as ADMIN', async () => {
    const visibilities = await getFilteredVisibilities(TeamMemberRole.SGC);

    expect(visibilities).toHaveLength(3);
    expect(visibilities).toEqual(
      expect.arrayContaining([
        DocumentVisibility.EVERYONE,
        DocumentVisibility.MANAGER_AND_ABOVE,
        DocumentVisibility.ADMIN,
      ]),
    );
  });

  it('limits MANAGER to EVERYONE and MANAGER_AND_ABOVE', async () => {
    const visibilities = await getFilteredVisibilities(TeamMemberRole.MANAGER);

    expect(visibilities).toHaveLength(2);
    expect(visibilities).toEqual(
      expect.arrayContaining([DocumentVisibility.EVERYONE, DocumentVisibility.MANAGER_AND_ABOVE]),
    );
    expect(visibilities).not.toContain(DocumentVisibility.ADMIN);
  });

  it('limits MEMBER to EVERYONE', async () => {
    const visibilities = await getFilteredVisibilities(TeamMemberRole.MEMBER);

    expect(visibilities).toEqual([DocumentVisibility.EVERYONE]);
  });

  it('filters parent folder lookups with the same role visibilities', async () => {
    vi.mocked(getTeamById).mockResolvedValue({
      currentTeamRole: TeamMemberRole.SGC,
    } as unknown as Awaited<ReturnType<typeof getTeamById>>);

    vi.mocked(prisma.folder.findFirst)
      .mockResolvedValueOnce({ id: 'folder_child', parentId: 'folder_parent' } as never)
      .mockResolvedValue({ id: 'folder_parent', parentId: null } as never);

    const breadcrumbs = await getFolderBreadcrumbs({ userId: 1, teamId: 1, folderId: 'folder_child' });

    expect(breadcrumbs.map((folder) => folder.id)).toEqual(['folder_parent', 'folder_child']);

    for (const [call] of vi.mocked(prisma.folder.findFirst).mock.calls) {
      expect((call as unknown as FindFirstArgs).where.OR[0].visibility.in).toHaveLength(3);
    }
  });
});
