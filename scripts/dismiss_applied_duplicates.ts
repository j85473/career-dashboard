import 'dotenv/config';

import { prisma } from '../src/lib/prisma';
import {
  APPLIED_DUPLICATE_CANDIDATE_PROTECTED_STATUSES,
  INVISIBLE_STATUSES,
  isAppliedDuplicateReason,
  ALREADY_APPLIED_REASON,
  effectiveIdentityFingerprint,
  planAppliedDuplicateSuppression,
} from '../src/lib/appliedDuplicatePolicy';
import { planProtectedAppliedIdentityBackfill } from '../src/lib/appliedDuplicateIdentity';
import {
  listAppliedDuplicateEvidence,
  listUncoveredProtectedAppliedEvidence,
} from '../src/lib/appliedDuplicateStore';
import { nonManualImportSourceWhere } from '../src/lib/manualImportPolicy';

/**
 * Hides listings that repeat affirmative application evidence: Applied,
 * Interviewing, or an exact explicit "Already applied" reason. Passed and
 * Cooldown rows never authorize suppression and are never mutated as candidates.
 *
 * The match key is the v4 company|title|location identity, never title+company
 * — Breezy and Rippling post one requisition per city, and a title+company key
 * would hide a Duluth role because the Minneapolis one was applied to. Rows
 * written before the identity migration keep that hash in the legacy
 * `fingerprint` column, so both columns are read. See
 * src/lib/appliedDuplicatePolicy.ts.
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
  console.log(`${apply ? 'APPLY' : 'DRY RUN'} — reading applied-authority jobs and live candidates...`);

  const [storedAuthorities, uncoveredProtected] = await Promise.all([
    listAppliedDuplicateEvidence(),
    listUncoveredProtectedAppliedEvidence(),
  ]);
  const identityPreview = planProtectedAppliedIdentityBackfill(uncoveredProtected);

  // `uncoveredProtected` means "the new column is empty", which is the right
  // cohort for the backfill but not for this script: most of those rows already
  // act as authority through their legacy v4 hash. Only a row with no usable
  // identity in *either* column genuinely has to wait for the backfill, so the
  // projection is limited to those and the rest are left to the stored list.
  const storedById = new Map(storedAuthorities.map((job) => [job.id, job]));
  const projectedAuthorities = identityPreview.plans.flatMap((plan) => {
    const source = uncoveredProtected.find((job) => job.id === plan.id);
    if (!source) throw new Error(`Missing projected identity source ${plan.id}`);
    if (effectiveIdentityFingerprint(storedById.get(plan.id) ?? source)) return [];
    return [{ ...source, identityFingerprint: plan.identityFingerprint }];
  });
  const authorities = [...storedAuthorities, ...projectedAuthorities];

  // An authority row keys off whichever column holds its v4 hash, and so does a
  // candidate: both pre- and post-migration rows have to be reachable here.
  const authorityFingerprints = [...new Set(
    authorities.map(effectiveIdentityFingerprint).filter((value): value is string => Boolean(value)),
  )];
  const candidates = await prisma.job.findMany({
    where: {
      status: { notIn: [...APPLIED_DUPLICATE_CANDIDATE_PROTECTED_STATUSES, ...INVISIBLE_STATUSES] },
      AND: [
        {
          OR: [
            { identityFingerprint: { in: authorityFingerprints } },
            { fingerprint: { in: authorityFingerprints } },
          ],
        },
        nonManualImportSourceWhere(),
      ],
    },
    select: {
      id: true, identityFingerprint: true, fingerprint: true,
      status: true, company: true, title: true, location: true,
    },
  });

  console.log(`  applied authorities usable now:         ${storedAuthorities.length.toLocaleString()} (including ${ALREADY_APPLIED_REASON})`);
  console.log(`    of those, keyed in the legacy column:  ${storedAuthorities.filter((job) => !job.identityFingerprint).length.toLocaleString()}`);
  console.log(`  rows the identity backfill would fill:   ${identityPreview.plans.length.toLocaleString()} of ${uncoveredProtected.length.toLocaleString()} uncovered`);
  console.log(`    ...that are unusable until it runs:    ${projectedAuthorities.length.toLocaleString()}`);
  console.log(`  skipped unreliable locations:           ${identityPreview.skippedUnreliableLocationIds.length.toLocaleString()}`);
  console.log('  historical Passed/Cooldown activation:  excluded by policy');
  console.log(`  live rows sharing one:           ${candidates.length.toLocaleString()}`);

  const plans = planAppliedDuplicateSuppression(candidates, authorities);
  const projectedEvidenceIds = new Set(projectedAuthorities.map((job) => job.id));
  const readyPlans = plans.filter((plan) => !projectedEvidenceIds.has(plan.duplicateOfJobId));
  const afterBackfillPlans = plans.filter((plan) => projectedEvidenceIds.has(plan.duplicateOfJobId));
  console.log(`\n  would suppress now:                     ${readyPlans.length.toLocaleString()}`);
  console.log(`  would suppress after identity backfill: ${afterBackfillPlans.length.toLocaleString()}\n`);

  const byId = new Map(candidates.map((job) => [job.id, job]));
  for (const plan of plans) {
    const job = byId.get(plan.jobId);
    const previewOnly = projectedEvidenceIds.has(plan.duplicateOfJobId) ? ' [requires identity backfill]' : '';
    console.log(`    ${String(job?.status ?? '?').padEnd(11)}${String(job?.title ?? '').slice(0, 38).padEnd(40)}${String(job?.company ?? '').slice(0, 18).padEnd(20)}${String(job?.location ?? '').slice(0, 24)}${previewOnly}`);
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
  for (const plan of readyPlans) {
    // Re-check the status so a row promoted or applied to since the read is
    // left alone; scores are untouched, only visibility changes.
    const result = await prisma.job.updateMany({
      where: {
        id: plan.jobId,
        status: { notIn: [...APPLIED_DUPLICATE_CANDIDATE_PROTECTED_STATUSES, ...INVISIBLE_STATUSES] },
        AND: [nonManualImportSourceWhere()],
      },
      data: {
        status: 'dismissed',
        scoringStatus: 'skipped',
        passReason: plan.reason,
        scoreError: null,
      },
    });
    suppressed += result.count;
  }
  if (afterBackfillPlans.length > 0) {
    console.log(`Left ${afterBackfillPlans.length.toLocaleString()} projected suppression(s) unchanged because their protected evidence still requires the separately reviewed identity backfill.`);
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
