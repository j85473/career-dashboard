import 'dotenv/config';

import { prisma } from '../src/lib/prisma';
import {
  DECIDED_STATUSES,
  INVISIBLE_STATUSES,
  isAppliedDuplicateReason,
  planAppliedDuplicateSuppression,
} from '../src/lib/appliedDuplicatePolicy';

/**
 * Hides listings that repeat a job already applied to, passed on, or in
 * cooldown/interviewing.
 *
 * The match key is `identityFingerprint` (company|title|location), never
 * title+company — Breezy and Rippling post one requisition per city, and a
 * title+company key would hide a Duluth role because the Minneapolis one was
 * applied to. See src/lib/appliedDuplicatePolicy.ts.
 *
 * Suppressed rows are dismissed with a reason naming the posting they repeat,
 * so they stay findable under dismissed and a wrong match can be spotted.
 *
 * Dry run by default; `--apply` writes.
 */
const DUPLICATE_SKIP_REASON_MARKER = 'applied-duplicate';

function parseArguments(argv: string[]): { apply: boolean } {
  for (const argument of argv) {
    if (argument !== '--apply') throw new Error('Usage: dismiss_applied_duplicates.ts [--apply]');
  }
  return { apply: argv.includes('--apply') };
}

async function main(): Promise<void> {
  const { apply } = parseArguments(process.argv.slice(2));
  console.log(`${apply ? 'APPLY' : 'DRY RUN'} — reading decided jobs and live candidates...`);

  const decided = await prisma.job.findMany({
    where: { status: { in: [...DECIDED_STATUSES] }, identityFingerprint: { not: null } },
    select: { id: true, identityFingerprint: true, status: true, company: true, title: true, location: true },
  });

  const candidates = await prisma.job.findMany({
    where: {
      status: { notIn: [...DECIDED_STATUSES, ...INVISIBLE_STATUSES] },
      identityFingerprint: { in: decided.map((job) => job.identityFingerprint as string) },
    },
    select: { id: true, identityFingerprint: true, status: true, company: true, title: true, location: true },
  });

  console.log(`  decided jobs with a fingerprint: ${decided.length.toLocaleString()}`);
  console.log(`  live rows sharing one:           ${candidates.length.toLocaleString()}`);

  const plans = planAppliedDuplicateSuppression(candidates, decided);
  console.log(`\n  would suppress: ${plans.length.toLocaleString()}\n`);

  const byId = new Map(candidates.map((job) => [job.id, job]));
  for (const plan of plans) {
    const job = byId.get(plan.jobId);
    console.log(`    ${String(job?.status ?? '?').padEnd(11)}${String(job?.title ?? '').slice(0, 38).padEnd(40)}${String(job?.company ?? '').slice(0, 18).padEnd(20)}${String(job?.location ?? '').slice(0, 24)}`);
    console.log(`        ${plan.reason}`);
  }
  if (plans.length === 0) {
    console.log('    (nothing to suppress)');
    return;
  }

  if (!apply) {
    console.log('\nDry run. Re-run with --apply to dismiss these, badged and findable under dismissed.');
    return;
  }

  let suppressed = 0;
  for (const plan of plans) {
    // Re-check the status so a row promoted or applied to since the read is
    // left alone; scores are untouched, only visibility changes.
    const result = await prisma.job.updateMany({
      where: { id: plan.jobId, status: { notIn: [...DECIDED_STATUSES, ...INVISIBLE_STATUSES] } },
      data: {
        status: 'dismissed',
        scoringStatus: 'skipped',
        passReason: plan.reason,
        scoreError: null,
      },
    });
    suppressed += result.count;
  }
  console.log(`\nSuppressed ${suppressed.toLocaleString()} duplicate listing(s) (marker: ${DUPLICATE_SKIP_REASON_MARKER}).`);

  const sanity = await prisma.job.count({ where: { status: 'dismissed' } });
  console.log(`Dismissed rows now: ${sanity.toLocaleString()}`);
  console.log(`Reason format verified: ${isAppliedDuplicateReason(plans[0].reason)}`);
}

main()
  .catch((error: unknown) => {
    console.error(`Applied-duplicate suppression failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
