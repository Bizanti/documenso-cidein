import { mailer } from '@documenso/email/mailer';
import type { BrandingSettings } from '@documenso/email/providers/branding';
import { prisma } from '@documenso/prisma';
import type {
  DocumentMeta,
  EmailDomain,
  Organisation,
  OrganisationEmail,
  OrganisationType,
} from '@documenso/prisma/client';
import { EmailDomainStatus, type OrganisationClaim, type OrganisationGlobalSettings } from '@documenso/prisma/client';
import type { Transporter } from 'nodemailer';
import { match, P } from 'ts-pattern';

import { IS_BILLING_ENABLED } from '../../constants/app';
import { DOCUMENSO_INTERNAL_EMAIL } from '../../constants/email';
import { AppError, AppErrorCode } from '../../errors/app-error';
import { logger } from '../../utils/logger';
import {
  organisationGlobalSettingsToBranding,
  type PinnedEmailBranding,
  teamGlobalSettingsToBranding,
  teamGlobalSettingsToPinnedEmailBranding,
} from '../../utils/team-global-settings-to-branding';
import { extractDerivedTeamSettings } from '../../utils/teams';
import {
  resolveEnvelopeBranding,
  resolveSigningBranding,
  type TBrandingLogoAttachment,
  type TDerivedBrandingSettings,
} from '../envelope/branding-snapshot';
import { withBrandingLogoAttachment } from './branding-logo-attachment';
import { resolveEmailTransport } from './resolve-email-transport';

type EmailMetaOption = Partial<Pick<DocumentMeta, 'emailId' | 'emailReplyTo' | 'language'>>;

type BaseGetEmailContextOptions = {
  /**
   * The source to extract the email context from.
   * - "Team" will use the team settings followed by the inherited organisation settings
   * - "Organisation" will use the organisation settings
   */
  source:
    | {
        type: 'team';
        teamId: number;

        /**
         * The `brandingSnapshot` of the envelope this email belongs to.
         *
         * When provided, the email renders the branding the envelope is pinned
         * to instead of the settings live at send time. Envelopes created
         * before the pin existed (and non-envelope emails) have no snapshot,
         * and keep resolving branding live.
         */
        brandingSnapshot?: unknown;
      }
    | {
        type: 'organisation';
        organisationId: string;
      };

  /**
   * The email type being sent, used to determine what email sender and language to use.
   * - INTERNAL: Emails to users, such as team invites, etc.
   * - RECIPIENT: Emails to recipients, such as document sent, document signed, etc.
   */
  emailType: 'INTERNAL' | 'RECIPIENT';
};

type InternalGetEmailContextOptions = BaseGetEmailContextOptions & {
  emailType: 'INTERNAL';
  meta?: EmailMetaOption | null;
};

type RecipientGetEmailContextOptions = BaseGetEmailContextOptions & {
  emailType: 'RECIPIENT';

  /**
   * Force meta options as a typesafe way to ensure developers don't forget to
   * pass it in if it is available.
   */
  meta: EmailMetaOption | null | undefined;
};

type GetEmailContextOptions = InternalGetEmailContextOptions | RecipientGetEmailContextOptions;

export type EmailContextResponse = {
  allowedEmails: OrganisationEmail[];
  branding: BrandingSettings;
  settings: Omit<OrganisationGlobalSettings, 'id'>;
  claims: OrganisationClaim;
  /**
   * The bytes of the pinned branding logo `branding` references as `cid:`, or
   * null when the branding is live (or has no logo).
   *
   * `emailTransport` already carries them, so only a sender that bypasses the
   * context transport — the Documenso-internal mailer, used for owner
   * notifications — has to attach this itself.
   */
  brandingLogoAttachment: TBrandingLogoAttachment | null;
  /**
   * Whether the organisation is prevented from sending emails.
   *
   * When true, ALL emails sent on behalf of this organisation must be skipped.
   */
  emailsDisabled: boolean;
  organisationId: string;
  organisationType: OrganisationType;
  emailTransport: Transporter;
  senderEmail: {
    name: string;
    address: string;
  };
  replyToEmail: string | undefined;
  emailLanguage: string;
};

