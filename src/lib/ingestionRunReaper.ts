import { prisma } from './prisma';

/**
 * Closes out `IngestionSourceRun` rows that were left mid-flight.
 *
 * A run row is opened when a source starts and updated when it finishes, so a
 * process that dies in between — a deploy, a crash, an OOM — leaves it
 * `running` forever. Nothing ever reaped them: the stale-lease cleanup covers
 * `Job` leases only. Production held rows stuck since 12 August, which quietly
 * corrupts every per-source success rate computed from this table.
 *
 * The cutoff must sit above the longest legitimate run. The scraper backstop is
 * the ceiling there, so two hours is comfortably clear of it.
 */
export const ABANDONED_RUN_CUTOFF_MS = Number.parseInt(
  process.env.ABANDONED_RUN_CUTOFF_MS || String(2 * 60 * 60 * 1000),
  10,
);

export const ABANDONED_RUN_ERROR =
  'Run abandoned: the owning process exited before it could record an outcome.';

export function abandonedRunCutoff(now: Date = new Date(), cutoffMs = ABANDONED_RUN_CUTOFF_MS): Date {
  return new Date(now.getTime() - cutoffMs);
}

export async function reapAbandonedIngestionRuns(
  now: Date = new Date(),
  client: Pick<typeof prisma, 'ingestionSourceRun'> = prisma,
): Promise<number> {
  const cutoff = abandonedRunCutoff(now);
  try {
    const result = await client.ingestionSourceRun.updateMany({
      where: { status: 'running', startedAt: { lt: cutoff } },
      data: {
        status: 'failed',
        error: ABANDONED_RUN_ERROR,
        finishedAt: now,
      },
    });
    return result.count;
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    // A pre-migration database must not stop the cleanup loop.
    if (code === 'P2021' || code === 'P2022') return 0;
    throw error;
  }
}
