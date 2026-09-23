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

/**
 * Render a brand mark at a fixed height, keeping the logo's aspect ratio so
 * both a wordmark and a square icon stay proportional.
 *
 * Returns null when the bytes cannot be decoded, which lets a broken brand logo
 * fall back to the Documenso mark instead of failing the seal.
 */
export const renderBrandLogoImage = ({ logo, height, x = 0 }: { logo: Buffer; height: number; x?: number }) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  const img = new SkiaImage(logo) as unknown as HTMLImageElement;

  if (!img.width || !img.height) {
    return null;
  }

  return new Konva.Image({
    image: img,
    height,
    width: height * (img.width / img.height),
    x,
  });
};