export const getEmailContext = async (options: GetEmailContextOptions): Promise<EmailContextResponse> => {
  const { source, meta } = options;

  let emailContext: Omit<EmailContextResponse, 'senderEmail' | 'replyToEmail' | 'emailLanguage' | 'emailTransport'>;

  if (source.type === 'organisation') {
    emailContext = await handleOrganisationEmailContext(source.organisationId);
  } else {
    emailContext = await handleTeamEmailContext(source.teamId, source.brandingSnapshot);
  }

  const emailLanguage = meta?.language || emailContext.settings.documentLanguage;

  const transportResolution = emailContext.claims.emailTransportId
    ? await resolveEmailTransport(emailContext.claims.emailTransportId)
    : null;

  // A configured transport that fails to resolve is an operational problem, not
  // "no transport". Surface it (alertable) before silently falling back to the
  // system mailer + Documenso sender, so the degraded organisation is findable.
  if (emailContext.claims.emailTransportId && !transportResolution) {
    logger.error({
      msg: 'Configured email transport could not be resolved; falling back to the system mailer',
      emailTransportId: emailContext.claims.emailTransportId,
      organisationId: emailContext.organisationId,
    });
  }

  const resolvedTransportData = transportResolution
    ? {
        name: transportResolution.row.fromName,
        address: transportResolution.row.fromAddress,
        transport: transportResolution.transporter,
      }
    : {
        name: DOCUMENSO_INTERNAL_EMAIL.name,
        address: DOCUMENSO_INTERNAL_EMAIL.address,
        transport: mailer,
      };

  // The pinned logo of an envelope is carried by the very transport the caller
  // sends through, so whichever transport this context resolves to is the one
  // that has to be able to carry it (see `carryBrandingLogoAttachment`).
  const brandingLogoAttachment = emailContext.brandingLogoAttachment;

  // Immediate return for internal emails.
  if (options.emailType === 'INTERNAL') {
    return {
      ...emailContext,
      emailTransport: carryBrandingLogoAttachment(resolvedTransportData.transport, brandingLogoAttachment),
      senderEmail: {
        name: resolvedTransportData.name,
        address: resolvedTransportData.address,
      },
      replyToEmail: undefined,
      emailLanguage,
    };
  }

  const replyToEmail = meta?.emailReplyTo || emailContext.settings.emailReplyTo || undefined;

  const senderEmailId = match(meta?.emailId)
    .with(P.string, (emailId) => emailId) // Explicit string means to use the provided email ID.
    .with(undefined, () => emailContext.settings.emailId) // Undefined means to use the inherited email ID.
    .with(null, () => null) // Explicit null means to use the Documenso email.
    .exhaustive();

  const foundSenderEmail = emailContext.allowedEmails.find((email) => email.id === senderEmailId);

  // Reset the emailId to null if not found.
  if (!foundSenderEmail) {
    emailContext.settings.emailId = null;
  }

  // Custom-domain sender (emailDomains): always use the env mailer (SES) and the
  // custom sender; the per-plan transport is ignored entirely here.
  if (foundSenderEmail) {
    return {
      ...emailContext,
      emailTransport: carryBrandingLogoAttachment(mailer, brandingLogoAttachment),
      senderEmail: {
        name: foundSenderEmail.emailName,
        address: foundSenderEmail.email,
      },
      replyToEmail,
      emailLanguage,
    };
  }

  // No custom-domain sender → per-plan transport (if any) supplies transport + from-address.
  return {
    ...emailContext,
    emailTransport: carryBrandingLogoAttachment(resolvedTransportData.transport, brandingLogoAttachment),
    senderEmail: {
      name: resolvedTransportData.name,
      address: resolvedTransportData.address,
    },
    replyToEmail,
    emailLanguage,
  };
};

const handleOrganisationEmailContext = async (organisationId: string) => {
  const organisation = await prisma.organisation.findFirst({
    where: {
      id: organisationId,
    },
    include: {
      owner: {
        select: {
          disabled: true,
        },
      },
      organisationClaim: true,
      organisationGlobalSettings: true,
      emailDomains: {
        omit: {
          privateKey: true,
        },
        include: {
          emails: true,
        },
      },
    },
  });

  if (!organisation) {
    throw new AppError(AppErrorCode.NOT_FOUND);
  }

  const claims = organisation.organisationClaim;

  const allowedEmails = getAllowedEmails(organisation);

  const branding = organisationGlobalSettingsToBranding(
    organisation.organisationGlobalSettings,
    organisation.id,
    claims.flags.hidePoweredBy ?? false,
  );

  const allowBrandedEmailColors = !IS_BILLING_ENABLED() || claims.flags.embedSigningWhiteLabel === true;

  if (!allowBrandedEmailColors) {
    branding.brandingColors = undefined;
  }

  return {
    allowedEmails,
    branding,
    brandingLogoAttachment: null,
    settings: organisation.organisationGlobalSettings,
    claims,
    emailsDisabled: organisation.owner.disabled || claims.flags.disableEmails === true,
    organisationId: organisation.id,
    organisationType: organisation.type,
  };
};

