import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getFileServerSide } from '../../universal/upload/get-file.server';
import { loadLogo } from '../../utils/images/logo';
import { buildEnvelopeBrandingSnapshot } from '../envelope/branding-snapshot';
import { getOrganisationClaimByTeamId } from '../organisation/get-organisation-claims';
import { getTeamSettings } from '../team/get-team-settings';
import { resolveDocumentBranding, shouldRenderBrandMark, toBrandLogoDataUrl } from './document-branding';

vi.mock('../team/get-team-settings');
vi.mock('../organisation/get-organisation-claims');
vi.mock('../../universal/upload/get-file.server');
vi.mock('../../utils/images/logo');

// A logo reference in the same shape the branding logo column stores.
const PINNED_LOGO = JSON.stringify({ type: 'BYTES_64', data: 'AQID' });

const UNBRANDED_SETTINGS = {
  brandingEnabled: false,
  brandingLogo: '',
  brandingUrl: '',
  brandingCompanyDetails: '',
  brandingColors: null,
  brandingCss: '',
};

const LIVE_BRANDED_SETTINGS = {
  ...UNBRANDED_SETTINGS,
  brandingEnabled: true,
  brandingLogo: 'live-logo',
};

const buildPinnedSnapshot = ({ brandingEnabled = true, brandingLogo = PINNED_LOGO } = {}) =>
  buildEnvelopeBrandingSnapshot({
    teamId: 7,
    settings: {
      ...LIVE_BRANDED_SETTINGS,
      brandingEnabled,
      brandingLogo,
    },
  });

const mockBrandLogo = () => {
  vi.mocked(getFileServerSide).mockResolvedValue(Buffer.from([1, 2, 3]) as never);
  vi.mocked(loadLogo).mockResolvedValue({ contentType: 'image/png', content: Buffer.from([1, 2, 3]) } as never);
};

beforeEach(() => {
  vi.resetAllMocks();

  vi.mocked(getTeamSettings).mockResolvedValue(UNBRANDED_SETTINGS as never);
  vi.mocked(getOrganisationClaimByTeamId).mockResolvedValue({ flags: { hidePoweredBy: false } } as never);
});

describe('resolveDocumentBranding', () => {
  it('loads the pinned logo instead of the live one', async () => {
    mockBrandLogo();

    vi.mocked(getTeamSettings).mockResolvedValue(LIVE_BRANDED_SETTINGS as never);

    const branding = await resolveDocumentBranding({
      teamId: 7,
      brandingSnapshot: buildPinnedSnapshot(),
    });

    expect(getFileServerSide).toHaveBeenCalledWith({ type: 'BYTES_64', data: 'AQID' });
    expect(branding.logo).toEqual({ content: Buffer.from([1, 2, 3]), contentType: 'image/png' });
  });

  it('keeps the pinned logo when the live branding was switched off', async () => {
    mockBrandLogo();

    const branding = await resolveDocumentBranding({
      teamId: 7,
      brandingSnapshot: buildPinnedSnapshot(),
    });

    expect(branding.logo).toEqual({ content: Buffer.from([1, 2, 3]), contentType: 'image/png' });
  });

  it('renders no brand mark when the pinned branding is disabled', async () => {
    const branding = await resolveDocumentBranding({
      teamId: 7,
      brandingSnapshot: buildPinnedSnapshot({ brandingEnabled: false, brandingLogo: '' }),
    });

    expect(branding.logo).toBeNull();
    expect(getFileServerSide).not.toHaveBeenCalled();
  });

  it('renders no brand mark when the pinned branding has no logo', async () => {
    const branding = await resolveDocumentBranding({
      teamId: 7,
      brandingSnapshot: buildPinnedSnapshot({ brandingLogo: '' }),
    });

    expect(branding.logo).toBeNull();
    expect(getFileServerSide).not.toHaveBeenCalled();
  });

  it('uses the live branding for envelopes created before the pin existed', async () => {
    mockBrandLogo();

    vi.mocked(getTeamSettings).mockResolvedValue({
      ...LIVE_BRANDED_SETTINGS,
      brandingLogo: JSON.stringify({ type: 'BYTES_64', data: 'LIVE' }),
    } as never);

    const branding = await resolveDocumentBranding({
      teamId: 7,
      brandingSnapshot: null,
    });

    expect(getFileServerSide).toHaveBeenCalledWith({ type: 'BYTES_64', data: 'LIVE' });
    expect(branding.logo).not.toBeNull();
  });

  it('falls back to the Documenso mark when the pinned logo cannot be read', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    vi.mocked(getFileServerSide).mockRejectedValue(new Error('storage unavailable'));

    const branding = await resolveDocumentBranding({
      teamId: 7,
      brandingSnapshot: buildPinnedSnapshot(),
    });

    expect(branding.logo).toBeNull();
    expect(consoleError).toHaveBeenCalled();
  });

  it('reports the organisation powered-by claim', async () => {
    mockBrandLogo();

    vi.mocked(getOrganisationClaimByTeamId).mockResolvedValue({ flags: { hidePoweredBy: true } } as never);

    const branding = await resolveDocumentBranding({
      teamId: 7,
      brandingSnapshot: buildPinnedSnapshot(),
    });

    expect(branding.hidePoweredBy).toBe(true);
  });
});

describe('shouldRenderBrandMark', () => {
  const logo = { content: Buffer.from([1]), contentType: 'image/png' };

  it('renders the pinned brand even when Documenso is hidden', () => {
    expect(shouldRenderBrandMark({ logo, hidePoweredBy: true })).toBe(true);
  });

  it('renders the Documenso mark when nothing is hidden', () => {
    expect(shouldRenderBrandMark({ logo: null, hidePoweredBy: false })).toBe(true);
  });

  it('renders no mark when the Documenso mark is hidden and there is no brand', () => {
    expect(shouldRenderBrandMark({ logo: null, hidePoweredBy: true })).toBe(false);
  });
});

describe('toBrandLogoDataUrl', () => {
  it('encodes the pinned bytes for rendering', () => {
    expect(toBrandLogoDataUrl({ content: Buffer.from([1, 2, 3]), contentType: 'image/png' })).toBe(
      'data:image/png;base64,AQID',
    );
  });
});
