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
  mailer: {
    sendMail: vi.fn(),
  },
}));

vi.mock('@documenso/prisma', () => ({ prisma: mocks.prisma }));
vi.mock('@documenso/email/mailer', () => ({ mailer: mocks.mailer }));
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

const getContext = async (brandingSnapshot: unknown) =>
  getEmailContext({
    emailType: 'INTERNAL',
    source: {
      type: 'team',
      teamId: TEAM_ID,
      brandingSnapshot,
    },
  });

const getBranding = async (brandingSnapshot: unknown) => (await getContext(brandingSnapshot)).branding;

const mockPinnedLogoBytes = () => {
  vi.mocked(getFileServerSide).mockResolvedValue(Buffer.from([1, 2, 3]) as never);
  vi.mocked(loadLogo).mockResolvedValue({ contentType: 'image/png', content: Buffer.from([1, 2, 3]) } as never);
};

// The content id the pinned bytes of these tests resolve to.
const PINNED_LOGO_CONTENT_ID = 'branding-logo-039058c6f2c0cb49';
const PINNED_LOGO_CID = `cid:${PINNED_LOGO_CONTENT_ID}`;

beforeEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  mockTeam();
});

describe('getEmailContext pinned envelope branding', () => {
  it('renders the branding the envelope is pinned to while the live branding still matches it', async () => {
    mockPinnedLogoBytes();
    mockTeam({
      organisationSettings: { ...ORGANISATION_SETTINGS, brandingLogo: PINNED_LOGO },
    });

    const branding = await getBranding(buildPinnedSnapshot());

    expect(branding.brandingEnabled).toBe(true);
    expect(branding.brandingLogo).toBe(PINNED_LOGO_CID);
    expect(branding.brandingUrl).toBe('https://pinned.example');
    expect(branding.brandingCompanyDetails).toBe('CIDEIN');
    expect(branding.brandingColors?.primary).toBe('#123456');
  });

  it('carries the pinned logo bytes in the message the sender sends', async () => {
    mockPinnedLogoBytes();

    const context = await getContext(buildPinnedSnapshot());

    expect(context.brandingLogoAttachment).toEqual({
      contentId: PINNED_LOGO_CONTENT_ID,
      contentType: 'image/png',
      contentBase64: 'AQID',
      filename: 'branding-logo.png',
    });

    await context.emailTransport.sendMail({
      to: 'signer@test.documenso.com',
      from: 'sender@test.documenso.com',
      subject: 'Sign this',
      html: `<img src="${context.branding.brandingLogo}" />`,
    });

    expect(mocks.mailer.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: 'Sign this',
        attachments: [
          {
            filename: 'branding-logo.png',
            content: 'AQID',
            encoding: 'base64',
            contentType: 'image/png',
            cid: PINNED_LOGO_CONTENT_ID,
          },
        ],
      }),
    );
  });

  it('merges the pinned logo with the attachments the sender already has', async () => {
    mockPinnedLogoBytes();

    const context = await getContext(buildPinnedSnapshot());
    const document = { filename: 'document.pdf', content: Buffer.from([4, 5]), contentType: 'application/pdf' };

    await context.emailTransport.sendMail({
      to: 'signer@test.documenso.com',
      from: 'sender@test.documenso.com',
      subject: 'Signed',
      html: `<img src="${context.branding.brandingLogo}" />`,
      attachments: [document],
    });

    expect(mocks.mailer.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments: [document, expect.objectContaining({ cid: PINNED_LOGO_CONTENT_ID })],
      }),
    );
  });

  it('does not attach the pinned logo to a message that does not render it', async () => {
    mockPinnedLogoBytes();

    const context = await getContext(buildPinnedSnapshot());

    await context.emailTransport.sendMail({
      to: 'signer@test.documenso.com',
      from: 'sender@test.documenso.com',
      subject: 'No branding here',
      html: '<p>Notification</p>',
    });

    expect(mocks.mailer.sendMail).toHaveBeenCalledWith({
      to: 'signer@test.documenso.com',
      from: 'sender@test.documenso.com',
      subject: 'No branding here',
      html: '<p>Notification</p>',
    });
  });

  it('keeps the pinned logo after the branding changed while the envelope is in flight', async () => {
    mockPinnedLogoBytes();

    const branding = await getBranding(buildPinnedSnapshot());

    expect(branding.brandingEnabled).toBe(true);
    expect(branding.brandingLogo).toBe(PINNED_LOGO_CID);
    expect(branding.brandingLogo).not.toContain('/api/branding/logo/team/');
    expect(branding.brandingUrl).toBe('https://pinned.example');
    expect(branding.brandingCompanyDetails).toBe('CIDEIN');
    expect(branding.brandingColors?.primary).toBe('#123456');
  });

  it('keeps the pinned bytes as the reference for the logo, not the live endpoint', async () => {
    mockPinnedLogoBytes();

    const branding = await getBranding(buildPinnedSnapshot());

    // The `cid:` reference only resolves if the message carries the part, so a
    // pinned email can never point at the branding of the moment.
    expect(branding.brandingLogo).toBe(PINNED_LOGO_CID);
    expect(branding.brandingLogo).not.toContain('http');
  });

  it('keeps the pinned logo after the branding was disabled while the envelope is in flight', async () => {
    mockPinnedLogoBytes();

    mockTeam({
      organisationSettings: { ...ORGANISATION_SETTINGS, brandingEnabled: false, brandingLogo: '' },
    });

    const branding = await getBranding(buildPinnedSnapshot());

    expect(branding.brandingEnabled).toBe(true);
    expect(branding.brandingLogo).toBe(PINNED_LOGO_CID);
  });

  it('renders no logo when the pinned bytes can no longer be read', async () => {
    vi.mocked(getFileServerSide).mockRejectedValue(new Error('gone'));

    const branding = await getBranding(buildPinnedSnapshot());

    expect(branding.brandingEnabled).toBe(true);
    expect(branding.brandingLogo).toBe('');
    expect(branding.brandingLogo).not.toContain('/api/branding/logo/team/');
  });

  it('does not render branding the envelope pinned as disabled', async () => {
    const branding = await getBranding(buildPinnedSnapshot({ brandingEnabled: false, brandingLogo: '' }));

    expect(branding.brandingEnabled).toBe(false);
    expect(branding.brandingLogo).toBe('');
    expect(getFileServerSide).not.toHaveBeenCalled();
  });

  it('falls back to the live branding for envelopes without a snapshot', async () => {
    const context = await getContext(null);

    expect(context.branding.brandingEnabled).toBe(true);
    expect(context.branding.brandingLogo).toBe(`${NEXT_PUBLIC_WEBAPP_URL()}/api/branding/logo/team/${TEAM_ID}`);
    expect(context.branding.brandingUrl).toBe('https://live.example');
    expect(context.branding.brandingCompanyDetails).toBe('Live Co');
    expect(context.branding.brandingColors?.primary).toBe('#654321');
    expect(context.brandingLogoAttachment).toBeNull();
    expect(getFileServerSide).not.toHaveBeenCalled();

    // Live branding is the branding of the moment, so it keeps following the
    // live endpoint and the transport stays the caller's own.
    await context.emailTransport.sendMail({
      to: 'signer@test.documenso.com',
      from: 'sender@test.documenso.com',
      subject: 'Live branding',
      html: `<img src="${context.branding.brandingLogo}" />`,
    });

    expect(mocks.mailer.sendMail).toHaveBeenCalledWith({
      to: 'signer@test.documenso.com',
      from: 'sender@test.documenso.com',
      subject: 'Live branding',
      html: `<img src="${NEXT_PUBLIC_WEBAPP_URL()}/api/branding/logo/team/${TEAM_ID}" />`,
    });
  });

  it('falls back to the live branding for snapshots this build cannot read', async () => {
    const branding = await getBranding({ version: 99 });

    expect(branding.brandingLogo).toBe(`${NEXT_PUBLIC_WEBAPP_URL()}/api/branding/logo/team/${TEAM_ID}`);
    expect(branding.brandingUrl).toBe('https://live.example');
  });

  it('drops the pinned colours when the organisation is not entitled to them', async () => {
    vi.stubEnv('NEXT_PUBLIC_FEATURE_BILLING_ENABLED', 'true');
    mockPinnedLogoBytes();

    mockTeam({ flags: { embedSigningWhiteLabel: false } });

    const branding = await getBranding(buildPinnedSnapshot());

    expect(branding.brandingColors).toBeUndefined();
    expect(branding.brandingLogo).toBe(PINNED_LOGO_CID);
  });
});