const handleTeamEmailContext = async (teamId: number, brandingSnapshot?: unknown) => {
  const team = await prisma.team.findFirst({
    where: {
      id: teamId,
    },
    include: {
      teamGlobalSettings: true,
      organisation: {
        include: {
          owner: {
            select: {
              id: true,
              disabled: true,
            },
          },
          organisationClaim: true,
          organisationGlobalSettings: true,
          emailDomains: {
            omit: {
              privateKey: true,
            },
            include: {
              emails: true,
            },
          },
        },
      },
    },
  });

  if (!team) {
    throw new AppError(AppErrorCode.NOT_FOUND);
  }

  const organisation = team.organisation;
  const claims = organisation.organisationClaim;

  const allowedEmails = getAllowedEmails(organisation);

  const teamSettings = extractDerivedTeamSettings(organisation.organisationGlobalSettings, team.teamGlobalSettings);

  const emailBranding = await resolveTeamEmailBranding({
    teamId,
    settings: teamSettings,
    hidePoweredBy: claims.flags.hidePoweredBy ?? false,
    brandingSnapshot,
  });

  const allowBrandedEmailColors = !IS_BILLING_ENABLED() || claims.flags.embedSigningWhiteLabel === true;

  if (!allowBrandedEmailColors) {
    emailBranding.branding.brandingColors = undefined;
  }

  return {
    allowedEmails,
    ...emailBranding,
    settings: teamSettings,
    claims,
    emailsDisabled: organisation.owner.disabled || claims.flags.disableEmails === true,
    organisationId: organisation.id,
    organisationType: organisation.type,
  };
};

/**
 * Build the branding a team-sourced email renders — the branding the envelope is
 * pinned to when it has a snapshot, the live team settings otherwise — together
 * with the bytes of the pinned logo, which the message has to carry itself.
 */
const resolveTeamEmailBranding = async ({
  teamId,
  settings,
  hidePoweredBy,
  brandingSnapshot,
}: {
  teamId: number;
  settings: Omit<OrganisationGlobalSettings, 'id'>;
  hidePoweredBy: boolean;
  brandingSnapshot: unknown;
}) => {
  const pinnedBranding = await resolvePinnedEmailBranding({ teamId, brandingSnapshot, liveBranding: settings });

  if (!pinnedBranding) {
    return {
      branding: teamGlobalSettingsToBranding(settings, teamId, hidePoweredBy),
      brandingLogoAttachment: null,
    };
  }

  return {
    branding: teamGlobalSettingsToPinnedEmailBranding(settings, hidePoweredBy, pinnedBranding.branding),
    brandingLogoAttachment: pinnedBranding.attachment,
  };
};

/**
 * Resolve the branding an envelope's emails must render from its snapshot, or
 * null when the envelope has no readable snapshot and the caller must keep
 * resolving branding live.
 *
 * `resolveSigningBranding` owns the reference a pinned logo must be rendered
 * from, so it is reused here rather than duplicated: the emails and the signing
 * pages of one envelope must never disagree about the logo it shows. Emails ask
 * for the `content-id` reference and carry the bytes in the message, because
 * the live logo endpoint resolves the branding of the moment — a recipient
 * opening an email sent months ago must not be handed a logo the envelope never
 * used, nor a broken image when the branding was disabled since.
 */
const resolvePinnedEmailBranding = async ({
  teamId,
  brandingSnapshot,
  liveBranding,
}: {
  teamId: number;
  brandingSnapshot: unknown;
  liveBranding: TDerivedBrandingSettings;
}): Promise<{ branding: PinnedEmailBranding; attachment: TBrandingLogoAttachment | null } | null> => {
  const { branding, isPinned } = resolveEnvelopeBranding({ brandingSnapshot, liveBranding });

  if (!isPinned) {
    return null;
  }

  const { brandingLogoUrl, brandingLogoAttachment } = await resolveSigningBranding({
    teamId,
    brandingSnapshot,
    liveBranding,
    logoReference: 'content-id',
  });

  return {
    branding: {
      enabled: branding.enabled,
      logoUrl: brandingLogoUrl ?? '',
      url: branding.url,
      companyDetails: branding.companyDetails,
      colors: branding.colors,
    },
    attachment: brandingLogoAttachment,
  };
};

/**
 * Hand the caller a transport that carries the pinned logo's bytes, when there
 * are any. Senders that bypass the context transport (the Documenso-internal
 * mailer, used for owner notifications) must attach these themselves.
 */
const carryBrandingLogoAttachment = (transporter: Transporter, attachment: TBrandingLogoAttachment | null) =>
  attachment ? withBrandingLogoAttachment(transporter, attachment) : transporter;

const getAllowedEmails = (
  organisation: Organisation & {
    emailDomains: (Pick<EmailDomain, 'status'> & { emails: OrganisationEmail[] })[];
    organisationClaim: OrganisationClaim;
  },
) => {
  if (!organisation.organisationClaim.flags.emailDomains) {
    return [];
  }

  return organisation.emailDomains
    .filter((emailDomain) => emailDomain.status === EmailDomainStatus.ACTIVE)
    .flatMap((emailDomain) => emailDomain.emails);
};
