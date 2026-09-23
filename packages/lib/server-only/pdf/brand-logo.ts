// sort-imports-ignore
import '../konva/skia-backend';

import fs from 'node:fs';
import path from 'node:path';
import { Image as SkiaImage } from '@documenso/skia-canvas';
import Konva from 'konva';

/**
 * The Documenso mark, used by every generated artifact that has no pinned brand
 * to render instead.
 */
export const readFallbackBrandLogo = () => fs.readFileSync(path.join(process.cwd(), 'public/static/logo.png'));

type ResolveBrandLogoSizeOptions = {
  /** Intrinsic size of the decoded logo, in pixels. */
  imageWidth: number;
  imageHeight: number;

  /** Height the mark is rendered at. */
  height: number;

  /**
   * Upper bound for the rendered width, or undefined for no bound.
   *
   * The width limit wins over the height: a logo that cannot be shown at
   * `height` without overflowing the space it is given shrinks proportionally
   * instead of being drawn past the edge of the page.
   */
  maxWidth?: number;
};

/**
 * The rendered size of a brand mark: the requested height, unless the logo's
 * aspect ratio would make the mark wider than `maxWidth`, in which case the
 * width limit wins and the height shrinks with it.
 */
export const resolveBrandLogoSize = ({ imageWidth, imageHeight, height, maxWidth }: ResolveBrandLogoSizeOptions) => {
  const width = height * (imageWidth / imageHeight);

  if (maxWidth === undefined || width <= maxWidth) {
    return { width, height };
  }

  const cappedWidth = Math.max(maxWidth, 0);

  return {
    width: cappedWidth,
    height: cappedWidth * (imageHeight / imageWidth),
  };
};

type RenderBrandLogoImageOptions = {
  logo: Buffer;
  height: number;
  maxWidth?: number;
  x?: number;
};

/**
 * Render a brand mark at a fixed height, keeping the logo's aspect ratio so
 * both a wordmark and a square icon stay proportional.
 *
 * A `maxWidth` caps the mark to the space reserved for it, so an extremely wide
 * logo (e.g. a 1024x16 wordmark) is scaled down rather than running off the
 * page.
 *
 * Returns null when the bytes cannot be decoded, which lets a broken brand logo
 * fall back to the Documenso mark instead of failing the seal.
 */
export const renderBrandLogoImage = ({ logo, height, maxWidth, x = 0 }: RenderBrandLogoImageOptions) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  const img = new SkiaImage(logo) as unknown as HTMLImageElement;

  if (!img.width || !img.height) {
    return null;
  }

  const size = resolveBrandLogoSize({
    imageWidth: img.width,
    imageHeight: img.height,
    height,
    maxWidth,
  });

  return new Konva.Image({
    image: img,
    height: size.height,
    width: size.width,
    x,
  });
};
