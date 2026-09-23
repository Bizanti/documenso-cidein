import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NEXT_PUBLIC_WEBAPP_URL } from '../../../constants/app';
import { buildEnvelopeBrandingSnapshot } from '../../envelope/branding-snapshot';
import { send2FATokenEmail } from './send-2fa-token-email';

const mocks = vi.hoisted(() => ({
  prisma: {
    envelope: { findFirst: vi.fn() },
    team: { findFirst: vi.fn() },
    documentAuditLog: { create: vi.fn() },
  },
  mailer: {
    sendMail: vi.fn(),
  },
  getI18nInstance: vi.fn(),
  renderEmailWithI18N: vi.fn(),
  generateTwoFactorTokenFromEmail: vi.fn(),
  getFileServerSide: vi.fn(),
  loadLogo: vi.fn(),
}));

vi.mock('@documenso/prisma', () => ({ prisma: mocks.prisma }));
vi.mock('@documenso/email/mailer', () => ({ mailer: mocks.mailer }));
vi.mock('../../../client-only/providers/i18n-server', () => ({ getI18nInstance: mocks.getI18nInstance }));
vi.mock('../../../utils/render-email-with-i18n', () => ({ renderEmailWithI18N: mocks.renderEmailWithI18N }));
vi.mock('../../../universal/upload/get-file.server', () => ({ getFileServerSide: mocks.getFileServerSide }));
vi.mock('../../../utils/images/logo', () => ({ loadLogo: mocks.loadLogo }));
vi.mock('./generate-2fa-token-from-email', () => ({
  generateTwoFactorTokenFromEmail: mocks.generateTwoFactorTokenFromEmail,
}));

const TEAM_ID = 7;

// Must match the envelope id format the 2FA email resolves its query with.
const ENVELOPE_ID = 'envelope_1a2b3c';

// Logo references in the same shape the branding logo column stores.
const PINNED_LOGO = JSON.stringify({ type: 'BYTES_64', data: 'AQID' });
const LIVE_LOGO = JSON.stringify({ type: 'BYTES_64', data: 'BAUG' });

// The live settings as they look after the branding was edited while the
// envelope was in flight.
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

const mockTeam = () => {
  mocks.prisma.team.findFirst.mockResolvedValue({
    id: TEAM_ID,
    teamGlobalSettings: TEAM_SETTINGS,
    organisation: {
      id: 'org_1',
      type: 'PERSONAL',
      owner: { id: 1, disabled: false },
      organisationGlobalSettings: ORGANISATION_SETTINGS,
      emailDomains: [],
      organisationClaim: {
        emailTransportId: null,
        flags: {
          hidePoweredBy: false,
          disableEmails: false,
          emailDomains: false,
          embedSigningWhiteLabel: true,
        },
      },
    },
  } as never);
};

const mockEnvelope = (brandingSnapshot: unknown) => {
  mocks.prisma.envelope.findFirst.mockResolvedValue({
    id: ENVELOPE_ID,
    title: '[TEST] Pending document',
    teamId: TEAM_ID,
    brandingSnapshot,
    documentMeta: null,
    recipients: [{ id: 1, email: 'signer@test.documenso.com', name: 'Signer', token: 'recipient-token' }],
  } as never);
};

const buildPinnedSnapshot = () =>
  buildEnvelopeBrandingSnapshot({
    teamId: TEAM_ID,
    settings: {
      brandingEnabled: true,
      brandingLogo: PINNED_LOGO,
      brandingUrl: 'https://pinned.example',
      brandingCompanyDetails: 'CIDEIN',
      brandingColors: { primary: '#123456' },
      brandingCss: '',
    },
  });

// The branding the 2FA email handed to the email renderer.
const renderedBranding = () => mocks.renderEmailWithI18N.mock.calls[0][1].branding;

beforeEach(() => {
  vi.resetAllMocks();
  mockTeam();
  mockEnvelope(null);

  mocks.getI18nInstance.mockResolvedValue({
    _: (descriptor: { message?: string; id: string }) => descriptor.message ?? descriptor.id,
  });
  mocks.renderEmailWithI18N.mockResolvedValue('<html />');
  mocks.generateTwoFactorTokenFromEmail.mockResolvedValue('123456');
  mocks.getFileServerSide.mockResolvedValue(Buffer.from([1, 2, 3]));
  mocks.loadLogo.mockResolvedValue({ contentType: 'image/png', content: Buffer.from([1, 2, 3]) });
});

describe('2FA email branding', () => {
  it('renders the pinned logo after the branding changed while the envelope was in flight', async () => {
    mockEnvelope(buildPinnedSnapshot());

    await send2FATokenEmail({ token: 'recipient-token', envelopeId: ENVELOPE_ID });

    const branding = renderedBranding();

    expect(branding.brandingEnabled).toBe(true);
    expect(branding.brandingLogo).toBe('data:image/png;base64,AQID');
    expect(branding.brandingLogo).not.toContain('/api/branding/logo/team/');
    expect(branding.brandingUrl).toBe('https://pinned.example');
    expect(branding.brandingCompanyDetails).toBe('CIDEIN');
    expect(branding.brandingColors?.primary).toBe('#123456');
    expect(mocks.mailer.sendMail).toHaveBeenCalledTimes(1);
  });

  it('renders the live logo for an envelope without a snapshot', async () => {
    await send2FATokenEmail({ token: 'recipient-token', envelopeId: ENVELOPE_ID });

    const branding = renderedBranding();

    expect(branding.brandingLogo).toBe(`${NEXT_PUBLIC_WEBAPP_URL()}/api/branding/logo/team/${TEAM_ID}`);
    expect(branding.brandingUrl).toBe('https://live.example');
    expect(mocks.mailer.sendMail).toHaveBeenCalledTimes(1);
  });
});
