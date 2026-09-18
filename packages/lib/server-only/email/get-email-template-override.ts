import { prisma } from '@documenso/prisma';

import type { TEmailTemplateId, TEmailTemplateOverride } from '../site-settings/schemas/email-templates';
import {
  SITE_SETTINGS_EMAIL_TEMPLATES_ID,
  ZSiteSettingsEmailTemplatesSchema,
} from '../site-settings/schemas/email-templates';

/**
 * Returns the admin-defined subject/body override for a transactional email
 * template, or `null` when no usable override exists (setting missing,
 * disabled, or both fields blank) and the default template should be used.
 */
export const getEmailTemplateOverride = async (
  templateId: TEmailTemplateId,
): Promise<TEmailTemplateOverride | null> => {
  const setting = await prisma.siteSettings.findFirst({
    where: {
      id: SITE_SETTINGS_EMAIL_TEMPLATES_ID,
    },
  });

  if (!setting?.enabled) {
    return null;
  }

  const parsed = ZSiteSettingsEmailTemplatesSchema.parse(setting);

  const override = parsed.data.templates[templateId];

  if (!override || (!override.subject.trim() && !override.body.trim())) {
    return null;
  }

  return override;
};
