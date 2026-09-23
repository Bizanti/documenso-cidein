/**
 * Maximum length (in characters) of the user-supplied custom CSS for branding.
 * Single source of truth for the limit: enforced at the TRPC request boundary on
 * both the organisation and team settings update routes, and re-used by the
 * branding preferences form so the client can never build a payload the server
 * would reject. The sanitiser is run after this check; this limit is purely a
 * request-size guard.
 *
 * 256 KB — generous enough for hand-written branding CSS and the occasional
 * compiled-from-Tailwind-or-similar paste, while still keeping a request
 * cap so a malicious or runaway payload can't exhaust PostCSS/server memory.
 */
export const BRANDING_CSS_MAX_LENGTH = 256 * 1024;

/**
 * Branding logo upload constraints. Enforced server-side at the TRPC request
 * boundary (`zfdBrandingImageFile`) and reused by the client form for matching UX.
 */
export const BRANDING_LOGO_MAX_SIZE_MB = 1;

export const BRANDING_LOGO_MAX_SIZE_BYTES = BRANDING_LOGO_MAX_SIZE_MB * 1024 * 1024;

/**
 * Only PNG uploads are accepted. The declared multipart content type is
 * attacker-controlled, so it is never trusted on its own — `sharp` re-encodes
 * (and therefore proves) the actual format and `assertValidBrandingLogoSource`
 * additionally checks the PNG signature in the raw bytes. SVG is deliberately
 * not supported.
 */
export const BRANDING_LOGO_ALLOWED_TYPES: string[] = ['image/png'];

/** The PNG file signature: `89 50 4E 47 0D 0A 1A 0A`. */
export const BRANDING_LOGO_PNG_MAGIC_BYTES: readonly number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Largest accepted source size, in pixels, for either side of an uploaded
 * branding logo. A bigger file is rejected instead of being silently
 * downscaled: the presentation size is decided by the UI template, and an
 * oversized upload is a mistake or an attempt to burn server resources.
 */
export const BRANDING_LOGO_MAX_SOURCE_DIMENSION = 1024;

/**
 * Largest side, in pixels, of the logo that actually gets stored. Everything
 * within `BRANDING_LOGO_MAX_SOURCE_DIMENSION` is re-encoded down to this so the
 * stored asset stays small and predictable.
 */
export const BRANDING_LOGO_OUTPUT_SIZE = 512;
