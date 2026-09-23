import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getFileServerSide } from '../../universal/upload/get-file.server';
import { loadLogo } from '../../utils/images/logo';
import { getTeamSettings } from '../team/get-team-settings';
import {
  buildEnvelopeBrandingSnapshot,
  getEnvelopeBrandingSnapshotForTeam,
  hashBrandingLogo,
  parseEnvelopeBrandingSnapshot,
  resolveEnvelopeBranding,
  resolveSigningBranding,
} from './branding-snapshot';

vi.mock('../team/get-team-settings');
vi.mock('../../universal/upload/get-file.server');
vi.mock('../../utils/images/logo');

// A logo reference in the same shape the branding logo column stores.
const PINNED_LOGO = JSON.stringify({ type: 'BYTES_64', data: 'AQID' });

// sha256(PINNED_LOGO)
const LOGO_HASH = '25526a6eba91782f6196ccb93e43dc9a7f7e23ed0012063d840171ec394558aa';

const LIVE_BRANDING = {
  brandingEnabled: false,
  brandingLogo: '',
  brandingUrl: '',
  brandingCompanyDetails: '',
  brandingColors: null,
  brandingCss: '',
};

const PINNED_BRANDING = {
  brandingEnabled: true,
  brandingLogo: PINNED_LOGO,
  brandingUrl: 'https://brand.example',
  brandingCompanyDetails: 'CIDEIN',
  brandingColors: { primary: '#123456' },
  brandingCss: '.branded {}',
};

const buildPinnedSnapshot = (overrides: Partial<typeof PINNED_BRANDING> = {}) =>
  buildEnvelopeBrandingSnapshot({
    teamId: 7,
    settings: { ...PINNED_BRANDING, ...overrides },
  });

// The six pinned fields, in the order the builder hashes them.
const pinnedBrandingFields = (snapshot: ReturnType<typeof buildPinnedSnapshot>) => ({
  enabled: snapshot.enabled,
  logo: snapshot.logo,
  url: snapshot.url,
  companyDetails: snapshot.companyDetails,
  colors: snapshot.colors,
  css: snapshot.css,
});

beforeEach(() => {
  vi.resetAllMocks();
});

