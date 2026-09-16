import { TemplateDocumentCompleted } from '@documenso/email/template-components/template-document-completed';
import { setupI18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

// An activated locale is required: I18nProvider renders null until
// i18n.activate() is called.
const i18n = setupI18n({ locale: 'en', messages: { en: {} } });
i18n.activate('en');

describe('TemplateDocumentCompleted', () => {
  const baseProps = {
    documentName: 'Test Document.pdf',
    assetBaseUrl: 'http://localhost:3000',
    downloadLink: 'http://localhost:3000/sign/test-token/complete',
  };

  // Note: @react-email/render resolves a different React instance under vitest
  // and returns an empty shell, so render statically instead.
  const renderTemplate = (allowDownload: boolean) =>
    renderToStaticMarkup(
      createElement(I18nProvider, { i18n }, createElement(TemplateDocumentCompleted, { ...baseProps, allowDownload })),
    );

  it('shows the download button when downloads are allowed', () => {
    const html = renderTemplate(true);

    expect(html).toContain(baseProps.downloadLink);
  });

  it('hides the download button for restricted recipients such as controlled signers', () => {
    const html = renderTemplate(false);

    expect(html).not.toContain(baseProps.downloadLink);
  });
});
