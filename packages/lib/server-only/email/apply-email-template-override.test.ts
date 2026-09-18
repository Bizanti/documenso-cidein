import { describe, expect, it } from 'vitest';

import { applyEmailTemplateOverride } from './apply-email-template-override';

const variables = {
  documentName: 'Contrato de servicios.pdf',
  recipientName: 'Ada Lovelace',
  recipientEmail: 'ada@example.com',
  senderName: 'Grace Hopper',
  senderEmail: 'grace@example.com',
};

describe('applyEmailTemplateOverride', () => {
  it('returns the default subject and body when there is no override', () => {
    const result = applyEmailTemplateOverride({
      subject: 'Default subject',
      body: 'Default body',
      override: null,
      variables,
    });

    expect(result).toEqual({
      subject: 'Default subject',
      body: 'Default body',
      hasSubjectOverride: false,
      hasBodyOverride: false,
    });
  });

  it('returns the default subject and body when the override fields are blank', () => {
    const result = applyEmailTemplateOverride({
      subject: 'Default subject',
      body: 'Default body',
      override: { subject: '   ', body: '' },
      variables,
    });

    expect(result.subject).toEqual('Default subject');
    expect(result.body).toEqual('Default body');
    expect(result.hasSubjectOverride).toEqual(false);
    expect(result.hasBodyOverride).toEqual(false);
  });

  it('applies the override subject and body with variables rendered', () => {
    const result = applyEmailTemplateOverride({
      subject: 'Default subject',
      body: 'Default body',
      override: {
        subject: 'Firma requerida: {documentName}',
        body: 'Hola {recipientName}, {senderName} te ha enviado {documentName}.',
      },
      variables,
    });

    expect(result.subject).toEqual('Firma requerida: Contrato de servicios.pdf');
    expect(result.body).toEqual('Hola Ada Lovelace, Grace Hopper te ha enviado Contrato de servicios.pdf.');
    expect(result.hasSubjectOverride).toEqual(true);
    expect(result.hasBodyOverride).toEqual(true);
  });

  it('overrides subject and body independently', () => {
    const result = applyEmailTemplateOverride({
      subject: 'Default subject',
      body: 'Default body',
      override: { subject: 'Only subject {documentName}', body: '' },
      variables,
    });

    expect(result.subject).toEqual('Only subject Contrato de servicios.pdf');
    expect(result.body).toEqual('Default body');
    expect(result.hasSubjectOverride).toEqual(true);
    expect(result.hasBodyOverride).toEqual(false);
  });

  it('leaves unknown variables untouched', () => {
    const result = applyEmailTemplateOverride({
      subject: 'Default subject',
      body: 'Default body',
      override: { subject: '{unknownVariable}', body: '' },
      variables,
    });

    expect(result.subject).toEqual('unknownVariable');
  });
});
