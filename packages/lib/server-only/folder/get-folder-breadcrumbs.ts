import { prisma } from '@documenso/prisma';

import { TEAM_DOCUMENT_VISIBILITY_MAP } from '../../constants/teams';
import type { TFolderType } from '../../types/folder-type';
import { getTeamById } from '../team/get-team';

export interface GetFolderBreadcrumbsOptions {
  userId: number;
  teamId: number;
  folderId: string;
  type?: TFolderType;
}

export const getFolderBreadcrumbs = async ({ userId, teamId, folderId, type }: GetFolderBreadcrumbsOptions) => {
  const team = await getTeamById({ userId, teamId });

  const visibilityFilters = {
    visibility: {
      in: TEAM_DOCUMENT_VISIBILITY_MAP[team.currentTeamRole],
    },
  };

  const whereClause = (folderId: string) => ({
    id: folderId,
    ...(type ? { type } : {}),
    OR: [
      { teamId, ...visibilityFilters },
      { userId, teamId },
    ],
  });

  const breadcrumbs = [];
  let currentFolderId = folderId;

  const currentFolder = await prisma.folder.findFirst({
    where: whereClause(currentFolderId),
  });

  if (!currentFolder) {
    return [];
  }

  breadcrumbs.push(currentFolder);

  while (currentFolder?.parentId) {
    const parentFolder = await prisma.folder.findFirst({
      where: whereClause(currentFolder.parentId),
    });

    if (!parentFolder) {
      break;
    }

    breadcrumbs.unshift(parentFolder);
    currentFolderId = parentFolder.id;
    currentFolder.parentId = parentFolder.parentId;
  }

  return breadcrumbs;
};
