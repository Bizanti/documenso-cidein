import { trpc } from '@documenso/trpc/react';
import type { TEnvelopeDownloadPolicy } from '@documenso/trpc/server/document-router/get-envelope-download-policies.types';

type UseEnvelopeDownloadPolicyOptions = {
  envelopeId: string;

  /**
   * Recipient token, when the viewer is a recipient rather than a team member.
   */
  token?: string;
  enabled?: boolean;
};

type UseEnvelopeDownloadPolicyResponse = {
  downloadPolicy?: TEnvelopeDownloadPolicy;
  isLoadingDownloadPolicy: boolean;
};

/**
 * Resolves what the current viewer may download for an envelope, so download
 * actions can render a locked state instead of failing with a raw 403.
 */
export const useEnvelopeDownloadPolicy = ({
  envelopeId,
  token,
  enabled = true,
}: UseEnvelopeDownloadPolicyOptions): UseEnvelopeDownloadPolicyResponse => {
  const { data, isLoading } = trpc.document.getEnvelopeDownloadPolicies.useQuery(
    {
      envelopeIds: [envelopeId],
      token,
    },
    {
      enabled,
    },
  );

  return {
    downloadPolicy: data?.data[0],
    isLoadingDownloadPolicy: isLoading && !data,
  };
};