describe('buildEnvelopeBrandingSnapshot', () => {
  it('pins the six derived branding fields', () => {
    const snapshot = buildPinnedSnapshot();

    expect(snapshot.version).toBe(1);
    expect(snapshot.source).toBe('capture');
    expect(snapshot.brandId).toBe('team:7');
    expect(snapshot.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(snapshot.enabled).toBe(true);
    expect(snapshot.logo).toBe(PINNED_LOGO);
    expect(snapshot.url).toBe('https://brand.example');
    expect(snapshot.companyDetails).toBe('CIDEIN');
    expect(snapshot.colors).toEqual({ primary: '#123456' });
    expect(snapshot.css).toBe('.branded {}');
  });

  it('hashes the pinned logo and derives a short version key from it', () => {
    const snapshot = buildPinnedSnapshot();

    expect(snapshot.logoHash).toBe(LOGO_HASH);
    expect(snapshot.logoVersion).toBe(LOGO_HASH.slice(0, 16));
    expect(snapshot.brandVersion).toBe(hashBrandingLogo(JSON.stringify(pinnedBrandingFields(snapshot))));
  });

  it('leaves the logo fields empty when no logo is pinned', () => {
    const snapshot = buildPinnedSnapshot({ brandingLogo: '' });

    expect(snapshot.logo).toBe('');
    expect(snapshot.logoHash).toBeNull();
    expect(snapshot.logoVersion).toBeNull();
  });

  it('drops unknown color keys and records a backfilled snapshot', () => {
    const snapshot = buildEnvelopeBrandingSnapshot({
      teamId: 3,
      settings: {
        brandingEnabled: false,
        brandingLogo: '',
        brandingUrl: '',
        brandingCompanyDetails: '',
        brandingColors: { primary: '#fff', notAColorVar: 'javascript:alert(1)' },
        brandingCss: '',
      },
      source: 'backfill',
    });

    expect(snapshot.source).toBe('backfill');
    expect(snapshot.enabled).toBe(false);
    expect(snapshot.colors).toEqual({ primary: '#fff' });
    expect(snapshot.css).toBe('');
  });

  it('changes the brand version when any pinned field changes', () => {
    const first = buildPinnedSnapshot();
    const second = buildPinnedSnapshot({ brandingColors: { primary: '#000000' } });

    expect(first.brandVersion).not.toBe(second.brandVersion);
  });
});

describe('getEnvelopeBrandingSnapshotForTeam', () => {
  it('pins the team settings it reads', async () => {
    vi.mocked(getTeamSettings).mockResolvedValue({ ...LIVE_BRANDING, ...PINNED_BRANDING } as never);

    const snapshot = await getEnvelopeBrandingSnapshotForTeam({ teamId: 7 });

    expect(getTeamSettings).toHaveBeenCalledWith({ teamId: 7 });
    expect(snapshot).toMatchObject({ brandId: 'team:7', logo: PINNED_LOGO, enabled: true });
  });
});

describe('parseEnvelopeBrandingSnapshot', () => {
  it('returns null for envelopes without a snapshot', () => {
    expect(parseEnvelopeBrandingSnapshot(null)).toBeNull();
    expect(parseEnvelopeBrandingSnapshot(undefined)).toBeNull();
  });

  it('returns null for payloads this build cannot read', () => {
    expect(parseEnvelopeBrandingSnapshot({ ...buildPinnedSnapshot(), version: 2 })).toBeNull();
    expect(parseEnvelopeBrandingSnapshot('not-a-snapshot')).toBeNull();
    expect(parseEnvelopeBrandingSnapshot({ enabled: true })).toBeNull();
  });

  it('returns the snapshot when it is valid', () => {
    expect(parseEnvelopeBrandingSnapshot(buildPinnedSnapshot())).toMatchObject({
      brandId: 'team:7',
      logo: PINNED_LOGO,
      enabled: true,
    });
  });
});

describe('resolveEnvelopeBranding', () => {
  it('prefers the pinned branding over live settings that have changed', () => {
    const { branding, isPinned } = resolveEnvelopeBranding({
      brandingSnapshot: buildPinnedSnapshot(),
      liveBranding: {
        brandingEnabled: true,
        brandingLogo: 'changed-logo',
        brandingUrl: 'https://changed.example',
        brandingCompanyDetails: 'Changed',
        brandingColors: { primary: '#ffffff' },
        brandingCss: 'changed',
      },
    });

    expect(isPinned).toBe(true);
    expect(branding).toEqual({
      enabled: true,
      logo: PINNED_LOGO,
      url: 'https://brand.example',
      companyDetails: 'CIDEIN',
      colors: { primary: '#123456' },
      css: '.branded {}',
    });
  });

  it('does not mix live branding into a pinned envelope that disabled it', () => {
    const { branding } = resolveEnvelopeBranding({
      brandingSnapshot: buildPinnedSnapshot({ brandingEnabled: false, brandingLogo: '' }),
      liveBranding: {
        brandingEnabled: true,
        brandingLogo: 'live-logo',
        brandingUrl: 'https://live.example',
        brandingCompanyDetails: 'Live',
        brandingColors: { primary: '#ffffff' },
        brandingCss: 'live',
      },
    });

    expect(branding.enabled).toBe(false);
    expect(branding.logo).toBe('');
    expect(branding.colors).toBeNull();
    expect(branding.css).toBe('');
  });

  it('falls back to live settings for envelopes without a snapshot', () => {
    const { branding, isPinned } = resolveEnvelopeBranding({
      brandingSnapshot: null,
      liveBranding: {
        brandingEnabled: true,
        brandingLogo: 'live-logo',
        brandingUrl: 'https://live.example',
        brandingCompanyDetails: 'Live',
        brandingColors: { primary: '#ffffff', unknown: 'dropped' },
        brandingCss: 'live',
      },
    });

    expect(isPinned).toBe(false);
    expect(branding).toEqual({
      enabled: true,
      logo: 'live-logo',
      url: 'https://live.example',
      companyDetails: 'Live',
      colors: { primary: '#ffffff' },
      css: 'live',
    });
  });

  it('falls back to live settings for snapshots it cannot read', () => {
    const { isPinned, branding } = resolveEnvelopeBranding({
      brandingSnapshot: { version: 99 },
      liveBranding: { ...LIVE_BRANDING, brandingEnabled: true, brandingLogo: 'live-logo' },
    });

    expect(isPinned).toBe(false);
    expect(branding.logo).toBe('live-logo');
  });
});

describe('resolveSigningBranding', () => {
  const mockPinnedLogoBytes = () => {
    vi.mocked(getFileServerSide).mockResolvedValue(Buffer.from([1, 2, 3]) as never);
    vi.mocked(loadLogo).mockResolvedValue({ contentType: 'image/png', content: Buffer.from([1, 2, 3]) } as never);
  };

  // The web surfaces render the pinned bytes inline: the live endpoint resolves
  // the branding of the moment, so it may never be the reference a pinned
  // envelope is rendered from.
  it('inlines the pinned bytes while the live logo still matches them', async () => {
    mockPinnedLogoBytes();

    const result = await resolveSigningBranding({
      teamId: 7,
      brandingSnapshot: buildPinnedSnapshot(),
      liveBranding: { ...PINNED_BRANDING, brandingEnabled: true },
    });

    expect(getFileServerSide).toHaveBeenCalledWith({ type: 'BYTES_64', data: 'AQID' });
    expect(result).toEqual({
      brandingEnabled: true,
      brandingLogo: PINNED_LOGO,
      brandingLogoUrl: 'data:image/png;base64,AQID',
      brandingLogoAttachment: null,
    });
    expect(result.brandingLogoUrl).not.toContain('/api/branding/logo/team/');
  });

  it('inlines the pinned bytes once the live branding drifted', async () => {
    mockPinnedLogoBytes();

    const result = await resolveSigningBranding({
      teamId: 7,
      brandingSnapshot: buildPinnedSnapshot(),
      liveBranding: { ...PINNED_BRANDING, brandingEnabled: false },
    });

    expect(getFileServerSide).toHaveBeenCalledWith({ type: 'BYTES_64', data: 'AQID' });
    expect(result).toEqual({
      brandingEnabled: true,
      brandingLogo: PINNED_LOGO,
      brandingLogoUrl: 'data:image/png;base64,AQID',
      brandingLogoAttachment: null,
    });
  });

  it('hands the pinned bytes to the caller that carries them in the message', async () => {
    mockPinnedLogoBytes();

    const result = await resolveSigningBranding({
      teamId: 7,
      brandingSnapshot: buildPinnedSnapshot(),
      liveBranding: { ...PINNED_BRANDING, brandingEnabled: true },
      logoReference: 'content-id',
    });

    expect(result).toEqual({
      brandingEnabled: true,
      brandingLogo: PINNED_LOGO,
      brandingLogoUrl: 'cid:branding-logo-039058c6f2c0cb49',
      brandingLogoAttachment: {
        contentId: 'branding-logo-039058c6f2c0cb49',
        contentType: 'image/png',
        contentBase64: 'AQID',
        filename: 'branding-logo.png',
      },
    });
  });

  it('derives the content id from the bytes, so two logos never share one', async () => {
    vi.mocked(getFileServerSide).mockResolvedValue(Buffer.from([1, 2, 3]) as never);
    vi.mocked(loadLogo).mockResolvedValue({ contentType: 'image/png', content: Buffer.from([1, 2, 3]) } as never);

    const first = await resolveSigningBranding({
      teamId: 7,
      brandingSnapshot: buildPinnedSnapshot(),
      liveBranding: PINNED_BRANDING,
      logoReference: 'content-id',
    });

    vi.mocked(loadLogo).mockResolvedValue({ contentType: 'image/png', content: Buffer.from([9, 9]) } as never);

    const second = await resolveSigningBranding({
      teamId: 7,
      brandingSnapshot: buildPinnedSnapshot(),
      liveBranding: PINNED_BRANDING,
      logoReference: 'content-id',
    });

    expect(first.brandingLogoAttachment?.contentId).not.toBe(second.brandingLogoAttachment?.contentId);
  });

  it('renders no custom logo when the pinned bytes cannot be read', async () => {
    vi.mocked(getFileServerSide).mockRejectedValue(new Error('gone'));

    const result = await resolveSigningBranding({
      teamId: 7,
      brandingSnapshot: buildPinnedSnapshot(),
      liveBranding: PINNED_BRANDING,
    });

    expect(result).toEqual({
      brandingEnabled: true,
      brandingLogo: PINNED_LOGO,
      brandingLogoUrl: null,
      brandingLogoAttachment: null,
    });
  });

  it('renders no custom logo when the envelope has none pinned', async () => {
    const result = await resolveSigningBranding({
      teamId: 7,
      brandingSnapshot: buildPinnedSnapshot({ brandingEnabled: false, brandingLogo: '' }),
      liveBranding: { ...LIVE_BRANDING, brandingEnabled: true, brandingLogo: 'live-logo' },
    });

    expect(result).toEqual({
      brandingEnabled: false,
      brandingLogo: '',
      brandingLogoUrl: null,
      brandingLogoAttachment: null,
    });
    expect(getFileServerSide).not.toHaveBeenCalled();
  });

  it('serves the live endpoint for envelopes without a snapshot', async () => {
    const result = await resolveSigningBranding({
      teamId: 7,
      brandingSnapshot: null,
      liveBranding: { ...LIVE_BRANDING, brandingEnabled: true, brandingLogo: 'live-logo' },
    });

    expect(result).toEqual({
      brandingEnabled: true,
      brandingLogo: 'live-logo',
      brandingLogoUrl: '/api/branding/logo/team/7',
      brandingLogoAttachment: null,
    });
    expect(getFileServerSide).not.toHaveBeenCalled();
  });
});
