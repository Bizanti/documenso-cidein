import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';

import { Body, Container, Head, Html, Preview, Section } from '../components';
import { TemplateBrandingLogo } from '../template-components/template-branding-logo';
import type { TemplateDocumentResendProps } from '../template-components/template-document-resend';
import { TemplateDocumentResend } from '../template-components/template-document-resend';
import { TemplateFooter } from '../template-components/template-footer';

export type DocumentResendEmailTemplateProps = Partial<TemplateDocumentResendProps> & {
  reportUrl?: string;
};

export const DocumentResendEmailTemplate = ({
  documentName = 'Open Source Pledge.pdf',
  assetBaseUrl = 'http://localhost:3002',
  downloadLink,
  customBody,
  hasAttachment = false,
  reportUrl,
}: DocumentResendEmailTemplateProps) => {
  const { _ } = useLingui();

  const previewText = msg`Signed document`;

  return (
    <Html>
      <Head />
      <Body className="mx-auto my-auto font-sans">
        <Preview>{_(previewText)}</Preview>

        <Section className="bg-background">
          <Container className="mx-auto mt-8 mb-2 max-w-xl rounded-lg border border-border border-solid p-2 backdrop-blur-sm">
            <Section className="p-2">
              <TemplateBrandingLogo assetBaseUrl={assetBaseUrl} className="mb-4 h-6" />

              <TemplateDocumentResend
                documentName={documentName}
                assetBaseUrl={assetBaseUrl}
                downloadLink={downloadLink}
                customBody={customBody}
                hasAttachment={hasAttachment}
              />
            </Section>
          </Container>

          <Container className="mx-auto max-w-xl">
            <TemplateFooter reportUrl={reportUrl} />
          </Container>
        </Section>
      </Body>
    </Html>
  );
};

export default DocumentResendEmailTemplate;
