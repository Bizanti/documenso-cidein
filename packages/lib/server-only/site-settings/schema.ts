import { z } from 'zod';

import { ZSiteSettingsBannerSchema } from './schemas/banner';
import { ZSiteSettingsDownloadWindowSchema } from './schemas/download-window';
import { ZSiteSettingsEmailBlocklistSchema } from './schemas/email-blocklist';
import { ZSiteSettingsEmailTemplatesSchema } from './schemas/email-templates';
import { ZSiteSettingsTelemetrySchema } from './schemas/telemetry';

export const ZSiteSettingSchema = z.union([
  ZSiteSettingsBannerSchema,
  ZSiteSettingsDownloadWindowSchema,
  ZSiteSettingsEmailBlocklistSchema,
  ZSiteSettingsEmailTemplatesSchema,
  ZSiteSettingsTelemetrySchema,
]);

export type TSiteSettingSchema = z.infer<typeof ZSiteSettingSchema>;

export const ZSiteSettingsSchema = z.array(ZSiteSettingSchema);

export type TSiteSettingsSchema = z.infer<typeof ZSiteSettingsSchema>;
