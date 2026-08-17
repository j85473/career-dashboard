import 'dotenv/config';

import { PrismaClient } from '@prisma/client';

import {
  evaluateAuthoritativeMetadata,
  hasAuthoritativeMetadata,
} from '../src/lib/authoritativeMetadataGate';

/**
 * Applies lane one of local scoring retroactively to the Action Needed queue.
 *
 * `jobScoring` now runs the free metadata checks — title category and geography
 * — before JD recovery for sources that state their own facts. That only helps
 * postings scored from then on, and dedupe means the board sweep never revisits
 * the ones already stuck, so they would sit in Action Needed forever asking a
 * human to repair the description of a London internship.
 *
 * This rejects nothing the pipeline would not now reject itself: the verdict
 * comes from `authoritativeMetadataGate`, the same module `jobScoring` calls.
 * Aggregator rows are excluded by that module for the reason lane two exists —
 * their location is a guess until the description resolves.
 *
 * Deliberately does no fetching. Every decision here is made from metadata
 * already in the row, which is what makes it safe to run against a queue of
 * postings whose pages have since 404'd.
 *
 * Dry run by default; `--apply` writes.
 */

const prisma = new PrismaClient();
const ACTIVE_STATUSES = ['pending_af', 'inbox'];
const SAMPLE_LIMIT = 15;

function parseArguments(argv: string[]): { apply: boolean } {
  for (const argument of argv) {
    if (argument !== '--apply') throw new Error('Usage: triage_stuck_ats_jobs.ts [--apply]');
  }
  return { apply: argv.includes('--apply') };
}

async function main(): Promise<void> {
  const { apply } = parseArguments(process.argv.slice(2));

  const stuck = await prisma.job.findMany({
    where: {
      status: { in: ACTIVE_STATUSES },
      scoringStatus: 'failed',
    },
    select: {
      id: true,
      title: true,
      company: true,
      location: true,
      url: true,
      source: true,
      description: true,
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });

  const authoritative = stuck.filter((job) => hasAuthoritativeMetadata(job.source));
  const deferred = stuck.length - authoritative.length;

  const rejected = authoritative
    .map((job) => ({ job, verdict: evaluateAuthoritativeMetadata(job) }))
    .filter(({ verdict }) => !verdict.passes);

  console.log(`${apply ? 'APPLY' : 'DRY RUN'} — ${stuck.length.toLocaleString()} job(s) in Action Needed.\n`);
  console.log(`  ${authoritative.length.toLocaleString()} from sources with authoritative metadata (judged here)`);
  console.log(`  ${deferred.toLocaleString()} from aggregators (left alone — location is unreliable until the JD resolves)\n`);
  console.log(`  ${rejected.length.toLocaleString()} would be dismissed`);
  console.log(`  ${(authoritative.length - rejected.length).toLocaleString()} survive and still need a description\n`);

  if (rejected.length > 0) {
    const byReason = new Map<string, number>();
    for (const { verdict } of rejected) {
      byReason.set(verdict.reason, (byReason.get(verdict.reason) || 0) + 1);
    }
    console.log('  by reason:');
    for (const [reason, count] of [...byReason].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${String(count).padStart(5)}  ${reason}`);
    }

    const bySource = new Map<string, number>();
    for (const { job } of rejected) {
      bySource.set(String(job.source), (bySource.get(String(job.source)) || 0) + 1);
    }
    console.log('\n  by source:');
    for (const [source, count] of [...bySource].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${String(count).padStart(5)}  ${source}`);
    }

    // Printed so a wrong rule is visible before it is applied, not after.
    console.log('\n  samples:');
    for (const { job, verdict } of rejected.slice(0, SAMPLE_LIMIT)) {
      console.log(`    ${String(job.company || '?').slice(0, 20).padEnd(22)}${String(job.title || '').slice(0, 40).padEnd(42)}${String(job.location || '—').slice(0, 26).padEnd(28)}${verdict.reason.slice(0, 46)}`);
    }
  }

  if (!apply || rejected.length === 0) {
    console.log(apply ? '\nNothing to write.' : '\nDry run. Re-run with --apply to dismiss the rows above.');
    return;
  }

  let dismissed = 0;
  for (let index = 0; index < rejected.length; index += 200) {
    const chunk = rejected.slice(index, index + 200);
    const results = await prisma.$transaction(chunk.map(({ job, verdict }) => prisma.job.updateMany({
      // Re-check status so a job the pipeline has since claimed or a human has
      // since acted on is never overwritten.
      where: { id: job.id, status: { in: ACTIVE_STATUSES }, scoringStatus: 'failed' },
      data: {
        scoringStatus: 'skipped',
        status: 'dismissed',
        passReason: verdict.reason,
        scoreError: null,
        batchJobId: null,
        jdBatchId: null,
      },
    })));
    dismissed += results.reduce((sum, result) => sum + result.count, 0);
    console.log(`  dismissed ${dismissed.toLocaleString()}/${rejected.length.toLocaleString()}`);
  }

  console.log(`\nDismissed ${dismissed.toLocaleString()} job(s) on metadata alone.`);
}

main()
  .catch((error: unknown) => {
    console.error(`ATS triage failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
