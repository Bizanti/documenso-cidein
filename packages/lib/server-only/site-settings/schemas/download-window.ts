import { z } from 'zod';

import { ZSiteSettingsBaseSchema } from './_base';

export const SITE_SETTINGS_DOWNLOAD_WINDOW_ID = 'site.download-window';

export const ZSiteSettingsDownloadWindowSchema = ZSiteSettingsBaseSchema.extend({
  id: z.literal(SITE_SETTINGS_DOWNLOAD_WINDOW_ID),
  data: z
    .object({
      hours: z.number().int().min(1).max(8760),
    })
    .optional()
    .default({
      hours: 48,
    }),
});

export type TSiteSettingsDownloadWindowSchema = z.infer<typeof ZSiteSettingsDownloadWindowSchema>;
