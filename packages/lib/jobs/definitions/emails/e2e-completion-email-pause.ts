import { prisma } from '@documenso/prisma';

/**
 * The variable which holds the completion email job on a Postgres advisory lock.
 *
 * Exclusively for the e2e suite: `packages/app-tests` exports it for the app it
 * starts (`test:e2e` and `test:e2e:shard` in its package.json) and the SIGN_ONLY
 * scenario E5b is the only taker of the lock. With the variable unset - every
 * environment but the e2e one - the job is untouched.
 */
export const E2E_PAUSE_COMPLETION_EMAIL_ENV_VAR = 'E2E_PAUSE_COMPLETION_EMAIL';

/**
 * How long the job may wait for the scenario to release it before giving up and
 * failing (the job is then retried under its own policy). Long enough for the
 * scenario to seal the document and restrict the account, short enough not to
 * hang a run whose lock was leaked.
 */
const E2E_PAUSE_COMPLETION_EMAIL_TIMEOUT_MS = 120_000;

/**
 * Wait until the e2e scenario of this envelope releases the advisory lock it
 * took on the same key, and return immediately when the e2e variable is unset.
 *
 * The key is `hashtext(<envelope id>)`, so the pause is derived from the
 * document and nothing global is ever locked. The scenario computes the same
 * expression from the same id in
 * `packages/app-tests/e2e/sign-only/sign-only-downloads.spec.ts`: the two sides
 * have to change together.
 *
 * The wait runs inside an interactive transaction, which the scenario's session
 * lock blocks until it releases it. Prisma pins the transaction to one
 * connection and Postgres releases its `pg_advisory_xact_lock` when the
 * transaction ends - commit, rollback or timeout - so the lock can never be
 * left behind on a pooled connection, not even when the handler throws.
 */
export const waitForE2ECompletionEmailPause = async (envelopeId: string) => {
  if (process.env[E2E_PAUSE_COMPLETION_EMAIL_ENV_VAR] !== 'true') {
    return;
  }

  await prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT 1 AS paused FROM (SELECT pg_advisory_xact_lock(hashtext(${envelopeId})::bigint)) AS pause`;
    },
    {
      maxWait: E2E_PAUSE_COMPLETION_EMAIL_TIMEOUT_MS,
      timeout: E2E_PAUSE_COMPLETION_EMAIL_TIMEOUT_MS,
    },
  );
};
