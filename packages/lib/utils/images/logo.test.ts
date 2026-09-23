import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import {
  BRANDING_LOGO_MAX_SIZE_BYTES,
  BRANDING_LOGO_MAX_SOURCE_DIMENSION,
  BRANDING_LOGO_OUTPUT_SIZE,
} from '../../constants/branding';
import { assertValidBrandingLogoSource, hasPngMagicBytes, optimiseBrandingLogo } from './logo';

const createPng = (width = 256, height = 256) =>
  sharp({ create: { width, height, channels: 3, background: { r: 10, g: 20, b: 30 } } })
    .png()
    .toBuffer();

const createJpeg = (width = 256, height = 256) =>
  sharp({ create: { width, height, channels: 3, background: { r: 10, g: 20, b: 30 } } })
    .jpeg()
    .toBuffer();

describe('hasPngMagicBytes', () => {
  it('accepts a real PNG', async () => {
    expect(hasPngMagicBytes(await createPng())).toBe(true);
  });

  it('rejects a JPEG, even when the upload declares itself as a PNG', async () => {
    expect(hasPngMagicBytes(await createJpeg())).toBe(false);
  });

  it('rejects a buffer shorter than the signature', () => {
    expect(hasPngMagicBytes(Buffer.from([0x89, 0x50, 0x4e]))).toBe(false);
  });
});

describe('assertValidBrandingLogoSource', () => {
  it('accepts a PNG up to the source dimension cap', async () => {
    const atCap = await createPng(BRANDING_LOGO_MAX_SOURCE_DIMENSION, 256);

    await expect(assertValidBrandingLogoSource(atCap)).resolves.toBeUndefined();
  });

  it('rejects an upload larger than the file size limit', async () => {
    // The size gate fires before the pixels are touched, so the payload does
    // not need to be a decodable image.
    const oversized = Buffer.alloc(BRANDING_LOGO_MAX_SIZE_BYTES + 1);

    await expect(assertValidBrandingLogoSource(oversized)).rejects.toThrow(/cannot be larger than 1MB/);
  });

  it('rejects a non-PNG payload', async () => {
    await expect(assertValidBrandingLogoSource(await createJpeg())).rejects.toThrow(/must be a PNG file/);
  });

  it('rejects a PNG wider than the source dimension cap', async () => {
    const tooWide = await createPng(BRANDING_LOGO_MAX_SOURCE_DIMENSION + 1, 256);

    await expect(assertValidBrandingLogoSource(tooWide)).rejects.toThrow(/cannot be larger than 1024x1024 pixels/);
  });

  it('rejects a PNG taller than the source dimension cap', async () => {
    const tooTall = await createPng(256, BRANDING_LOGO_MAX_SOURCE_DIMENSION + 1);

    await expect(assertValidBrandingLogoSource(tooTall)).rejects.toThrow(/cannot be larger than 1024x1024 pixels/);
  });

  it('rejects a payload with the PNG signature that is not a decodable image', async () => {
    const signatureOnly = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('not actually a png body'),
    ]);

    await expect(assertValidBrandingLogoSource(signatureOnly)).rejects.toThrow(/must be a valid image file/);
  });
});

describe('optimiseBrandingLogo', () => {
  it('re-encodes to a bounded PNG', async () => {
    const output = await optimiseBrandingLogo(await createPng(1024, 300));

    const metadata = await sharp(output).metadata();

    expect(metadata.format).toBe('png');
    expect(hasPngMagicBytes(output)).toBe(true);
    expect(metadata.width).toBeLessThanOrEqual(BRANDING_LOGO_OUTPUT_SIZE);
    expect(metadata.height).toBeLessThanOrEqual(BRANDING_LOGO_OUTPUT_SIZE);
  });

  it('strips EXIF metadata from the stored logo', async () => {
    const withExif = await sharp(await createPng(1024, 768))
      .withMetadata({ exif: { IFD0: { Copyright: 'Documenso hardening test', Software: 'branding-logo-test' } } })
      .png()
      .toBuffer();

    // Guard: without this the assertion below would pass on a fixture that
    // never carried EXIF in the first place.
    expect((await sharp(withExif).metadata()).exif).toBeTruthy();

    const output = await optimiseBrandingLogo(withExif);

    expect((await sharp(output).metadata()).exif).toBeUndefined();
  });

  it('rejects input that is not a valid image', async () => {
    await expect(optimiseBrandingLogo(Buffer.from('this is not an image'))).rejects.toThrow();
  });
});
