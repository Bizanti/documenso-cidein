import sharp from 'sharp';

import {
  BRANDING_LOGO_MAX_SIZE_BYTES,
  BRANDING_LOGO_MAX_SIZE_MB,
  BRANDING_LOGO_MAX_SOURCE_DIMENSION,
  BRANDING_LOGO_OUTPUT_SIZE,
  BRANDING_LOGO_PNG_MAGIC_BYTES,
} from '../../constants/branding';
import { AppError, AppErrorCode } from '../../errors/app-error';

export const loadLogo = async (file: Uint8Array) => {
  const content = await sharp(file).toFormat('png', { quality: 80 }).toBuffer();

  return {
    contentType: 'image/png',
    content,
  };
};

/**
 * Whether `input` starts with the PNG file signature. The multipart content
 * type is attacker-controlled, so the real format is decided by the bytes: a
 * JPEG, WebP or any other payload renamed to `logo.png` fails here.
 */
export const hasPngMagicBytes = (input: Uint8Array): boolean => {
  if (input.byteLength < BRANDING_LOGO_PNG_MAGIC_BYTES.length) {
    return false;
  }

  return BRANDING_LOGO_PNG_MAGIC_BYTES.every((byte, index) => input[index] === byte);
};

/**
 * Validate the raw bytes of an uploaded branding logo before anything is
 * re-encoded or stored: file size, PNG signature, a decodable image, and a
 * source size within `BRANDING_LOGO_MAX_SOURCE_DIMENSION` on both sides.
 *
 * Throws an `INVALID_BODY` `AppError` with a user-facing message. Call this
 * before `buildBrandingLogoData` / `optimiseBrandingLogo` so an oversized or
 * mislabelled upload is rejected instead of merely downscaled.
 */
export const assertValidBrandingLogoSource = async (input: Buffer | Uint8Array): Promise<void> => {
  if (input.byteLength > BRANDING_LOGO_MAX_SIZE_BYTES) {
    throw new AppError(AppErrorCode.INVALID_BODY, {
      message: `The branding logo cannot be larger than ${BRANDING_LOGO_MAX_SIZE_MB}MB.`,
    });
  }

  if (!hasPngMagicBytes(input)) {
    throw new AppError(AppErrorCode.INVALID_BODY, {
      message: 'The branding logo must be a PNG file.',
    });
  }

  // `metadata()` reads the header only, so an oversized (or decompression-bomb)
  // image is rejected before the pixels are ever decoded.
  const metadata = await sharp(input)
    .metadata()
    .catch(() => null);

  if (!metadata?.width || !metadata.height) {
    throw new AppError(AppErrorCode.INVALID_BODY, {
      message: 'The branding logo must be a valid image file.',
    });
  }

  if (metadata.width > BRANDING_LOGO_MAX_SOURCE_DIMENSION || metadata.height > BRANDING_LOGO_MAX_SOURCE_DIMENSION) {
    throw new AppError(AppErrorCode.INVALID_BODY, {
      message: `The branding logo cannot be larger than ${BRANDING_LOGO_MAX_SOURCE_DIMENSION}x${BRANDING_LOGO_MAX_SOURCE_DIMENSION} pixels.`,
    });
  }
};

/**
 * Validate and sanitise an uploaded branding logo. Re-encoding through `sharp`
 * proves the bytes are a real raster image and strips any embedded payloads.
 * Throws if the input cannot be parsed as an image.
 */
export const optimiseBrandingLogo = async (input: Buffer | Uint8Array): Promise<Buffer> => {
  return await sharp(input)
    .resize(BRANDING_LOGO_OUTPUT_SIZE, BRANDING_LOGO_OUTPUT_SIZE, { fit: 'inside', withoutEnlargement: true })
    .png({ quality: 80 })
    .toBuffer();
};
