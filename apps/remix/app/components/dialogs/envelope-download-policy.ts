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

/**
 * The download policies the page resolved, plus what the batch covered.
 *
 * The covered requests are known before the batch resolves, which is what keeps
 * a row from resolving its own policy while the page request is still in flight.
 */
export type EnvelopeDownloadPoliciesContextValue = {
  policies: EnvelopeDownloadPolicies;

  /**
   * Whether the page batch asked for the policy of this envelope and token.
   */
  covers: (envelopeId: string, token?: string) => boolean;

  /**
   * Whether the batch is still resolving.
   */
  isLoading: boolean;
};

const getEnvelopeDownloadPolicyKey = (envelopeId: string, token?: string) => `${envelopeId}|${token ?? ''}`;

/**
 * The page level batch: the policies it resolved plus what it covered, so the
 * rows of a table don't resolve their own while the batch is in flight.
 */
export const EnvelopeDownloadPoliciesContext = createContext<EnvelopeDownloadPoliciesContextValue | null>(null);

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
}): EnvelopeDownloadPoliciesContextValue => {
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

  const isBatchEnabled = enabled && envelopeIds.length > 0;

  const { data, isLoading } = trpc.document.getEnvelopeDownloadPolicies.useQuery(
    {
      envelopeIds,
      ...(tokens.length > 0 ? { tokens } : {}),
    },
    {
      enabled: isBatchEnabled,
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

    const coveredKeys = new Set(requestKeyByEnvelopeId.values());

    return {
      policies,
      // A row only holds its own query back while the batch is actually there to
      // answer it, so a disabled batch leaves the rows resolving themselves.
      covers: (envelopeId: string, token?: string) =>
        isBatchEnabled && coveredKeys.has(getEnvelopeDownloadPolicyKey(envelopeId, token)),
      isLoading: isLoading && !data,
    };
  }, [batchedRequests, data, isBatchEnabled, isLoading]);
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
 * The page level batch resolves this envelope when it covers it, in which case
 * the row waits for it instead of resolving the policy on its own. Only a row the
 * batch did not cover, such as the team variant of an envelope that member is
 * also a recipient of, falls back to resolving the envelope by itself.
 */
export const useEnvelopeDownloadPolicy = ({
  envelopeId,
  token,
  enabled = true,
}: UseEnvelopeDownloadPolicyOptions): UseEnvelopeDownloadPolicyResponse => {
  const batchedPolicies = useContext(EnvelopeDownloadPoliciesContext);

  const isCoveredByBatch = batchedPolicies?.covers(envelopeId, token) ?? false;

  const batchedPolicy = isCoveredByBatch
    ? batchedPolicies?.policies.get(getEnvelopeDownloadPolicyKey(envelopeId, token))
    : undefined;

  const { data, isLoading } = trpc.document.getEnvelopeDownloadPolicies.useQuery(
    {
      envelopeIds: [envelopeId],
      token,
    },
    {
      // Held back while the batch covers this row, so a page never resolves one
      // policy per row on top of its own request.
      enabled: enabled && !isCoveredByBatch,
    },
  );

  return {
    downloadPolicy: batchedPolicy ?? data?.data[0],
    isLoadingDownloadPolicy: isCoveredByBatch ? (batchedPolicies?.isLoading ?? false) : isLoading && !data,
  };
};
