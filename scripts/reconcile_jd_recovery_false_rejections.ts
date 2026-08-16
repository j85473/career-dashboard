import 'dotenv/config';

import { PrismaClient } from '@prisma/client';

import {
  buildClosedPostingUpdate,
  JD_RECOVERY_MANUAL_REVIEW_REASON,
  planJdRecoveryReconciliation,
} from '../src/lib/jdRecoveryPolicy';

/**
 * Reconciles only active jobs terminally parked by JD recovery. Dry run by
 * default; pass --apply to write. Usable stored JDs return to local scoring,
 * closed postings are dismissed, and the rest get one fresh bounded recovery
 * series. This never sweeps arbitrary failed/skipped rows or revives a human
 * lifecycle decision.
 */

const prisma = new PrismaClient();
const ACTIVE_STATUSES = ['pending_af', 'inbox'];
const JD_FAILURE_REASONS = [
  JD_RECOVERY_MANUAL_REVIEW_REASON,
  'JD recovery failed. Manual review required.',
  'Failed to fetch JD after 3 attempts. Needs manual review.',
  'Error calling Jina. Manual review required.',
];

const jdFailureWhere = {
  scoringStatus: 'failed' as const,
  OR: [
    { scoreError: { startsWith: 'JD recovery rejected:' } },
    { passReason: { in: JD_FAILURE_REASONS } },
  ],
};

function parseArguments(argv: string[]): { apply: boolean; ids: string[] } {
  let apply = false;
  const ids: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--apply') {
      apply = true;
    } else if (argument === '--id') {
      const id = argv[index + 1] || '';
      if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error(`Not a job id: ${id}`);
      ids.push(id);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return { apply, ids };
}

async function main(): Promise<void> {
  const { apply, ids } = parseArguments(process.argv.slice(2));
  const candidates = await prisma.job.findMany({
    where: {
      status: { in: ACTIVE_STATUSES },
      ...jdFailureWhere,
      ...(ids.length ? { id: { in: ids } } : {}),
    },
    select: {
      id: true,
      company: true,
      title: true,
      source: true,
      description: true,
      scoreError: true,
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });

  const planned = candidates.map((job) => ({
    job,
    plan: planJdRecoveryReconciliation(job),
  }));
  const queueLocalIds = planned
    .filter(({ plan }) => plan.action === 'queue_local')
    .map(({ job }) => job.id);
  const retryExtractionIds = planned
    .filter(({ plan }) => plan.action === 'retry_extraction')
    .map(({ job }) => job.id);
  const dismissClosedIds = planned
    .filter(({ plan }) => plan.action === 'dismiss_closed')
    .map(({ job }) => job.id);

  console.log(`Examined ${candidates.length} active terminal JD rejection(s).`);
  console.log(`  ${queueLocalIds.length} -> local scoring`);
  console.log(`  ${retryExtractionIds.length} -> fresh bounded JD recovery`);
  console.log(`  ${dismissClosedIds.length} -> dismissed as closed postings`);

  const reasonCounts = new Map<string, number>();
  for (const { plan } of planned) {
    const key = `${plan.action}: ${plan.quality.reason || 'ready'}`;
    reasonCounts.set(key, (reasonCounts.get(key) || 0) + 1);
  }
  for (const [reason, count] of [...reasonCounts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    console.log(`  ${count} ${reason}`);
  }

  if (!apply) {
    console.log('\nDry run. Re-run with --apply to perform only the transitions above.');
    return;
  }

  const guardedWhere = (jobIds: string[]) => ({
    id: { in: jobIds },
    status: { in: ACTIVE_STATUSES },
    ...jdFailureWhere,
  });

  const [queued, retried, dismissed] = await prisma.$transaction([
    prisma.job.updateMany({
      where: guardedWhere(queueLocalIds),
      data: {
        scoringStatus: 'queued',
        scoreAttempts: 0,
        scoreError: null,
        passReason: null,
        jdBatchId: null,
        batchJobId: null,
      },
    }),
    prisma.job.updateMany({
      where: guardedWhere(retryExtractionIds),
      data: {
        scoringStatus: 'needs_jd',
        scoreAttempts: 0,
        scoreError: null,
        passReason: null,
        jdBatchId: null,
        batchJobId: null,
      },
    }),
    prisma.job.updateMany({
      where: guardedWhere(dismissClosedIds),
      data: buildClosedPostingUpdate(),
    }),
  ]);

  console.log(`\nApplied: ${queued.count} queued for local scoring; ${retried.count} queued for JD recovery; ${dismissed.count} dismissed as closed.`);
}

main()
  .catch((error: unknown) => {
    console.error(`JD reconciliation failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
