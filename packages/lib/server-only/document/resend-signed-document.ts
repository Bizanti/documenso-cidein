import { DocumentResendEmailTemplate } from '@documenso/email/templates/document-resend';
import { prisma } from '@documenso/prisma';
import type { TGetTeamMembersResponse } from '@documenso/trpc/server/team-router/get-team-members.types';
import { msg } from '@lingui/core/macro';
import { DocumentStatus, EnvelopeType, TeamMemberRole } from '@prisma/client';
import { createElement } from 'react';

import { getI18nInstance } from '../../client-only/providers/i18n-server';
import { NEXT_PUBLIC_WEBAPP_URL } from '../../constants/app';
import { AppError, AppErrorCode } from '../../errors/app-error';
import { DOCUMENT_AUDIT_LOG_TYPE } from '../../types/document-audit-logs';
import type { ApiRequestMetadata } from '../../universal/extract-request-metadata';
import { getFileServerSide } from '../../universal/upload/get-file.server';
import { createDocumentAuditLogData } from '../../utils/document-audit-logs';
import type { EnvelopeIdOptions } from '../../utils/envelope';
import { getRecipientRoleCapabilities, isRecipientEmailValidForSending } from '../../utils/recipients';
import { renderCustomEmailTemplate } from '../../utils/render-custom-email-template';
import { renderEmailWithI18N } from '../../utils/render-email-with-i18n';
import { hasSgcDownloadPrivileges } from '../../utils/teams';
import { buildEnvelopeEmailHeaders } from '../email/build-envelope-email-headers';
import { getEmailContext } from '../email/get-email-context';
import { getEnvelopeWhereInput } from '../envelope/get-envelope-by-id';
import { assertOrganisationRatesAndLimits } from '../rate-limit/assert-organisation-rates-and-limits';
import { getTeamById } from '../team/get-team';
import { getTeamMembers } from '../team/get-team-members';
import { assertUserNotDisabled } from '../user/assert-user-not-disabled';

export type ResendSignedDocumentOptions = {
  id: EnvelopeIdOptions;
  userId: number;
  teamId: number;

  /**
   * The recipients the signed document should be delivered to again.
   */
  recipientIds: number[];

  /**
   * Optional message shown in the email in place of the default copy.
   */
  message?: string | null;
  requestMetadata: ApiRequestMetadata;
};

type GetSignedDocumentResendCcOptions = {
  teamMembers: TGetTeamMembersResponse;
  recipientEmails: string[];
};

/**
 * The copy list for a signed document delivery: the team members holding the SGC
 * role, minus anyone that already receives the email directly.
 */
export const getSignedDocumentResendCc = ({
  teamMembers,
  recipientEmails,
}: GetSignedDocumentResendCcOptions): { address: string; name: string }[] => {
  const lowerCaseRecipientEmails = recipientEmails.map((email) => email.toLowerCase());

  const seen = new Set<string>();

  return teamMembers
    .filter((member) => member.teamRole === TeamMemberRole.SGC)
    .filter((member) => {
      const email = member.email.toLowerCase();

      if (lowerCaseRecipientEmails.includes(email) || seen.has(email)) {
        return false;
      }

      seen.add(email);

      return true;
    })
    .map((member) => ({
      address: member.email,
      name: member.name ?? '',
    }));
};

/**
 * Delivers the signed document to the given recipients again, logging the new
 * delivery on the document audit log.
 *
 * Team members holding the SGC download privileges (ADMIN/SGC) are copied on the
 * email, so the quality management team keeps a record of every delivery of a
 * signed document.
 */
