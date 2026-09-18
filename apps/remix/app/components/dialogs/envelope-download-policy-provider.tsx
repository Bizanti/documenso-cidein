import type { ReactNode } from 'react';

import {
  EnvelopeDownloadPoliciesContext,
  type EnvelopeDownloadPolicyRequest,
  useEnvelopeDownloadPolicies,
} from './envelope-download-policy';

export type EnvelopeDownloadPolicyProviderProps = {
  requests: EnvelopeDownloadPolicyRequest[];
  enabled?: boolean;
  children: ReactNode;
};

/**
 * Resolves the download policies of a whole page of envelopes in a single
 * request and shares them with the download actions rendered inside, so tables
 * don't resolve one policy per row.
 */
export const EnvelopeDownloadPolicyProvider = ({
  requests,
  enabled,
  children,
}: EnvelopeDownloadPolicyProviderProps) => {
  const contextValue = useEnvelopeDownloadPolicies({ requests, enabled });

  return (
    <EnvelopeDownloadPoliciesContext.Provider value={contextValue}>{children}</EnvelopeDownloadPoliciesContext.Provider>
  );
};
