import { readFileSync } from 'node:fs';
import { setupI18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { RecipientRole } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { getRecipientsThatReceiveCompletedDocument, ZDocumentResendSignedFormSchema } from './document-resend-signed';

/**
 * The translation a locale catalogue holds for a source message.
 */
const readCatalogTranslation = (locale: string, message: string) => {
  const catalog = readFileSync(new URL(`../translations/${locale}/web.po`, import.meta.url), 'utf8');

  const escapedMessage = message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const [, translation] = catalog.match(new RegExp(`^msgid "${escapedMessage}"\r?\nmsgstr "([^"\r\n]*)"`, 'm')) ?? [];

  if (!translation) {
    throw new Error(`The "${locale}" catalogue has no translation for "${message}".`);
  }

  return translation;
};

const getRecipientsValidationMessage = () => {
  const result = ZDocumentResendSignedFormSchema.safeParse({ recipients: [] });

  if (result.success) {
    throw new Error('Expected an empty recipient selection to fail validation.');
  }

  return result.error.issues[0].message;
};

describe('ZDocumentResendSignedFormSchema', () => {
  it('rejects an empty recipient selection', () => {
    expect(ZDocumentResendSignedFormSchema.safeParse({ recipients: [] }).success).toBe(false);
  });

  it('stores the Lingui message id as the validation message', () => {
    expect(getRecipientsValidationMessage()).toBe(msg`You must select at least one recipient`.id);
  });

  it('resolves the validation message to the catalogue translation', () => {
    const messageId = getRecipientsValidationMessage();
    const translation = readCatalogTranslation('es', 'You must select at least one recipient');

    // The catalogue keeps the translation under the generated message id, which
    // is why the UI resolves the validation message through `i18n._()`.
    expect(translation).toBe('Debes seleccionar al menos un destinatario');

    const i18n = setupI18n({ locale: 'es', messages: { es: { [messageId]: translation } } });

    expect(i18n._(messageId)).toBe(translation);
    expect(i18n._(messageId)).not.toBe(messageId);
  });
});

describe('getRecipientsThatReceiveCompletedDocument', () => {
  it('returns no recipients when the document only has controlled signers', () => {
    const recipients = [{ id: 1, role: RecipientRole.CONTROLLED_SIGNER }];

    expect(getRecipientsThatReceiveCompletedDocument(recipients)).toEqual([]);
  });

  it('keeps the recipients that receive the completed document', () => {
    const recipients = [
      { id: 1, role: RecipientRole.CONTROLLED_SIGNER },
      { id: 2, role: RecipientRole.SIGNER },
      { id: 3, role: RecipientRole.CC },
    ];

    expect(getRecipientsThatReceiveCompletedDocument(recipients)).toEqual([
      { id: 2, role: RecipientRole.SIGNER },
      { id: 3, role: RecipientRole.CC },
    ]);
  });
});
