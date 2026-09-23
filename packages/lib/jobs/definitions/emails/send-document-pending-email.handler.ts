import { DocumentPendingEmailTemplate } from '@documenso/email/templates/document-pending';
import { unsafeBuildEnvelopeIdQuery } from '@documenso/lib/utils/envelope';
import { prisma } from '@documenso/prisma';
import { msg } from '@lingui/core/macro';
import { EnvelopeType } from '@prisma/client';
import { createElement } from 'react';
import { getI18nInstance } from '../../../client-only/providers/i18n-server';
import { NEXT_PUBLIC_WEBAPP_URL } from '../../../constants/app';
import { applyEmailTemplateOverride } from '../../../server-only/email/apply-email-template-override';
import { getEmailContext } from '../../../server-only/email/get-email-context';
import { getEmailTemplateOverride } from '../../../server-only/email/get-email-template-override';
import { extractDerivedDocumentEmailSettings } from '../../../types/document-email';
import { isRecipientEmailValidForSending } from '../../../utils/recipients';
import { renderEmailWithI18N } from '../../../utils/render-email-with-i18n';
import type { JobRunIO } from '../../client/_internal/job';
import type { TSendDocumentPendingEmailJobDefinition } from './send-document-pending-email';

export const run = async ({ payload }: { payload: TSendDocumentPendingEmailJobDefinition; io: JobRunIO }) => {
  const { envelopeId, recipientId } = payload;

  const envelope = await prisma.envelope.findFirst({
    where: {
      ...unsafeBuildEnvelopeIdQuery({ type: 'envelopeId', id: envelopeId }, EnvelopeType.DOCUMENT),
      recipients: {
        some: {
          id: recipientId,
        },
      },
    },
    include: {
      recipients: {
        where: {
          id: recipientId,
        },
      },
      documentMeta: true,
    },
  });

  if (!envelope || envelope.recipients.length === 0) {
    return;
  }

  const { branding, emailLanguage, senderEmail, replyToEmail, emailsDisabled, emailTransport } = await getEmailContext({
    emailType: 'RECIPIENT',
    source: {
      type: 'team',
      teamId: envelope.teamId,
      brandingSnapshot: envelope.brandingSnapshot,
    },
    meta: envelope.documentMeta,
  });

  // Don't send any emails if the organisation has email sending disabled.
  if (emailsDisabled) {
    return;
  }

  const isDocumentPendingEmailEnabled = extractDerivedDocumentEmailSettings(envelope.documentMeta).documentPending;

  if (!isDocumentPendingEmailEnabled) {
    return;
  }

  const [recipient] = envelope.recipients;

  const { email, name } = recipient;

  // Skip sending email if recipient has no email address
  if (!isRecipientEmailValidForSending(recipient)) {
    return;
  }

  const assetBaseUrl = NEXT_PUBLIC_WEBAPP_URL() || 'http://localhost:3000';

  const i18n = await getI18nInstance(emailLanguage);

  // Admin-defined global template override for the pending email.
  const templateOverride = await getEmailTemplateOverride('document-pending');

  const appliedTemplate = applyEmailTemplateOverride({
    subject: i18n._(msg`Waiting for others to complete signing`),
    body: '',
    override: templateOverride,
    variables: {
      documentName: envelope.title,
      recipientName: name,
      recipientEmail: email,
    },
  });

  const template = createElement(DocumentPendingEmailTemplate, {
    documentName: envelope.title,
    assetBaseUrl,
    customBody: appliedTemplate.hasBodyOverride ? appliedTemplate.body : undefined,
  });

  const [html, text] = await Promise.all([
    renderEmailWithI18N(template, { lang: emailLanguage, branding }),
    renderEmailWithI18N(template, {
      lang: emailLanguage,
      branding,
      plainText: true,
    }),
  ]);

  await emailTransport.sendMail({
    to: {
      address: email,
      name,
    },
    from: senderEmail,
    replyTo: replyToEmail,
    subject: appliedTemplate.subject,
    html,
    text,
  });
};
