/**
 * Process-wide bound for job normalization/persistence.
 *
 * ATS persistence and ordinary ingestion converge on the parent's bounded
 * five-connection data pool. Four concurrent jobs use the intended write
 * width while retaining one data connection for application traffic; control
 * leases and heartbeats use their own bounded client.
 */
export const INGESTION_JOB_CONCURRENCY = Math.max(
  1,
  Number.parseInt(process.env.INGESTION_JOB_CONCURRENCY || '4', 10),
);

/**
 * Interactive Prisma transactions hold a pool connection for their lifetime.
 * Two transactions leave the majority of the data pool available to the
 * supervised pipeline loops and ordinary application traffic.
 */
export const INGESTION_TRANSACTION_CONCURRENCY = Math.max(
  1,
  Number.parseInt(process.env.INGESTION_TRANSACTION_CONCURRENCY || '2', 10),
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
