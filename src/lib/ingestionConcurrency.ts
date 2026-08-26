/**
 * Process-wide bound for job normalization/persistence.
 *
 * ATS platform turns run independently, but every turn eventually converges
 * on the same Prisma pool. This limiter preserves the network parallelism
 * needed for the daily board target while preventing ATS plus the ordinary
 * ingestion loop from growing database work without a ceiling.
 */
export const INGESTION_JOB_CONCURRENCY = Math.max(
  1,
  Number.parseInt(process.env.INGESTION_JOB_CONCURRENCY || '60', 10),
);

/**
 * Interactive Prisma transactions hold a pool connection for their lifetime.
 * Keep this substantially below the job/network ceiling so scoring and lease
 * maintenance can always start their own transactions while ATS is busy.
 */
export const INGESTION_TRANSACTION_CONCURRENCY = Math.max(
  1,
  Number.parseInt(process.env.INGESTION_TRANSACTION_CONCURRENCY || '8', 10),
);

export function createConcurrencyLimiter(limit: number) {
  const maximum = Math.max(1, Math.floor(limit));
  let active = 0;
  const waiters: Array<() => void> = [];

  const acquire = async () => {
    if (active < maximum) {
      active++;
      return;
    }
    await new Promise<void>((resolve) => waiters.push(resolve));
  };

  const release = () => {
    const next = waiters.shift();
    if (next) next();
    else active--;
  };

  return async function withConcurrencySlot<T>(action: () => Promise<T>): Promise<T> {
    await acquire();
    try {
      return await action();
    } finally {
      release();
    }
  };
}

export const withIngestionJobSlot = createConcurrencyLimiter(INGESTION_JOB_CONCURRENCY);
export const withIngestionTransactionSlot = createConcurrencyLimiter(INGESTION_TRANSACTION_CONCURRENCY);
