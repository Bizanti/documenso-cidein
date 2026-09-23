import { getFileServerSide } from '../../universal/upload/get-file.server';
import { loadLogo } from '../../utils/images/logo';
import { resolveEnvelopeBranding } from '../envelope/branding-snapshot';
import { getOrganisationClaimByTeamId } from '../organisation/get-organisation-claims';
import { getTeamSettings } from '../team/get-team-settings';

export type TDocumentBrandLogo = {
  content: Buffer;
  contentType: string;
};

/**
 * The brand a generated PDF artifact (certificate, audit log) must be stamped
 * with.
 *
 * The artifacts are appended to the document before it is sealed, so whatever
 * is resolved here ends up covered by the X.509 signature. The brand therefore
 * comes from the envelope's pinned snapshot rather than the live settings: a
 * team that edits or drops its branding must not change what a sealed document
 * (or its on-demand regeneration) shows.
 */
export type TDocumentBranding = {
  /**
   * The pinned brand logo, or null when the artifact must fall back to the
   * Documenso mark.
   */
  logo: TDocumentBrandLogo | null;

  /** Whether the Documenso powered-by mark is hidden by the organisation claim. */
  hidePoweredBy: boolean;
};

/**
 * Resolve the brand mark of a document's generated artifacts.
 *
 * Only a pinned branding that is enabled and carries a logo produces a brand
 * mark; anything else (no snapshot, branding disabled, no logo, unreadable
 * logo) falls back to the Documenso mark so a broken logo can never block
 * sealing.
 */
export const resolveDocumentBranding = async ({
  teamId,
  brandingSnapshot,
}: {
  teamId: number;

  /**
   * The `brandingSnapshot` column of the document being rendered.
   */
  brandingSnapshot: unknown;
}): Promise<TDocumentBranding> => {
  const [settings, organisationClaim] = await Promise.all([
    getTeamSettings({ teamId }),
    getOrganisationClaimByTeamId({ teamId }),
  ]);

  const hidePoweredBy = organisationClaim.flags.hidePoweredBy ?? false;

  const { branding } = resolveEnvelopeBranding({ brandingSnapshot, liveBranding: settings });

  if (!branding.enabled || branding.logo.length === 0) {
    return { logo: null, hidePoweredBy };
  }

  return {
    logo: await loadBrandingLogo(branding.logo),
    hidePoweredBy,
  };
};

/**
 * Whether the artifact must render a mark at all: a pinned brand replaces the
 * Documenso mark, and `hidePoweredBy` only hides the Documenso one.
 */
export const shouldRenderBrandMark = (branding: TDocumentBranding) => branding.logo !== null || !branding.hidePoweredBy;

export const toBrandLogoDataUrl = (logo: TDocumentBrandLogo) =>
  `data:${logo.contentType};base64,${Buffer.from(logo.content).toString('base64')}`;

const loadBrandingLogo = async (logo: string): Promise<TDocumentBrandLogo | null> => {
  try {
    const file = await getFileServerSide(JSON.parse(logo));

    const { content, contentType } = await loadLogo(file);

    return { content, contentType };
  } catch (error) {
    console.error('Failed to load the pinned branding logo', error);

    return null;
  }
};
