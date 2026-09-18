import { findRecipientByEmail } from '@documenso/lib/utils/recipients';
import { trpc } from '@documenso/trpc/react';
import type { TEnvelopeDownloadPolicy } from '@documenso/trpc/server/document-router/get-envelope-download-policies.types';
import { createContext, useContext, useMemo } from 'react';

/**
 * The maximum number of envelopes a single batch request accepts, mirroring
 * `ZGetEnvelopeDownloadPoliciesRequestSchema`.
 */
const MAX_BATCH_ENVELOPES = 50;

export type EnvelopeDownloadPolicyRequest = {
  envelopeId: string;

  /**
   * The recipient token of the current viewer for this envelope, when they are
   * also a recipient of it.
   */
  token?: string;
};

export type EnvelopeDownloadPolicies = Map<string, TEnvelopeDownloadPolicy>;

const getEnvelopeDownloadPolicyKey = (envelopeId: string, token?: string) => `${envelopeId}|${token ?? ''}`;

/**
 * The download policies already resolved by the page, so each row of a table
 * does not have to resolve its own.
 */
export const EnvelopeDownloadPoliciesContext = createContext<EnvelopeDownloadPolicies | null>(null);

/**
 * Builds the batch requests for a page of envelopes, using the same recipient
 * lookup the download actions use so the batch resolves the permissions each row
 * would resolve on its own.
 */
export const getEnvelopeDownloadPolicyRequests = ({
  envelopes,
  userEmail,
  teamEmail,
}: {
  envelopes: { envelopeId: string; recipients: { email: string; token: string }[] }[];
  userEmail: string;
  teamEmail?: string | null;
}): EnvelopeDownloadPolicyRequest[] =>
  envelopes.map((envelope) => ({
    envelopeId: envelope.envelopeId,
    token: findRecipientByEmail({ recipients: envelope.recipients, userEmail, teamEmail })?.token,
  }));

/**
 * Resolves the download policy of a whole page of envelopes in a single request.
 *
 * Envelopes the viewer reaches through one of the sent tokens are resolved with
 * recipient permissions, the rest with the role of their session, which matches
 * what each row would have requested on its own.
 */
export const useEnvelopeDownloadPolicies = ({
  requests,
  enabled = true,
}: {
  requests: EnvelopeDownloadPolicyRequest[];
  enabled?: boolean;
}): EnvelopeDownloadPolicies => {
  const batchedRequests = useMemo(() => {
    const uniqueRequests = new Map<string, EnvelopeDownloadPolicyRequest>();

    for (const request of requests) {
      const key = getEnvelopeDownloadPolicyKey(request.envelopeId, request.token);

      if (!uniqueRequests.has(key) && uniqueRequests.size < MAX_BATCH_ENVELOPES) {
        uniqueRequests.set(key, request);
      }
    }

    return Array.from(uniqueRequests.values());
  }, [requests]);

  const envelopeIds = batchedRequests.map((request) => request.envelopeId);

  const tokens = Array.from(
    new Set(batchedRequests.map((request) => request.token).filter((token): token is string => token !== undefined)),
  );

  const { data } = trpc.document.getEnvelopeDownloadPolicies.useQuery(
    {
      envelopeIds,
      ...(tokens.length > 0 ? { tokens } : {}),
    },
    {
      enabled: enabled && envelopeIds.length > 0,
    },
  );

  return useMemo(() => {
    // The request the batch sent for each envelope is the one the response
    // resolves, so its key is what the matching row will look up.
    const requestKeyByEnvelopeId = new Map(
      batchedRequests.map((request) => [
        request.envelopeId,
        getEnvelopeDownloadPolicyKey(request.envelopeId, request.token),
      ]),
    );

    const policies: EnvelopeDownloadPolicies = new Map();

    data?.data.forEach((policy) => {
      const requestKey = requestKeyByEnvelopeId.get(policy.envelopeId);

      if (requestKey) {
        policies.set(requestKey, policy);
      }
    });

    return policies;
  }, [batchedRequests, data]);
};

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
 *
 * Reads the page level batch when it covers this envelope, and falls back to
 * resolving the envelope on its own when the page is not batched, or when it
 * resolved a different variant of the same envelope, such as a team member who
 * is also a recipient of the document.
 */
export const useEnvelopeDownloadPolicy = ({
  envelopeId,
  token,
  enabled = true,
}: UseEnvelopeDownloadPolicyOptions): UseEnvelopeDownloadPolicyResponse => {
  const batchedPolicies = useContext(EnvelopeDownloadPoliciesContext);

  const batchedPolicy = batchedPolicies?.get(getEnvelopeDownloadPolicyKey(envelopeId, token));

  const { data, isLoading } = trpc.document.getEnvelopeDownloadPolicies.useQuery(
    {
      envelopeIds: [envelopeId],
      token,
    },
    {
      enabled: enabled && !batchedPolicy,
    },
  );

  return {
    downloadPolicy: batchedPolicy ?? data?.data[0],
    isLoadingDownloadPolicy: !batchedPolicy && isLoading && !data,
  };
};
