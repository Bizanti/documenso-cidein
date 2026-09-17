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
});

export type TEnvelopeDownloadPolicy = z.infer<typeof ZEnvelopeDownloadPolicySchema>;

export const ZGetEnvelopeDownloadPoliciesRequestSchema = z.object({
  envelopeIds: z.array(z.string()).min(1).max(50),

  /**
   * Recipient token, when the viewer is a recipient rather than a team member.
   */
  token: z.string().optional(),
});

export type TGetEnvelopeDownloadPoliciesRequest = z.infer<typeof ZGetEnvelopeDownloadPoliciesRequestSchema>;

export const ZGetEnvelopeDownloadPoliciesResponseSchema = z.object({
  data: z.array(ZEnvelopeDownloadPolicySchema),
});

export type TGetEnvelopeDownloadPoliciesResponse = z.infer<typeof ZGetEnvelopeDownloadPoliciesResponseSchema>;
