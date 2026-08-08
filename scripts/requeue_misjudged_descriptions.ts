import 'dotenv/config';

import { PrismaClient } from '@prisma/client';

import { looksLikeInvalidJobDescription } from '../src/lib/jobDescriptionQuality';

/**
 * Requeues jobs that were parked by the description-quality gate but read as
 * healthy under the current rules.
 *
 * Two gate bugs discarded good listings: pay-transparency boilerplate ("if the
 * position is filled") and accommodation hotlines containing 404. Those jobs
 * are stranded because local scoring only ever selects `queued` rows, so a
 * `needs_jd`, `failed`, or `skipped` job is never reconsidered on its own.
 *
 * Dry run by default. Pass --apply to write.
 */

const prisma = new PrismaClient();

// The gate stamps these exact reasons when it parks a job. Matching on them
// rather than on scoringStatus matters: 'skipped' is also set by the ordinary
// heuristic rejection path, and selecting by status swept in tens of thousands
// of correctly-triaged jobs.
const GATE_PASS_REASONS = [
  'Job description was severely truncated. Please submit JD Batch or review manually.',
  'Failed to fetch JD after 3 attempts. Needs manual review.',
];
const MIN_HEALTHY_LENGTH = 400;

function parseArguments(argv: string[]): { apply: boolean; ids: string[] } {
  let apply = false;
  const ids: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--apply') {
      apply = true;
    } else if (argv[index] === '--id') {
      const id = argv[index + 1] || '';
      if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error(`Not a job id: ${id}`);
      ids.push(id);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argv[index]}`);
    }
  }
  return { apply, ids };
}

async function main(): Promise<void> {
  const { apply, ids } = parseArguments(process.argv.slice(2));

  const candidates = await prisma.job.findMany({
    where: {
      status: { in: ['pending_af', 'inbox', 'dismissed'] },
      ...(ids.length
        ? { id: { in: ids } }
        : { passReason: { in: GATE_PASS_REASONS }, description: { not: null } }),
    },
    select: {
      id: true, company: true, title: true, status: true,
      scoringStatus: true, description: true, batchJobId: true,
    },
    orderBy: { createdAt: 'asc' },
  });

  // Only rescue what the current gate accepts, so a genuinely dead posting is
  // left parked rather than cycled back through scoring to be parked again.
  const recoverable = candidates.filter((job) => {
    const description = job.description || '';
    return description.length >= MIN_HEALTHY_LENGTH && !looksLikeInvalidJobDescription(description);
  });

  const resurrected = recoverable.filter((job) => job.status === 'dismissed');

  console.log(`Examined ${candidates.length} parked job(s); ${recoverable.length} read as healthy now.\n`);
  for (const job of recoverable) {
    const flag = job.status === 'dismissed' ? '  [DISMISSED -> pending_af]' : '';
    console.log(`  ${job.company} — ${job.title}`);
    console.log(`    ${job.scoringStatus} · ${job.status} · ${(job.description || '').length} chars${flag}`);
  }
  if (resurrected.length > 0) {
    console.log(`\n${resurrected.length} of these were dismissed and will reappear in the inbox.`);
  }

  if (!apply) {
    console.log('\nDry run. Re-run with --apply to requeue these jobs.');
    return;
  }

  const updated = await prisma.job.updateMany({
    where: { id: { in: recoverable.map((job) => job.id) } },
    data: {
      status: 'pending_af',
      scoringStatus: 'queued',
      // Clearing the lease matters: a queued job still holding one is
      // unclaimable and would sit in the queue forever.
      batchJobId: null,
      scoreAttempts: 0,
    },
  });
  console.log(`\nRequeued ${updated.count} job(s). Run local scoring to pick them up.`);
}

main()
  .catch((error: unknown) => {
    console.error(`Requeue failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
