import { Trans } from '@lingui/react/macro';

import { Button, Column, Img, Section, Text } from '../components';
import { TemplateDocumentImage } from './template-document-image';

export interface TemplateDocumentResendProps {
  documentName: string;
  assetBaseUrl: string;

  /**
   * Link to the recipient's completed document page.
   */
  downloadLink?: string;

  /**
   * The optional message written by the person resending the document.
   */
  customBody?: string;

  /**
   * Whether the signed document is attached to the email.
   */
  hasAttachment?: boolean;
}

export const TemplateDocumentResend = ({
  documentName,
  assetBaseUrl,
  downloadLink,
  customBody,
  hasAttachment = false,
}: TemplateDocumentResendProps) => {
  const getAssetUrl = (path: string) => {
    return new URL(path, assetBaseUrl).toString();
  };

  return (
    <>
      <TemplateDocumentImage className="mt-6" assetBaseUrl={assetBaseUrl} />

      <Section>
        <Section className="mb-4">
          <Column align="center">
            <Text className="font-semibold text-base text-foreground">
              <Img
                src={getAssetUrl('/static/completed.png')}
                className="-mt-0.5 mr-2 inline h-7 w-7 align-middle"
                alt=""
              />
              <Trans>Signed document</Trans>
            </Text>
          </Column>
        </Section>

        <Text className="mb-0 text-center font-semibold text-foreground text-lg">
          {customBody || <Trans>“{documentName}” has been signed and is being sent to you again</Trans>}
        </Text>

        {hasAttachment && (
          <Text className="my-1 text-center text-base text-muted-foreground">
            <Trans>A copy of the signed document is attached to this email.</Trans>
          </Text>
        )}

        {downloadLink && (
          <Section className="mt-8 mb-6 text-center">
            <Button
              className="rounded-lg border border-border border-solid px-4 py-2 text-center font-medium text-foreground text-sm no-underline"
              href={downloadLink}
            >
              <Img
                src={getAssetUrl('/static/download.png')}
                className="mr-2 mb-0.5 inline h-5 w-5 align-middle"
                alt=""
              />
              <Trans>Download</Trans>
            </Button>
          </Section>
        )}
      </Section>
    </>
  );
};

export default TemplateDocumentResend;
