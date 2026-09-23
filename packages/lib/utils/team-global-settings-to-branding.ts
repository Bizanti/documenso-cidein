import type { OrganisationGlobalSettings } from '@prisma/client';

import { NEXT_PUBLIC_WEBAPP_URL } from '../constants/app';
import type { TCssVarsSchema } from '../types/css-vars';
import { ZCssVarsSchema } from '../types/css-vars';
import { resolveEmailBrandingColors } from './email-branding-colors';

export const teamGlobalSettingsToBranding = (
  settings: Omit<OrganisationGlobalSettings, 'id'>,
  teamId: number,
  hidePoweredBy: boolean,
) => {
  const parsedColors = settings.brandingColors ? ZCssVarsSchema.safeParse(settings.brandingColors) : null;
  const resolvedBrandingColors = resolveEmailBrandingColors(parsedColors?.success ? parsedColors.data : null);

  return {
    ...settings,
    brandingLogo:
      settings.brandingEnabled && settings.brandingLogo
        ? `${NEXT_PUBLIC_WEBAPP_URL()}/api/branding/logo/team/${teamId}`
        : '',
    brandingHidePoweredBy: hidePoweredBy,
    brandingColors: resolvedBrandingColors ?? undefined,
  };
};

export const organisationGlobalSettingsToBranding = (
  settings: Omit<OrganisationGlobalSettings, 'id'>,
  organisationId: string,
  hidePoweredBy: boolean,
) => {
  const parsedColors = settings.brandingColors ? ZCssVarsSchema.safeParse(settings.brandingColors) : null;
  const resolvedBrandingColors = resolveEmailBrandingColors(parsedColors?.success ? parsedColors.data : null);

  return {
    ...settings,
    brandingLogo:
      settings.brandingEnabled && settings.brandingLogo
        ? `${NEXT_PUBLIC_WEBAPP_URL()}/api/branding/logo/organisation/${organisationId}`
        : '',
    brandingHidePoweredBy: hidePoweredBy,
    brandingColors: resolvedBrandingColors ?? undefined,
  };
};

/**
 * The branding an envelope is pinned to, resolved for email rendering: the
 * pinned logo reference has already been turned into a URL (the live endpoint
 * while it still serves the pinned bytes, the pinned bytes inlined once it does
 * not).
 */
export type PinnedEmailBranding = {
  enabled: boolean;
  logoUrl: string;
  url: string;
  companyDetails: string;
  colors: TCssVarsSchema | null;
};

/**
 * The email branding of an envelope, sourced from its pinned branding instead
 * of the live settings: editing the branding while an envelope is in flight
 * must not change the emails that envelope sends.
 */
export const teamGlobalSettingsToPinnedEmailBranding = (
  settings: Omit<OrganisationGlobalSettings, 'id'>,
  hidePoweredBy: boolean,
  pinned: PinnedEmailBranding,
) => {
  return {
    ...settings,
    brandingEnabled: pinned.enabled,
    brandingLogo: pinned.logoUrl,
    brandingUrl: pinned.url,
    brandingCompanyDetails: pinned.companyDetails,
    brandingHidePoweredBy: hidePoweredBy,
    brandingColors: resolveEmailBrandingColors(pinned.colors) ?? undefined,
  };
};
