import 'dotenv/config';

import { prisma } from '../src/lib/prisma';
import {
  applyProtectedAppliedIdentityBackfill,
  planProtectedAppliedIdentityBackfill,
} from '../src/lib/appliedDuplicateIdentity';
import { listUncoveredProtectedAppliedEvidence } from '../src/lib/appliedDuplicateStore';

function parseArguments(argv: string[]): { apply: boolean } {
  for (const argument of argv) {
    if (argument !== '--apply') {
      throw new Error('Usage: backfill_applied_identity_fingerprints.ts [--apply]');
    }
  }
  return { apply: argv.includes('--apply') };
}

async function main(): Promise<void> {
  const { apply } = parseArguments(process.argv.slice(2));
  const candidates = await listUncoveredProtectedAppliedEvidence();
  const preview = planProtectedAppliedIdentityBackfill(candidates);

  console.log(`${apply ? 'APPLY' : 'DRY RUN'} — protected applied identity coverage`);
  console.log(`  uncovered Applied/Interviewing/Already applied rows: ${candidates.length.toLocaleString()}`);
  console.log(`  eligible reliable-location backfills:                 ${preview.plans.length.toLocaleString()}`);
  console.log(`  skipped unreliable/placeholder locations:             ${preview.skippedUnreliableLocationIds.length.toLocaleString()}`);
  console.log('  Passed and Cooldown historical rows:                   excluded by policy');

  for (const plan of preview.plans) {
    console.log(`    ${plan.id}  ${plan.expectedStatus.padEnd(12)}  ${plan.expectedTitle} at ${plan.expectedCompany} — ${plan.expectedLocation}`);
  }
  for (const id of preview.skippedUnreliableLocationIds) {
    console.log(`    SKIPPED ${id} — unreliable or placeholder location`);
  }

  if (!apply) {
    console.log('\nZero writes performed. Re-run with --apply only after reviewing this exact preview.');
    return;
  }

  const result = await applyProtectedAppliedIdentityBackfill(preview.plans, prisma);
  console.log(`\nApplied: ${result.appliedIds.length.toLocaleString()}`);
  console.log(`Refused after concurrency guard: ${result.refusedIds.length.toLocaleString()}`);
  for (const id of result.refusedIds) console.log(`    REFUSED ${id}`);
  if (result.refusedIds.length > 0) process.exitCode = 2;
}

main()
  .catch((error: unknown) => {
    console.error(`Applied identity backfill failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
