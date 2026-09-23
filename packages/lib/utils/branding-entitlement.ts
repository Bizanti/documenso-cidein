import { IS_BILLING_ENABLED } from '../constants/app';
import type { TClaimFlags } from '../types/subscription';
import { env } from './env';

/**
 * Whether custom branding CSS (`brandingCss`) is available on this instance.
 *
 * Disabled by default, and intentionally so for the current phase: a single CSS
 * rule can hide signature states, warnings or controls, so the customisation
 * surface is limited to colour variables and allowed assets until CSS can be
 * sandboxed properly.
 *
 * This is the single switch for that decision. It gates every layer:
 * the branding preferences form renders the CSS textarea disabled,
 * `team.settings.update` / `organisation.settings.update` refuse to persist a
 * value, and `RecipientBranding` never injects a stored value.
 */
export const isBrandingCssEnabled = () => env('NEXT_PUBLIC_FEATURE_BRANDING_CSS_ENABLED') === 'true';

/**
 * Whether the organisation's claim allows configuring custom branding
 * (`allowCustomBranding`: logo, brand website, brand details, colours and CSS).
 *
 * Mirrors the upstream semantics used by the settings pages: with billing
 * disabled the check short-circuits to allowed so self-hosted instances are
 * unaffected.
 */
export const canConfigureBranding = (flags: TClaimFlags | null | undefined) =>
  flags?.allowCustomBranding === true || !IS_BILLING_ENABLED();

/**
 * Whether the organisation's claim unlocks the advanced branding block —
 * brand colours, border radius and custom CSS (`embedSigningWhiteLabel`
 * upstream). Same billing short-circuit as `canConfigureBranding`.
 */
export const canUseAdvancedBranding = (flags: TClaimFlags | null | undefined) =>
  flags?.embedSigningWhiteLabel === true || !IS_BILLING_ENABLED();

/**
 * The branding fields of the `team.settings.update` /
 * `organisation.settings.update` payloads. Kept in one place so both routes gate
 * on exactly the same set of fields.
 */
const BRANDING_SETTINGS_FIELDS = [
  'brandingEnabled',
  'brandingUrl',
  'brandingCompanyDetails',
  'brandingColors',
] as const;

export type BrandingSettingsPayload = Partial<
  Record<(typeof BRANDING_SETTINGS_FIELDS)[number] | 'brandingCss', unknown>
>;

/**
 * Whether a settings update payload requests a branding change, i.e. whether it
 * has to pass the custom-branding entitlement gate.
 *
 * An explicit `null` counts as a change: for teams it means "inherit from the
 * organisation", which is itself a branding update. `brandingCss` only counts
 * while the CSS feature is enabled — otherwise the routes ignore the field
 * anyway (see `isBrandingCssEnabled`).
 */
export const hasBrandingSettingsUpdate = (data: BrandingSettingsPayload): boolean =>
  BRANDING_SETTINGS_FIELDS.some((field) => data[field] !== undefined) ||
  (isBrandingCssEnabled() && data.brandingCss !== undefined);
