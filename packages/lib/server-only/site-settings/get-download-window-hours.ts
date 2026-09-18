import { prisma } from '@documenso/prisma';

import { SITE_SETTINGS_DOWNLOAD_WINDOW_ID, ZSiteSettingsDownloadWindowSchema } from './schemas/download-window';

/**
 * Returns the global download window in hours, or `null` when downloads do not
 * expire (setting missing or disabled). Consumers combine this with a
 * per-document/template value when one is set.
 */
export const getDownloadWindowHours = async (): Promise<number | null> => {
  const setting = await prisma.siteSettings.findFirst({
    where: {
      id: SITE_SETTINGS_DOWNLOAD_WINDOW_ID,
    },
  });

  if (!setting?.enabled) {
    return null;
  }

  const parsed = ZSiteSettingsDownloadWindowSchema.parse(setting);

  return parsed.data.hours;
};
