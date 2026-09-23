import { IS_BILLING_ENABLED } from '../../constants/app';
import type { TCssVarsSchema } from '../../types/css-vars';
import { resolveEnvelopeBranding } from '../envelope/branding-snapshot';
import { getOrganisationClaimByTeamId } from '../organisation/get-organisation-claims';
import { getTeamSettings } from '../team/get-team-settings';

export type RecipientBrandingPayload = {
  allowCustomBranding: boolean;
  hidePoweredBy: boolean;
  colors: TCssVarsSchema | null;
  css: string | null;
};

/**
 * Resolve the branding payload for a recipient-facing route, given the envelope
 * being rendered. The branding comes from the envelope's pinned snapshot, so a
 * recipient never sees a branding change that happened while the envelope was
 * in flight; envelopes created before the pin existed
 * (`brandingSnapshot` null) fall back to the inherited team-or-org settings.
 *
 * The org's claim flags are checked against the live team, and a minimal
 * disabled payload is returned when the team is not on a plan that allows
 * custom branding.
 */
export const loadRecipientBranding = async ({
  teamId,
  brandingSnapshot,
}: {
  teamId: number;

  /**
   * The `brandingSnapshot` column of the envelope being rendered.
   */
  brandingSnapshot: unknown;
}): Promise<RecipientBrandingPayload> => {
  const billingEnabled = IS_BILLING_ENABLED();

  const [settings, claim] = await Promise.all([
    getTeamSettings({ teamId }),
    billingEnabled ? getOrganisationClaimByTeamId({ teamId }).catch(() => null) : Promise.resolve(null),
  ]);

  let allowCustomBranding = !billingEnabled || claim?.flags?.embedSigningWhiteLabel === true;
  const hidePoweredBy = !billingEnabled || claim?.flags?.hidePoweredBy === true;

  const { branding } = resolveEnvelopeBranding({ brandingSnapshot, liveBranding: settings });

  if (!branding.enabled) {
    allowCustomBranding = false;
  }

  if (!allowCustomBranding) {
    return {
      allowCustomBranding: false,
      hidePoweredBy,
      colors: null,
      css: null,
    };
  }

  return {
    allowCustomBranding: true,
    hidePoweredBy,
    colors: branding.colors,
    css: branding.css.length > 0 ? branding.css : null,
  };
};
