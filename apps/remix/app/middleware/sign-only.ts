import { getOptionalSession } from '@documenso/auth/server/lib/utils/get-session';
import { type MiddlewareFunction, redirect } from 'react-router';

import { getSignOnlyRedirectTarget } from '~/utils/sign-only-routes';

export const signOnlyMiddleware: MiddlewareFunction = async ({ request }, next) => {
  const { user } = await getOptionalSession(request);

  const redirectTarget = getSignOnlyRedirectTarget(user, new URL(request.url).pathname);

  if (redirectTarget) {
    throw redirect(redirectTarget);
  }

  return next();
};
