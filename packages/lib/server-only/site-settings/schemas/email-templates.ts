import { z } from 'zod';

import { ZSiteSettingsBaseSchema } from './_base';

export const SITE_SETTINGS_EMAIL_TEMPLATES_ID = 'site.email-templates';

export const EMAIL_TEMPLATE_IDS = [
  'signing-request',
  'document-pending',
  'document-completed',
  'document-cancelled',
  'document-rejected',
] as const;

export const ZEmailTemplateIdSchema = z.enum(EMAIL_TEMPLATE_IDS);

export type TEmailTemplateId = z.infer<typeof ZEmailTemplateIdSchema>;

export const ZEmailTemplateOverrideSchema = z.object({
  subject: z.string().max(500).optional().default(''),
  body: z.string().max(10000).optional().default(''),
});

export type TEmailTemplateOverride = z.infer<typeof ZEmailTemplateOverrideSchema>;

export const ZSiteSettingsEmailTemplatesSchema = ZSiteSettingsBaseSchema.extend({
  id: z.literal(SITE_SETTINGS_EMAIL_TEMPLATES_ID),
  data: z
    .object({
      templates: z.record(ZEmailTemplateIdSchema, ZEmailTemplateOverrideSchema).default({}),
    })
    .optional()
    .default({
      templates: {},
    }),
});

export type TSiteSettingsEmailTemplatesSchema = z.infer<typeof ZSiteSettingsEmailTemplatesSchema>;
