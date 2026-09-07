import type { Prisma, PrismaClient } from '@prisma/client';

/**
 * How many searches a paid source may run in one UTC day.
 *
 * Search and description calls spend one ledger. A search is speculative; a
 * description call serves a job that already survived local filtering. So the
 * ledger has to be sized for the descriptions the searches will generate, and
 * on 2026-09-07 Glassdoor's was not: the discovery expansion took it from 3-4
 * runs a day to 37, and total demand — 20 searches, 48 ingest-time description
 * calls, and 74 recovery-pass calls — exceeded the whole 103/day ceiling. Not
 * an hourly release: the entire day's allowance. The hourly enrichment reserve
 * cannot fix a shortage that large; only intake or the quota can.
 *
 * Glassdoor's cap restores its pre-expansion rate. It discards nothing: of the
 * 334 rows it ingested that day, 260 were filtered out before anything was
 * spent on them, and only 12 of the week's 578 rows were ever scored.
 */
export const PAID_SEARCH_DAILY_RUN_CAPS: Readonly<Record<string, number>> = Object.freeze({
  'Glassdoor (RapidAPI)': 4,
});

/**
 * Runs that reached the provider. A run refused by the budget or an open
 * circuit spent nothing, so it must not count against the cap — otherwise a
 * quiet day of refusals would lock the source out of the next one.
 */
export const RUN_STATUSES_THAT_SPENT_BUDGET = ['success', 'partial'] as const;

export function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export type PaidSearchRunRateDecision = {
  allowed: boolean;
  cap: number | null;
  runsToday: number;
};

export async function paidSearchRunRateDecision(
  source: string,
  client: Pick<PrismaClient, 'ingestionSourceRun'>,
  now: Date = new Date(),
): Promise<PaidSearchRunRateDecision> {
  const cap = PAID_SEARCH_DAILY_RUN_CAPS[source];
  if (cap == null) return { allowed: true, cap: null, runsToday: 0 };
  const where: Prisma.IngestionSourceRunWhereInput = {
    source,
    startedAt: { gte: utcDayStart(now) },
    status: { in: [...RUN_STATUSES_THAT_SPENT_BUDGET] },
  };
  const runsToday = await client.ingestionSourceRun.count({ where });
  return { allowed: runsToday < cap, cap, runsToday };
}
