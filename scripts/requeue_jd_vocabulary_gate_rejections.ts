import 'dotenv/config';

import { prisma } from '../src/lib/prisma';
import { describeJdFailureCause, planJdRecoveryReconciliation } from '../src/lib/jdRecoveryPolicy';

/**
 * Backfill for the vocabulary-gate fix in src/lib/jobDescriptionQuality.ts
 * (docs/prompts/jd-quality-gate-false-negatives.md). These rows were fetched
 * successfully — the JD recovery text cleared 650 characters — and were
 * rejected purely because they didn't match the duties/qualifications
 * keyword list. Re-running the corrected gate needs no network calls: it
 * reads the description already stored on the row.
 *
 * Only rows still active (pending_af/inbox) are requeued; a row that already
 * moved on to some other disposition is reported, not touched. scoreAttempts,
 * scoreError, and passReason reset the way a fresh JD recovery success does
 * elsewhere. aimFitScore/reqFitScore are never written — those never got set
 * for a row that failed the gate before reaching Aim, and touching them here
 * would pull unrelated rows into a manual review batch.
 *
 * Dry run by default; pass --apply to write.
 */

const ACTIVE_STATUSES = ['pending_af', 'inbox'];
const VOCAB_REJECTION_WHERE = {
  OR: [
    { scoreError: { contains: 'no usable role duties' } },
    { scoreError: { contains: 'no usable qualifications' } },
  ],
};

function parseArguments(argv: string[]): { apply: boolean } {
  for (const argument of argv) {
    if (argument !== '--apply') throw new Error('Usage: requeue_jd_vocabulary_gate_rejections.ts [--apply]');
  }
  return { apply: argv.includes('--apply') };
}

async function main(): Promise<void> {
  const { apply } = parseArguments(process.argv.slice(2));
  console.log(`${apply ? 'APPLY' : 'DRY RUN'} — reading rows rejected for vocabulary...`);

  const candidates = await prisma.job.findMany({
    where: VOCAB_REJECTION_WHERE,
    select: {
      id: true, status: true, source: true, description: true, scoreError: true, scoringStatus: true,
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });

  console.log(`  rows previously rejected for vocabulary: ${candidates.length.toLocaleString()}`);

  const planned = candidates.map((job) => ({ job, plan: planJdRecoveryReconciliation(job) }));
  const nowScorable = planned.filter(({ plan }) => plan.action === 'queue_local');
  const stillRejected = planned.filter(({ plan }) => plan.action !== 'queue_local');

  console.log(`\n  now scorable under the corrected gate: ${nowScorable.length.toLocaleString()}`);
  console.log(`  still rejected: ${stillRejected.length.toLocaleString()}`);

  const reasonCounts = new Map<string, number>();
  for (const { job, plan } of stillRejected) {
    const key = describeJdFailureCause(job.description, plan.quality);
    reasonCounts.set(key, (reasonCounts.get(key) || 0) + 1);
  }
  for (const [reason, count] of [...reasonCounts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    console.log(`    ${count} ${reason}`);
  }

  const eligible = nowScorable.filter(({ job }) => ACTIVE_STATUSES.includes(job.status));
  const alreadyMovedOn = nowScorable.filter(({ job }) => !ACTIVE_STATUSES.includes(job.status));

  console.log(`\n  of the now-scorable rows:`);
  console.log(`    ${eligible.length.toLocaleString()} are still active (pending_af/inbox) and will be requeued for local scoring`);
  console.log(`    ${alreadyMovedOn.length.toLocaleString()} already moved on to another status and are left alone`);
  if (alreadyMovedOn.length) {
    const byStatus = new Map<string, number>();
    for (const { job } of alreadyMovedOn) byStatus.set(job.status, (byStatus.get(job.status) || 0) + 1);
    for (const [status, count] of [...byStatus].sort((a, b) => b[1] - a[1])) {
      console.log(`      ${count} ${status}`);
    }
  }

  if (!apply) {
    console.log('\naimFitScore/reqFitScore are never touched by this script.');
    console.log('Dry run. Re-run with --apply to requeue the active rows above.');
    return;
  }

  let requeued = 0;
  for (const { job } of eligible) {
    // Re-check status and scoreError so a row already reprocessed by the live
    // pipeline since the read above is left alone rather than clobbered.
    const result = await prisma.job.updateMany({
      where: {
        id: job.id,
        status: { in: ACTIVE_STATUSES },
        scoreError: job.scoreError,
      },
      data: {
        scoringStatus: 'queued',
        scoreAttempts: 0,
        scoreError: null,
        passReason: null,
        jdBatchId: null,
        batchJobId: null,
      },
    });
    requeued += result.count;
  }
  console.log(`\nRequeued ${requeued.toLocaleString()} row(s) for local scoring.`);
}

main()
  .catch((error: unknown) => {
    console.error(`JD vocabulary-gate backfill failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
