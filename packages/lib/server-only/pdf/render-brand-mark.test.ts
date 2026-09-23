import type { I18n } from '@lingui/core';
import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';

import { PDF_SIZE_A4_72PPI } from '../../constants/pdf';
import { rightAlignWithinContent } from './helpers';
import { renderAuditLogBrandMark } from './render-audit-logs';
import { renderCertificateBrandMark } from './render-certificate';

/**
 * The logo of the QA finding: 1024x16, inside the upload limits, and 768 units
 * wide at the certificate's 12 unit height — wider than the A4 page.
 */
const EXTREME_WIDE_LOGO = { width: 1024, height: 16 };
const EXTREME_TALL_LOGO = { width: 16, height: 1024 };
const WORDMARK_LOGO = { width: 160, height: 40 };

/** The content column and margins both generated artifacts use on an A4 page. */
const MINIMUM_MARGIN = 10;
const CONTENT_MAX_WIDTH = 768;

const pageWidth = PDF_SIZE_A4_72PPI.width;
const contentWidth = Math.min(pageWidth - MINIMUM_MARGIN * 2, CONTENT_MAX_WIDTH);
const margin = (pageWidth - contentWidth) / 2;

const i18n = { _: (descriptor: { message?: string }) => descriptor.message ?? '' } as unknown as I18n;

const createLogoPng = async ({ width, height }: { width: number; height: number }) => {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');

  context.fillStyle = '#ff00ff';
  context.fillRect(0, 0, width, height);

  return Buffer.from(await canvas.encode('png'));
};

type BrandMark = ReturnType<typeof renderCertificateBrandMark>;

const findLogoImage = (mark: BrandMark) => {
  const logo = mark.find('Image')[0];

  if (!logo) {
    throw new Error('The brand mark must render a logo image');
  }

  return logo;
};

/** A mark fits when its right-aligned position keeps it inside the column. */
const rightAlignAndCheck = (mark: BrandMark) => {
  const markRect = mark.getClientRect();

  expect(markRect.width).toBeLessThanOrEqual(contentWidth);

  const x = rightAlignWithinContent({ elementWidth: markRect.width, pageWidth, margin });

  expect(x + markRect.width).toBeLessThanOrEqual(pageWidth - margin);

  return { markRect, x };
};

describe('rightAlignWithinContent', () => {
  it('pins an element that fits against the right edge of the column', () => {
    const elementWidth = 200;

    const x = rightAlignWithinContent({ elementWidth, pageWidth, margin });

    expect(x).toBeGreaterThan(margin);
    expect(x + elementWidth).toBeCloseTo(pageWidth - margin, 5);
  });

  it('never starts an element wider than the column before the left margin', () => {
    expect(rightAlignWithinContent({ elementWidth: contentWidth * 2, pageWidth, margin })).toBe(margin);
  });
});

describe('renderCertificateBrandMark', () => {
  it('scales an extremely wide logo down to the column left of the label', async () => {
    const mark = renderCertificateBrandMark({
      brandingLogo: await createLogoPng(EXTREME_WIDE_LOGO),
      i18n,
      contentWidth,
    });

    const logo = findLogoImage(mark);

    expect(logo.x()).toBeGreaterThan(0);
    expect(logo.x() + logo.width()).toBeLessThanOrEqual(contentWidth);
    expect(logo.width()).toBeLessThan(EXTREME_WIDE_LOGO.width);

    // The proportions survive the cap: 1024x16 stays 64 times wider than tall.
    expect(logo.width() / logo.height()).toBeCloseTo(EXTREME_WIDE_LOGO.width / EXTREME_WIDE_LOGO.height, 5);
  });

  it('fits an extremely wide logo inside the page', async () => {
    const mark = renderCertificateBrandMark({
      brandingLogo: await createLogoPng(EXTREME_WIDE_LOGO),
      i18n,
      contentWidth,
    });

    const { markRect } = rightAlignAndCheck(mark);

    // The mark is the label line plus the logo next to it, never taller.
    expect(markRect.height).toBeLessThanOrEqual(12);
  });

  it('keeps an extremely tall logo inside the page', async () => {
    const mark = renderCertificateBrandMark({
      brandingLogo: await createLogoPng(EXTREME_TALL_LOGO),
      i18n,
      contentWidth,
    });

    rightAlignAndCheck(mark);

    const logo = findLogoImage(mark);

    expect(logo.width()).toBeLessThan(contentWidth);
    expect(logo.height()).toBeLessThanOrEqual(12);
  });

  it('right-aligns a logo that fits without moving it off the column', async () => {
    const mark = renderCertificateBrandMark({
      brandingLogo: await createLogoPng(WORDMARK_LOGO),
      i18n,
      contentWidth,
    });

    const { markRect, x } = rightAlignAndCheck(mark);

    // A mark narrower than the column sits against its right edge.
    expect(x).toBeGreaterThan(margin);
    expect(x + markRect.width).toBeCloseTo(pageWidth - margin, 5);
    expect(findLogoImage(mark).width()).toBe(48);
  });
});

describe('renderAuditLogBrandMark', () => {
  it('scales an extremely wide logo down to the content column', async () => {
    const mark = renderAuditLogBrandMark({ brandingLogo: await createLogoPng(EXTREME_WIDE_LOGO), contentWidth });

    const { markRect } = rightAlignAndCheck(mark);

    expect(markRect.width).toBe(contentWidth);
    expect(markRect.height).toBeLessThanOrEqual(16);
  });

  it('keeps an extremely tall logo inside the page', async () => {
    const mark = renderAuditLogBrandMark({ brandingLogo: await createLogoPng(EXTREME_TALL_LOGO), contentWidth });

    rightAlignAndCheck(mark);

    expect(findLogoImage(mark).height()).toBeLessThanOrEqual(16);
  });

  it('right-aligns a logo that fits without moving it off the column', async () => {
    const mark = renderAuditLogBrandMark({ brandingLogo: await createLogoPng(WORDMARK_LOGO), contentWidth });

    const { markRect, x } = rightAlignAndCheck(mark);

    expect(x).toBeGreaterThan(margin);
    expect(x + markRect.width).toBeCloseTo(pageWidth - margin, 5);
  });
});
