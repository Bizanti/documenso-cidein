import { prisma } from '@documenso/prisma';

import { AppError, AppErrorCode } from '../../errors/app-error';
import type { TFolderType } from '../../types/folder-type';
import { FolderType } from '../../types/folder-type';
import { buildTeamWhereQuery } from '../../utils/teams';
import { assertCanManageDocumentsById } from '../auth/document-authorization';
import { getTeamSettings } from '../team/get-team-settings';

export interface CreateFolderOptions {
  userId: number;
  teamId: number;
  name: string;
  parentId?: string | null;
  type?: TFolderType;
}

export const createFolder = async ({
  userId,
  teamId,
  name,
  parentId,
  type = FolderType.DOCUMENT,
}: CreateFolderOptions) => {
  // Refuse to create a folder on behalf of a restricted (sign only) account,
  // with the roles read fresh from the database. Guards every caller, including
  // the ones which do not come through the tRPC write closure.
  await assertCanManageDocumentsById({ userId });

  // This indirectly verifies whether the user has access to the team.
  const settings = await getTeamSettings({ userId, teamId });

  if (parentId) {
    const parentFolder = await prisma.folder.findFirst({
      where: {
        id: parentId,
        team: buildTeamWhereQuery({ teamId, userId }),
      },
    });

    if (!parentFolder) {
      throw new AppError(AppErrorCode.NOT_FOUND, {
        message: 'Parent folder not found',
      });
    }

    if (parentFolder.type !== type) {
      throw new AppError(AppErrorCode.INVALID_BODY, {
        message: 'Parent folder type does not match the folder type',
      });
    }
  }

  return await prisma.folder.create({
    data: {
      name,
      userId,
      teamId,
      parentId,
      type,
      visibility: settings.documentVisibility,
    },
  });
};
