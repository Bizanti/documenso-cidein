import { formatPath } from '@documenso/lib/constants/app';
import { sha256 } from '@documenso/lib/universal/crypto';
import { getFileServerSide } from '@documenso/lib/universal/upload/get-file.server';
import { loadLogo } from '@documenso/lib/utils/images/logo';
import { prisma } from '@documenso/prisma';
import sharp from 'sharp';

import type { Route } from './+types/branding.favicon.organisation.$orgId.$size';

const CACHE_CONTROL = 'public, max-age=0, stale-while-revalidate=86400';

/** Icon sizes served by this route. */
type FaviconSize = 16 | 32 | 180;

/**
 * Neutral Documenso icon for each served size, used whenever no verified
 * organisation branding context can be resolved.
 *
 * The neutral assets live in `apps/remix/public`, which is exempt from both
 * `appMiddleware` and `securityHeadersMiddleware`
 * (apps/remix/server/middleware.ts, apps/remix/server/security-headers.ts).
 * This route sits under `/api/`, which carries the same exemption, so the
 * fallback never crosses into a path that would need CSP handling.
 */
const NEUTRAL_FAVICON_PATHS: Record<FaviconSize, string> = {
  16: '/favicon-16x16.png',
  32: '/favicon-32x32.png',
  180: '/apple-touch-icon.png',
};

const isFaviconSize = (value: number): value is FaviconSize => value === 16 || value === 32 || value === 180;

/**
 * Neutral fallback for requests that cannot be resolved to an organisation
 * with branding enabled and a validated logo stored.
 *
 * Redirecting to the static icon (instead of 404ing) keeps every surface that
 * links this route — including third-party pages and PWA icon fetches — on the
 * neutral Documenso brand rather than a broken icon.
 */
const neutralFaviconResponse = (request: Request, size: FaviconSize) => {
  const location = new URL(formatPath(NEUTRAL_FAVICON_PATHS[size]), new URL(request.url).origin);

  return new Response(null, {
    status: 302,
    headers: {
      Location: location.toString(),
      'Cache-Control': CACHE_CONTROL,
    },
  });
};

export async function loader({ params, request }: Route.LoaderArgs) {
  const size = Number(params.size);

  if (!params.orgId || !isFaviconSize(size)) {
    return Response.json(
      {
        status: 'error',
        message: 'Invalid favicon size',
      },
      { status: 400 },
    );
  }

  const organisation = await prisma.organisation.findUnique({
    where: {
      id: params.orgId,
    },
    select: {
      organisationGlobalSettings: {
        select: {
          brandingEnabled: true,
          brandingLogo: true,
        },
      },
    },
  });

  const settings = organisation?.organisationGlobalSettings;

  // Branding disabled or no logo stored: the organisation has no tenant icon.
  if (!settings?.brandingEnabled || !settings.brandingLogo) {
    return neutralFaviconResponse(request, size);
  }

  const etag = `"${Buffer.from(sha256(`${size}:${settings.brandingLogo}`)).toString('hex')}"`;

  if (request.headers.get('If-None-Match') === etag) {
    return new Response(null, {
      status: 304,
      headers: {
        ETag: etag,
        'Cache-Control': CACHE_CONTROL,
      },
    });
  }

  const file = await getFileServerSide(JSON.parse(settings.brandingLogo)).catch((e) => {
    console.error(e);
  });

  if (!file) {
    return neutralFaviconResponse(request, size);
  }

  // `loadLogo` re-encodes through sharp, which also proves the stored bytes are
  // a real raster image before they are scaled down to icon size.
  const { content } = await loadLogo(file);

  const favicon = await sharp(content)
    .resize(size, size, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer()
    .catch((e) => {
      console.error(e);

      return null;
    });

  if (!favicon) {
    return neutralFaviconResponse(request, size);
  }

  return new Response(favicon, {
    headers: {
      'Content-Type': 'image/png',
      'Content-Length': favicon.length.toString(),
      'Cache-Control': CACHE_CONTROL,
      ETag: etag,
    },
  });
}
