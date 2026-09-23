import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';

import { renderBrandLogoImage, resolveBrandLogoSize } from './brand-logo';

/**
 * The logo shapes from the QA finding: a wordmark far wider than it is tall,
 * and its vertical counterpart. Both are within the upload limits (1024x1024
 * source pixels), so both reach the renderer.
 */
const EXTREME_WIDE_LOGO = { width: 1024, height: 16 };
const EXTREME_TALL_LOGO = { width: 16, height: 1024 };
const WORDMARK_LOGO = { width: 160, height: 40 };

const createLogoPng = async ({ width, height }: { width: number; height: number }) => {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');

  context.fillStyle = '#ff00ff';
  context.fillRect(0, 0, width, height);

  return Buffer.from(await canvas.encode('png'));
};

const sizeOf = (logo: { width: number; height: number }, { height, maxWidth }: { height: number; maxWidth?: number }) =>
  resolveBrandLogoSize({ imageWidth: logo.width, imageHeight: logo.height, height, maxWidth });

const expectSameAspectRatio = (
  rendered: { width: number; height: number },
  source: { width: number; height: number },
) => {
  expect(rendered.width / rendered.height).toBeCloseTo(source.width / source.height, 5);
};

describe('resolveBrandLogoSize', () => {
  it('keeps the requested height when the logo fits the available width', () => {
    expect(sizeOf(WORDMARK_LOGO, { height: 12, maxWidth: 768 })).toEqual({ width: 48, height: 12 });
  });

  it('caps an extremely wide logo at the available width and shrinks the height with it', () => {
    const size = sizeOf(EXTREME_WIDE_LOGO, { height: 12, maxWidth: 500 });

    expect(size.width).toBe(500);
    expect(size.height).toBeCloseTo(7.8125, 4);
    expectSameAspectRatio(size, EXTREME_WIDE_LOGO);
  });

  it('keeps the height when it is the limit that binds first', () => {
    // 16x1024 at height 12 is only 0.19 wide, so the width limit never applies.
    const size = sizeOf(EXTREME_TALL_LOGO, { height: 12, maxWidth: 500 });

    expect(size).toEqual({ width: 0.1875, height: 12 });
    expectSameAspectRatio(size, EXTREME_TALL_LOGO);
  });

  it('keeps the natural width when the logo already fits exactly', () => {
    expect(sizeOf(EXTREME_WIDE_LOGO, { height: 12, maxWidth: 768 })).toEqual({ width: 768, height: 12 });
  });

  it('leaves the width unbounded when no limit is given', () => {
    expect(sizeOf(EXTREME_WIDE_LOGO, { height: 12 })).toEqual({ width: 768, height: 12 });
  });

  it('never returns a negative size when there is no room left', () => {
    expect(sizeOf(EXTREME_WIDE_LOGO, { height: 12, maxWidth: -20 })).toEqual({ width: 0, height: 0 });
  });
});

describe('renderBrandLogoImage', () => {
  it('renders an extremely wide logo inside the available width', async () => {
    const image = renderBrandLogoImage({ logo: await createLogoPng(EXTREME_WIDE_LOGO), height: 12, maxWidth: 500 });

    expect(image).not.toBeNull();
    expect(image?.width()).toBe(500);
    expect(image?.height()).toBeLessThanOrEqual(12);
    expectSameAspectRatio({ width: image?.width() ?? 0, height: image?.height() ?? 0 }, EXTREME_WIDE_LOGO);
  });

  it('renders an extremely tall logo at the requested height', async () => {
    const image = renderBrandLogoImage({ logo: await createLogoPng(EXTREME_TALL_LOGO), height: 12, maxWidth: 500 });

    expect(image).not.toBeNull();
    expect(image?.height()).toBe(12);
    expect(image?.width()).toBeLessThanOrEqual(500);
    expectSameAspectRatio({ width: image?.width() ?? 0, height: image?.height() ?? 0 }, EXTREME_TALL_LOGO);
  });

  it('leaves an ordinary logo untouched when it fits', async () => {
    const image = renderBrandLogoImage({ logo: await createLogoPng(WORDMARK_LOGO), height: 12, maxWidth: 500 });

    expect(image?.width()).toBe(48);
    expect(image?.height()).toBe(12);
  });
});
