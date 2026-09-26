import { ZFindResultResponse, ZFindSearchParamsSchema } from '@documenso/lib/types/search-params';
import { Role } from '@prisma/client';
import { z } from 'zod';

export const ZFindSignOnlyCandidatesRequestSchema = ZFindSearchParamsSchema.pick({
  query: true,
  page: true,
  perPage: true,
}).extend({
  perPage: z.number().optional().default(20),
});

export const ZSignOnlyCandidateSchema = z.object({
  id: z.number(),
  name: z.string().nullable(),
  email: z.string(),
  roles: z.array(z.nativeEnum(Role)),
  createdAt: z.date(),
  lastSignedIn: z.date(),
  organisationCount: z.number(),
  recipientCount: z.number(),
  signedRecipientCount: z.number(),
});

export const ZFindSignOnlyCandidatesResponseSchema = ZFindResultResponse.extend({
  data: ZSignOnlyCandidateSchema.array(),
});

export type TFindSignOnlyCandidatesRequest = z.infer<typeof ZFindSignOnlyCandidatesRequestSchema>;
export type TFindSignOnlyCandidatesResponse = z.infer<typeof ZFindSignOnlyCandidatesResponseSchema>;
