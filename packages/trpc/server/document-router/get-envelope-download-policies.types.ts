import { z } from 'zod';

export const ZEnvelopeDownloadPolicySchema = z.object({
  envelopeId: z.string(),

  /**
   * The window applied to this envelope, in hours. `null` means downloads do not expire.
   */
  downloadWindowHours: z.number().int().nullable(),
  downloadWindowExpiresAt: z.date().nullable(),
  isDownloadWindowExpired: z.boolean(),
  canDownloadSigned: z.boolean(),
  canDownloadOriginal: z.boolean(),

  /**
   * Why the downloads are closed, when they are: an expired window, a version
   * which is restricted, or a restricted account. `null` when both versions are
   * downloadable.
   */
  downloadDenialReason: z.string().nullable(),
});

export type TEnvelopeDownloadPolicy = z.infer<typeof ZEnvelopeDownloadPolicySchema>;

export const ZGetEnvelopeDownloadPoliciesRequestSchema = z.object({
  envelopeIds: z.array(z.string()).min(1).max(50),

  /**
   * Recipient token, when the viewer is a recipient rather than a team member.
   */
  token: z.string().optional(),

  /**
   * The recipient tokens of the viewer for every envelope in a single request.
   *
   * Lets a table resolve all the rows it renders at once: each envelope reached
   * through one of these tokens is resolved with recipient-level permissions,
   * while the rest fall back to the team role of the session.
   */
  tokens: z.array(z.string()).max(50).optional(),
});

export type TGetEnvelopeDownloadPoliciesRequest = z.infer<typeof ZGetEnvelopeDownloadPoliciesRequestSchema>;

export const ZGetEnvelopeDownloadPoliciesResponseSchema = z.object({
  data: z.array(ZEnvelopeDownloadPolicySchema),
});

export type TGetEnvelopeDownloadPoliciesResponse = z.infer<typeof ZGetEnvelopeDownloadPoliciesResponseSchema>;
