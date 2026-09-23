import type { OrganisationGlobalSettings } from '@prisma/client';
import { z } from 'zod';
import type { TCssVarsSchema } from '../../types/css-vars';
import { ZCssVarsSchema } from '../../types/css-vars';
import { sha256 } from '../../universal/crypto';
import { getFileServerSide } from '../../universal/upload/get-file.server';
import { loadLogo } from '../../utils/images/logo';
import { getTeamSettings } from '../team/get-team-settings';

/**
 * The branding an envelope is pinned to for its whole life.
 *
 * Branding used to be resolved live on every render, which meant that editing
 * a team or organisation branding while an envelope was in flight silently
 * changed what a signer saw between two page loads, and made the artifacts
 * (and their evidence) disagree with each other. The snapshot is written once,
 * when the envelope is created, and every reader must prefer it.
 */
export const ZEnvelopeBrandingSnapshotSchema = z.object({
  /** Version of the snapshot payload itself. Unknown versions fall back to live settings. */
  version: z.literal(1),

  /**
   * Whether the branding was captured when the envelope was created, or
   * resolved after the fact by the backfill migration. Only `capture` is
   * first-hand evidence of what the signer saw.
   */
  source: z.enum(['capture', 'backfill']),

  /** The branding scope that was resolved, e.g. `team:12`. */
  brandId: z.string(),

  /** When the branding was resolved (ISO 8601, UTC). */
  capturedAt: z.string(),

  /** The six derived branding fields (team value over organisation value). */
  enabled: z.boolean(),
  logo: z.string(),
  url: z.string(),
  companyDetails: z.string(),
  colors: ZCssVarsSchema.nullable(),
  css: z.string(),

  /** SHA-256 of the pinned logo reference. Null when no logo was pinned. */
  logoHash: z.string().nullable(),

  /** Short, URL-safe key derived from `logoHash`, for cache busting. */
  logoVersion: z.string().nullable(),

  /**
   * Content hash of the six pinned fields: two envelopes share it if and only
   * if they pinned the same branding. The byte encoding is not part of the
   * contract (the backfill migration hashes an equivalent structure in SQL).
   */
  brandVersion: z.string(),
});

export type TEnvelopeBrandingSnapshot = z.infer<typeof ZEnvelopeBrandingSnapshotSchema>;

/**
 * The six branding fields of `getTeamSettings`, after the team values have been
 * merged over the organisation ones by `extractDerivedTeamSettings`.
 */
export type TDerivedBrandingSettings = Pick<
  Omit<OrganisationGlobalSettings, 'id'>,
  'brandingEnabled' | 'brandingLogo' | 'brandingUrl' | 'brandingCompanyDetails' | 'brandingColors' | 'brandingCss'
>;

/** The branding an envelope is pinned to, or the live settings when it has no snapshot. */
export type TResolvedEnvelopeBranding = {
  enabled: boolean;
  logo: string;
  url: string;
  companyDetails: string;
  colors: TCssVarsSchema | null;
  css: string;
};

export const hashBrandingLogo = (logo: string) => Buffer.from(sha256(logo)).toString('hex');

/**
 * Build the branding snapshot payload. `settings` must already be the derived
 * team-over-organisation settings (i.e. the return of `getTeamSettings`).
 */
export const buildEnvelopeBrandingSnapshot = ({
  teamId,
  settings,
  source = 'capture',
}: {
  teamId: number;
  settings: TDerivedBrandingSettings;
  source?: TEnvelopeBrandingSnapshot['source'];
}): TEnvelopeBrandingSnapshot => {
  const logo = settings.brandingLogo;
  const logoHash = logo.length > 0 ? hashBrandingLogo(logo) : null;

  const colors = settings.brandingColors ? ZCssVarsSchema.safeParse(settings.brandingColors) : null;

  const branding = {
    enabled: settings.brandingEnabled,
    logo,
    url: settings.brandingUrl,
    companyDetails: settings.brandingCompanyDetails,
    colors: colors?.success ? colors.data : null,
    css: settings.brandingCss,
  };

  return ZEnvelopeBrandingSnapshotSchema.parse({
    version: 1,
    source,
    brandId: `team:${teamId}`,
    capturedAt: new Date().toISOString(),
    ...branding,
    logoHash,
    logoVersion: logoHash ? logoHash.slice(0, 16) : null,
    brandVersion: hashBrandingLogo(JSON.stringify(branding)),
  });
};

