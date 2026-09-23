import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NEXT_PUBLIC_WEBAPP_URL } from '../../constants/app';
import { getFileServerSide } from '../../universal/upload/get-file.server';
import { loadLogo } from '../../utils/images/logo';
import { buildEnvelopeBrandingSnapshot } from '../envelope/branding-snapshot';
import { getEmailContext } from './get-email-context';

const mocks = vi.hoisted(() => ({
  prisma: {
    team: {
      findFirst: vi.fn(),
    },
  },
}));

vi.mock('@documenso/prisma', () => ({ prisma: mocks.prisma }));
vi.mock('../../universal/upload/get-file.server');
vi.mock('../../utils/images/logo');

const TEAM_ID = 7;

// Logo references in the same shape the branding logo column stores.
const PINNED_LOGO = JSON.stringify({ type: 'BYTES_64', data: 'AQID' });
const LIVE_LOGO = JSON.stringify({ type: 'BYTES_64', data: 'BAUG' });

const ORGANISATION_SETTINGS = {
  documentLanguage: 'en',
  emailId: null,
  emailReplyTo: null,
  brandingEnabled: true,
  brandingLogo: LIVE_LOGO,
  brandingUrl: 'https://live.example',
  brandingCompanyDetails: 'Live Co',
  brandingColors: { primary: '#654321' },
  brandingCss: '',
};

// A team that inherits every organisation setting (null means inherit).
const TEAM_SETTINGS = Object.fromEntries(Object.keys(ORGANISATION_SETTINGS).map((key) => [key, null]));

const buildPinnedSnapshot = (
  settings: Partial<{
    brandingEnabled: boolean;
    brandingLogo: string;
  }> = {},
) =>
  buildEnvelopeBrandingSnapshot({
    teamId: TEAM_ID,
    settings: {
      brandingEnabled: true,
      brandingLogo: PINNED_LOGO,
      brandingUrl: 'https://pinned.example',
      brandingCompanyDetails: 'CIDEIN',
      brandingColors: { primary: '#123456' },
      brandingCss: '',
      ...settings,
    },
  });

const mockTeam = ({
  organisationSettings = ORGANISATION_SETTINGS,
  flags = {},
}: {
  organisationSettings?: typeof ORGANISATION_SETTINGS;
  flags?: Record<string, boolean>;
} = {}) => {
  mocks.prisma.team.findFirst.mockResolvedValue({
    id: TEAM_ID,
    teamGlobalSettings: TEAM_SETTINGS,
    organisation: {
      id: 'org_1',
      type: 'PERSONAL',
      owner: { id: 1, disabled: false },
      organisationGlobalSettings: organisationSettings,
      emailDomains: [],
      organisationClaim: {
        emailTransportId: null,
        flags: {
          hidePoweredBy: false,
          disableEmails: false,
          emailDomains: false,
          embedSigningWhiteLabel: true,
          ...flags,
        },
      },
    },
  } as never);
};

const getBranding = async (brandingSnapshot: unknown) => {
  const context = await getEmailContext({
    emailType: 'INTERNAL',
    source: {
      type: 'team',
      teamId: TEAM_ID,
      brandingSnapshot,
    },
  });

  return context.branding;
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  mockTeam();
});

describe('getEmailContext pinned envelope branding', () => {
  it('renders the branding the envelope is pinned to while the live branding still matches it', async () => {
    mockTeam({
      organisationSettings: { ...ORGANISATION_SETTINGS, brandingLogo: PINNED_LOGO },
    });

    const branding = await getBranding(buildPinnedSnapshot());

    expect(branding.brandingEnabled).toBe(true);
    expect(branding.brandingLogo).toBe(`${NEXT_PUBLIC_WEBAPP_URL()}/api/branding/logo/team/${TEAM_ID}`);
    expect(branding.brandingUrl).toBe('https://pinned.example');
    expect(branding.brandingCompanyDetails).toBe('CIDEIN');
    expect(branding.brandingColors?.primary).toBe('#123456');
    expect(getFileServerSide).not.toHaveBeenCalled();
  });

  it('keeps the pinned logo after the branding changed while the envelope is in flight', async () => {
    vi.mocked(getFileServerSide).mockResolvedValue(Buffer.from([1, 2, 3]) as never);
    vi.mocked(loadLogo).mockResolvedValue({ contentType: 'image/png', content: Buffer.from([1, 2, 3]) } as never);

    const branding = await getBranding(buildPinnedSnapshot());

    expect(branding.brandingEnabled).toBe(true);
    expect(branding.brandingLogo).toBe('data:image/png;base64,AQID');
    expect(branding.brandingLogo).not.toContain('/api/branding/logo/team/');
    expect(branding.brandingUrl).toBe('https://pinned.example');
    expect(branding.brandingCompanyDetails).toBe('CIDEIN');
    expect(branding.brandingColors?.primary).toBe('#123456');
  });

  it('keeps the pinned logo after the branding was disabled while the envelope is in flight', async () => {
    vi.mocked(getFileServerSide).mockResolvedValue(Buffer.from([1, 2, 3]) as never);
    vi.mocked(loadLogo).mockResolvedValue({ contentType: 'image/png', content: Buffer.from([1, 2, 3]) } as never);

    mockTeam({
      organisationSettings: { ...ORGANISATION_SETTINGS, brandingEnabled: false, brandingLogo: '' },
    });

    const branding = await getBranding(buildPinnedSnapshot());

    expect(branding.brandingEnabled).toBe(true);
    expect(branding.brandingLogo).toBe('data:image/png;base64,AQID');
  });

  it('does not render branding the envelope pinned as disabled', async () => {
    const branding = await getBranding(buildPinnedSnapshot({ brandingEnabled: false, brandingLogo: '' }));

    expect(branding.brandingEnabled).toBe(false);
    expect(branding.brandingLogo).toBe('');
    expect(getFileServerSide).not.toHaveBeenCalled();
  });

  it('falls back to the live branding for envelopes without a snapshot', async () => {
    const branding = await getBranding(null);

    expect(branding.brandingEnabled).toBe(true);
    expect(branding.brandingLogo).toBe(`${NEXT_PUBLIC_WEBAPP_URL()}/api/branding/logo/team/${TEAM_ID}`);
    expect(branding.brandingUrl).toBe('https://live.example');
    expect(branding.brandingCompanyDetails).toBe('Live Co');
    expect(branding.brandingColors?.primary).toBe('#654321');
    expect(getFileServerSide).not.toHaveBeenCalled();
  });

  it('falls back to the live branding for snapshots this build cannot read', async () => {
    const branding = await getBranding({ version: 99 });

    expect(branding.brandingLogo).toBe(`${NEXT_PUBLIC_WEBAPP_URL()}/api/branding/logo/team/${TEAM_ID}`);
    expect(branding.brandingUrl).toBe('https://live.example');
  });

  it('drops the pinned colours when the organisation is not entitled to them', async () => {
    vi.stubEnv('NEXT_PUBLIC_FEATURE_BILLING_ENABLED', 'true');
    vi.mocked(getFileServerSide).mockResolvedValue(Buffer.from([1, 2, 3]) as never);
    vi.mocked(loadLogo).mockResolvedValue({ contentType: 'image/png', content: Buffer.from([1, 2, 3]) } as never);

    mockTeam({ flags: { embedSigningWhiteLabel: false } });

    const branding = await getBranding(buildPinnedSnapshot());

    expect(branding.brandingColors).toBeUndefined();
    expect(branding.brandingLogo).toBe('data:image/png;base64,AQID');
  });
});
