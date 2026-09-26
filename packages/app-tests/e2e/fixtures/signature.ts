import { prisma } from '@documenso/prisma';
import { expect, type Page } from '@playwright/test';
import type { Prisma } from '@prisma/client';

/**
 * Will open the signature pad dialog and sign it.
 */
export const signSignaturePad = async (page: Page) => {
  await page.waitForTimeout(200);

  await page.getByTestId('signature-pad-dialog-button').click();

  // Click type tab
  await page.getByRole('tab', { name: 'Type' }).click();
  await page.getByTestId('signature-pad-type-input').fill('Signature');

  // Click Next button
  await page.getByRole('button', { name: 'Next' }).click();
};

/**
 * For when the signature pad is already open.
 */
export const signDirectSignaturePad = async (page: Page) => {
  await page.waitForTimeout(200);

  // Click type tab
  await page.getByRole('tab', { name: 'Type' }).click();
  await page.getByTestId('signature-pad-type-input').fill('Signature');
};

type EnvelopeSignatureField = {
  id: number;
  positionX: Prisma.Decimal | number | string;
  positionY: Prisma.Decimal | number | string;
  width: Prisma.Decimal | number | string;
  height: Prisma.Decimal | number | string;
};

/**
 * Sign a signature field of a version 2 envelope and wait until the field is
 * inserted.
 *
 * The fields of a version 2 envelope are drawn on the Konva canvas of the page
 * renderer, so the field itself has no node to click: the signature is set on
 * the pad of the signing form and then applied by clicking the field on the
 * canvas, the interaction `e2e/envelopes/envelope-v2-field-insertion.spec.ts`
 * already uses. Setting the pad alone leaves the field uninserted, which is what
 * keeps the signing form reporting a remaining field and the completion button
 * reading "Next Field".
 *
 * The helper returns once the field is inserted in the database, so the caller
 * can move on to the completion without racing the insertion.
 */
export const signEnvelopeSignatureField = async (page: Page, field: EnvelopeSignatureField) => {
  // The canvas is only drawn once the page of the document is rendered.
  await page.locator('img[data-page-number]').first().waitFor({ state: 'visible', timeout: 30_000 });

  const canvas = page.locator('.konva-container canvas').first();

  await canvas.waitFor({ state: 'visible', timeout: 30_000 });

  await signSignaturePad(page);

  const canvasBox = await canvas.boundingBox();

  if (!canvasBox) {
    throw new Error('The canvas of the document page was not found');
  }

  // The fields are positioned as percentages of the page, so they are resolved
  // against the box the page is rendered in.
  const x = (Number(field.positionX) / 100) * canvasBox.width + ((Number(field.width) / 100) * canvasBox.width) / 2;
  const y = (Number(field.positionY) / 100) * canvasBox.height + ((Number(field.height) / 100) * canvasBox.height) / 2;

  await canvas.click({ position: { x, y } });

  await expect
    .poll(
      async () => {
        const insertedField = await prisma.field.findFirst({
          where: {
            id: field.id,
          },
          select: {
            inserted: true,
          },
        });

        return insertedField?.inserted;
      },
      { timeout: 15_000 },
    )
    .toBe(true);
};