/**
 * Pin the branding of a team (with organisation inheritance) onto a new envelope.
 */
export const getEnvelopeBrandingSnapshotForTeam = async ({ teamId }: { teamId: number }) => {
  const settings = await getTeamSettings({ teamId });

  return buildEnvelopeBrandingSnapshot({ teamId, settings });
};

/**
 * Parse a `Envelope.brandingSnapshot` column value. Returns null for envelopes
 * created before the pin existed (and for payloads this build cannot read),
 * which readers treat as "fall back to live settings".
 */
export const parseEnvelopeBrandingSnapshot = (value: unknown): TEnvelopeBrandingSnapshot | null => {
  if (value === null || value === undefined) {
    return null;
  }

  const parsed = ZEnvelopeBrandingSnapshotSchema.safeParse(value);

  return parsed.success ? parsed.data : null;
};

/**
 * Resolve the branding an envelope must be rendered with: the pinned snapshot
 * when it has one, the live settings otherwise.
 *
 * A resolved branding that is not enabled is inert: logo, url, company details,
 * colors and css are all empty, whether the branding was switched off before or
 * after the envelope was pinned.
 */
export const resolveEnvelopeBranding = ({
  brandingSnapshot,
  liveBranding,
}: {
  brandingSnapshot: unknown;
  liveBranding: TDerivedBrandingSettings;
}): { branding: TResolvedEnvelopeBranding; isPinned: boolean } => {
  const snapshot = parseEnvelopeBrandingSnapshot(brandingSnapshot);

  const colors = snapshot
    ? snapshot.colors
    : liveBranding.brandingColors
      ? (ZCssVarsSchema.safeParse(liveBranding.brandingColors).data ?? null)
      : null;

  const branding: TResolvedEnvelopeBranding = snapshot
    ? {
        enabled: snapshot.enabled,
        logo: snapshot.logo,
        url: snapshot.url,
        companyDetails: snapshot.companyDetails,
        colors,
        css: snapshot.css,
      }
    : {
        enabled: liveBranding.brandingEnabled,
        logo: liveBranding.brandingLogo,
        url: liveBranding.brandingUrl,
        companyDetails: liveBranding.brandingCompanyDetails,
        colors,
        css: liveBranding.brandingCss,
      };

  if (!branding.enabled) {
    return {
      isPinned: Boolean(snapshot),
      branding: {
        enabled: false,
        logo: '',
        url: '',
        companyDetails: '',
        colors: null,
        css: '',
      },
    };
  }

  return { isPinned: Boolean(snapshot), branding };
};

/**
 * The bytes of a pinned branding logo, shaped for the message that has to carry
 * them: an inline MIME part the rendered logo references as `cid:<contentId>`.
 */
export type TBrandingLogoAttachment = {
  /**
   * The MIME content id the message references the part by. Derived from the
   * bytes, so the same logo always resolves to the same id and two messages can
   * never disagree about what an id holds.
   */
  contentId: string;
  contentType: string;
  /**
   * The logo's bytes, base64-encoded. Base64 is what the MIME part carries
   * anyway, and keeping it textual means the attachment survives being passed
   * through a serializable payload.
   */
  contentBase64: string;
  /** The name the part reports: some clients only render named inline images. */
  filename: string;
};

/** The form the caller's medium can carry the pinned bytes in. */
export type TBrandingLogoReference =
  /** A `data:` URL, rendered inside the document (the web signing pages). */
  | 'data-url'
  /**
   * A `cid:` reference, carried by the caller as an inline MIME part (emails).
   * The bytes travel inside the message, so a recipient opening it months later
   * still sees the pinned logo, and mail clients render `cid:` reliably (unlike
   * the `data:` URLs Gmail refuses to render in a body).
   */
  | 'content-id';

