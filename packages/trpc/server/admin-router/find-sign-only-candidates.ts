import { findSignOnlyCandidates } from '@documenso/lib/server-only/audit/find-sign-only-candidates';

import { adminProcedure } from '../trpc';
import {
  ZFindSignOnlyCandidatesRequestSchema,
  ZFindSignOnlyCandidatesResponseSchema,
} from './find-sign-only-candidates.types';

export const findSignOnlyCandidatesRoute = adminProcedure
  .input(ZFindSignOnlyCandidatesRequestSchema)
  .output(ZFindSignOnlyCandidatesResponseSchema)
  .query(async ({ input }) => {
    const { query, page, perPage } = input;

    return await findSignOnlyCandidates({ query, page, perPage });
  });
