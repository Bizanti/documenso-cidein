import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { E2E_PAUSE_COMPLETION_EMAIL_ENV_VAR, waitForE2ECompletionEmailPause } from './e2e-completion-email-pause';

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  queryRaw: vi.fn(),
}));

vi.mock('@documenso/prisma', () => ({
  prisma: {
    $transaction: mocks.transaction,
  },
}));

// Must match the envelope id format the job resolves its query with.
const ENVELOPE_ID = 'envelope_1a2b3c';

type TransactionOptions = {
  maxWait: number;
  timeout: number;
};

// The options the wait asked Prisma for.
let transactionOptions: TransactionOptions;

beforeEach(() => {
  vi.resetAllMocks();

  mocks.queryRaw.mockResolvedValue([{ paused: 1 }]);
  mocks.transaction.mockImplementation(
    async (callback: (tx: unknown) => Promise<unknown>, options: TransactionOptions) => {
      transactionOptions = options;

      return await callback({ $queryRaw: mocks.queryRaw });
    },
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('completion email e2e pause', () => {
  it('leaves the job alone when the e2e variable is unset', async () => {
    vi.stubEnv(E2E_PAUSE_COMPLETION_EMAIL_ENV_VAR, '');

    await waitForE2ECompletionEmailPause(ENVELOPE_ID);

    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.queryRaw).not.toHaveBeenCalled();
  });

  it('waits on the lock of its own envelope when the e2e variable asks for it', async () => {
    vi.stubEnv(E2E_PAUSE_COMPLETION_EMAIL_ENV_VAR, 'true');

    await waitForE2ECompletionEmailPause(ENVELOPE_ID);

    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.queryRaw).toHaveBeenCalledTimes(1);

    // The lock is only waited on, never taken for the duration: the transaction
    // ends - and releases it - as soon as the scenario releases the session lock
    // it holds, which is what the send has to observe.
    const [queryParts, envelopeIdParam] = mocks.queryRaw.mock.calls[0] as [string[], string];

    expect(queryParts.join('$envelopeId')).toContain('pg_advisory_xact_lock(hashtext($envelopeId)::bigint)');
    expect(envelopeIdParam).toBe(ENVELOPE_ID);

    // The wait has to outlive the client's own transaction defaults (10s): the
    // scenario holds the pause while it signs and restricts the account, and a
    // transaction which timed out mid wait would fail the job instead of pausing
    // it.
    expect(transactionOptions.timeout).toBeGreaterThan(10_000);
    expect(transactionOptions.maxWait).toBeGreaterThan(10_000);
  });
});