export type TResolvedSigningBranding = {
  brandingEnabled: boolean;
  /** The pinned logo reference (what the snapshot stores), or the live one when there is no snapshot. */
  brandingLogo: string;
  /** Where the surface renders the logo from. Null when the pinned bytes could not be read. */
  brandingLogoUrl: string | null;
  /** The bytes the `cid:` reference points at; set for `content-id` references only. */
  brandingLogoAttachment: TBrandingLogoAttachment | null;
};

/**
 * Resolve the branding a surface must render, including the reference for the
 * custom branding logo.
 *
 * A pinned envelope is never rendered from the live endpoint
 * (`/api/branding/logo/team/:teamId`): that endpoint resolves the live
 * configuration, so an artifact opened after the branding changed would show a
 * logo the envelope never used — or a broken image when the branding was
 * disabled. The pinned bytes are inlined instead, in the form the caller's
 * medium can carry (see `TBrandingLogoReference`), which is what makes the
 * reference immutable.
 *
 * Live branding — an envelope without a snapshot, and every non-envelope email —
 * keeps using the live endpoint: there is no pinned version to protect.
 */
export const resolveSigningBranding = async ({
  teamId,
  brandingSnapshot,
  liveBranding,
  logoReference = 'data-url',
}: {
  teamId: number;
  brandingSnapshot: unknown;
  liveBranding: TDerivedBrandingSettings;
  logoReference?: TBrandingLogoReference;
}): Promise<TResolvedSigningBranding> => {
  const { branding, isPinned } = resolveEnvelopeBranding({ brandingSnapshot, liveBranding });

  if (!branding.enabled || branding.logo.length === 0) {
    return { brandingEnabled: false, brandingLogo: '', brandingLogoUrl: null, brandingLogoAttachment: null };
  }

  if (!isPinned) {
    return {
      brandingEnabled: true,
      brandingLogo: branding.logo,
      brandingLogoUrl: `/api/branding/logo/team/${teamId}`,
      brandingLogoAttachment: null,
    };
  }

  const pinnedLogo = await loadPinnedBrandingLogo(branding.logo);

  // The pinned bytes are gone: rendering the live logo instead would show a
  // version that was never part of this envelope, so the branding renders
  // without a custom logo.
  if (!pinnedLogo) {
    return { brandingEnabled: true, brandingLogo: branding.logo, brandingLogoUrl: null, brandingLogoAttachment: null };
  }

  const { dataUrl, ...attachment } = pinnedLogo;

  if (logoReference === 'content-id') {
    return {
      brandingEnabled: true,
      brandingLogo: branding.logo,
      brandingLogoUrl: `cid:${attachment.contentId}`,
      brandingLogoAttachment: attachment,
    };
  }

  return { brandingEnabled: true, brandingLogo: branding.logo, brandingLogoUrl: dataUrl, brandingLogoAttachment: null };
};

/**
 * Load the bytes a pinned logo reference points at, in both forms the readers
 * need: the `data:` URL a document renders, and the inline MIME part an email
 * carries. Returns null when the bytes cannot be read.
 */
const loadPinnedBrandingLogo = async (
  logo: string,
): Promise<(TBrandingLogoAttachment & { dataUrl: string }) | null> => {
  try {
    const file = await getFileServerSide(JSON.parse(logo));

    const { content, contentType } = await loadLogo(file);
    const bytes = Buffer.from(content);
    const contentBase64 = bytes.toString('base64');

    return {
      contentId: `branding-logo-${Buffer.from(sha256(bytes)).toString('hex').slice(0, 16)}`,
      contentType,
      contentBase64,
      filename: 'branding-logo.png',
      dataUrl: `data:${contentType};base64,${contentBase64}`,
    };
  } catch (error) {
    console.error('Failed to load the pinned branding logo', error);

    return null;
  }
};
