import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getTeamSettings } from '../team/get-team-settings';
import { buildEnvelopeBrandingSnapshot } from './branding-snapshot';

const findFirst = vi.fn();

vi.mock('@documenso/prisma', () => ({
  prisma: {
    team: {
      findFirst: (...args: unknown[]) => findFirst(...args),
    },
  },
}));

const ORGANISATION_BRANDING = {
  brandingEnabled: true,
  brandingLogo: 'organisation-logo',
  brandingUrl: 'https://organisation.example',
  brandingCompanyDetails: 'Organisation',
  brandingColors: { primary: '#000000' },
  brandingCss: 'organisation {}',
};

/**
 * `buildEnvelopeBrandingSnapshot` and the backfill migration
 * (20260923120100_backfill_envelope_branding_snapshot) must mirror the branding
 * resolution of `getTeamSettings`, so these tests pin the rule they depend on.
 */
describe('branding inheritance through getTeamSettings', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  const mockTeamSettings = (teamBranding: Record<string, unknown>) => {
    findFirst.mockResolvedValue({
      id: 1,
      organisation: {
        organisationGlobalSettings: { id: 'org_settings', ...ORGANISATION_BRANDING },
      },
      teamGlobalSettings: { id: 'team_settings', ...teamBranding },
    });
  };

  it('ignores team fields left over while the team inherits its branding', async () => {
    // Reachable through `update-team-branding-logo`, which writes `brandingLogo`
    // without touching `brandingEnabled`.
    mockTeamSettings({
      brandingEnabled: null,
      brandingLogo: 'team-orphan-logo',
      brandingUrl: 'https://team-orphan.example',
      brandingCompanyDetails: 'Team orphan',
      brandingColors: { primary: '#ffffff' },
      brandingCss: 'team-orphan {}',
    });

    const settings = await getTeamSettings({ teamId: 1 });
    const snapshot = buildEnvelopeBrandingSnapshot({ teamId: 1, settings });

    expect(snapshot.enabled).toBe(true);
    expect(snapshot.logo).toBe('organisation-logo');
    expect(snapshot.url).toBe('https://organisation.example');
    expect(snapshot.companyDetails).toBe('Organisation');
    expect(snapshot.colors).toEqual({ primary: '#000000' });
    expect(snapshot.css).toBe('organisation {}');
  });

  it('lets the team win per field once it stops inheriting', async () => {
    // A real row always carries every column; null means "inherit".
    mockTeamSettings({
      brandingEnabled: true,
      brandingLogo: 'team-logo',
      brandingUrl: null,
      brandingCompanyDetails: null,
      brandingColors: null,
      brandingCss: null,
    });

    const settings = await getTeamSettings({ teamId: 1 });
    const snapshot = buildEnvelopeBrandingSnapshot({ teamId: 1, settings });

    expect(snapshot.enabled).toBe(true);
    expect(snapshot.logo).toBe('team-logo');
    // Fields the team leaves null keep the organisation value.
    expect(snapshot.url).toBe('https://organisation.example');
    expect(snapshot.companyDetails).toBe('Organisation');
    expect(snapshot.colors).toEqual({ primary: '#000000' });
    expect(snapshot.css).toBe('organisation {}');
  });
});