export const resendSignedDocument = async ({
  id,
  userId,
  teamId,
  recipientIds,
  message,
  requestMetadata,
}: ResendSignedDocumentOptions) => {
  const user = await prisma.user.findFirstOrThrow({
    where: {
      id: userId,
    },
    select: {
      id: true,
      email: true,
      name: true,
      disabled: true,
    },
  });

  assertUserNotDisabled(user);

  const { envelopeWhereInput } = await getEnvelopeWhereInput({
    id,
    type: EnvelopeType.DOCUMENT,
    userId,
    teamId,
  });

  const envelope = await prisma.envelope.findUnique({
    where: envelopeWhereInput,
    include: {
      recipients: true,
      documentMeta: true,
      envelopeItems: {
        include: {
          documentData: {
            select: {
              type: true,
              id: true,
              data: true,
            },
          },
        },
      },
      team: {
        select: {
          id: true,
          name: true,
          url: true,
          teamEmail: {
            select: {
              email: true,
            },
          },
        },
      },
    },
  });

  if (!envelope) {
    throw new AppError(AppErrorCode.NOT_FOUND, {
      message: 'Document not found',
    });
  }

  const team = await getTeamById({ userId, teamId }).catch(() => null);

  const isOwner = envelope.userId === userId;
  const canResendSignedDocument = isOwner || (team !== null && hasSgcDownloadPrivileges(team.currentTeamRole));

  if (!canResendSignedDocument) {
    throw new AppError(AppErrorCode.FORBIDDEN, {
      message: 'You are not allowed to resend this document',
    });
  }

  if (envelope.status !== DocumentStatus.COMPLETED || !envelope.completedAt) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'Only completed documents can be resent',
    });
  }

  const recipientsToSend = envelope.recipients.filter((recipient) => recipientIds.includes(recipient.id));

  if (recipientsToSend.length === 0) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'No recipients to resend the document to',
    });
  }

  if (recipientsToSend.some((recipient) => !getRecipientRoleCapabilities(recipient.role).receivesCompletedPdf)) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'The signed document can not be sent to the selected recipients',
    });
  }

  const { branding, emailLanguage, senderEmail, replyToEmail, organisationId, claims, emailsDisabled, emailTransport } =
    await getEmailContext({
      emailType: 'RECIPIENT',
      source: {
        type: 'team',
        teamId: envelope.teamId,
      },
      meta: envelope.documentMeta,
    });

  // Don't send any emails if the organisation has email sending disabled.
  if (user.disabled || emailsDisabled) {
    return envelope;
  }

  await assertOrganisationRatesAndLimits({
    organisationId,
    organisationClaim: claims,
    count: recipientsToSend.length,
    type: 'email',
  });

  const signedDocumentAttachments = await Promise.all(
    envelope.envelopeItems.map(async (envelopeItem) => {
      const file = await getFileServerSide(envelopeItem.documentData);

      // Use the envelope title for version 1, and the envelope item title for version 2.
      const fileNameToUse = envelope.internalVersion === 1 ? envelope.title : envelopeItem.title;

      return {
        filename: fileNameToUse.endsWith('.pdf') ? fileNameToUse : `${fileNameToUse}.pdf`,
        content: Buffer.from(file),
        contentType: 'application/pdf',
      };
    }),
  );

  const assetBaseUrl = NEXT_PUBLIC_WEBAPP_URL() || 'http://localhost:3000';

  // Copy in the team members holding the SGC privileges so the delivery is
  // recorded outside the sender's mailbox.
  const teamMembers = await getTeamMembers({ userId, teamId: envelope.teamId }).catch(() => []);

  const cc = getSignedDocumentResendCc({
    teamMembers,
    recipientEmails: recipientsToSend.map((recipient) => recipient.email),
  });

  await Promise.all(
    recipientsToSend.map(async (recipient) => {
      if (!isRecipientEmailValidForSending(recipient)) {
        return;
      }

      const i18n = await getI18nInstance(emailLanguage);

      const customEmailTemplate = {
        'signer.name': recipient.name,
        'signer.email': recipient.email,
        'document.name': envelope.title,
      };

      const template = createElement(DocumentResendEmailTemplate, {
        documentName: envelope.title,
        assetBaseUrl,
        downloadLink: `${NEXT_PUBLIC_WEBAPP_URL()}/sign/${recipient.token}/complete`,
        customBody: message ? renderCustomEmailTemplate(message, customEmailTemplate) : undefined,
        hasAttachment: signedDocumentAttachments.length > 0,
      });

      const [html, text] = await Promise.all([
        renderEmailWithI18N(template, {
          lang: emailLanguage,
          branding,
        }),
        renderEmailWithI18N(template, {
          lang: emailLanguage,
          branding,
          plainText: true,
        }),
      ]);

      await emailTransport.sendMail({
        to: [
          {
            address: recipient.email,
            name: recipient.name,
          },
        ],
        cc: cc.length > 0 ? cc : undefined,
        from: senderEmail,
        replyTo: replyToEmail,
        subject: i18n._(msg`Signed document: ${envelope.title}`),
        html,
        text,
        attachments: signedDocumentAttachments,
        headers: buildEnvelopeEmailHeaders({
          userId: envelope.userId,
          envelopeId: envelope.id,
          teamId: envelope.teamId,
        }),
      });

      await prisma.documentAuditLog.create({
        data: createDocumentAuditLogData({
          type: DOCUMENT_AUDIT_LOG_TYPE.EMAIL_SENT,
          envelopeId: envelope.id,
          metadata: requestMetadata,
          data: {
            emailType: 'DOCUMENT_COMPLETED',
            recipientEmail: recipient.email,
            recipientName: recipient.name,
            recipientRole: recipient.role,
            recipientId: recipient.id,
            isResending: true,
          },
        }),
      });
    }),
  );

  return envelope;
};
