import 'dotenv/config';

import { writeFileSync } from 'node:fs';

import { Prisma } from '@prisma/client';
import { prisma } from '../src/lib/prisma';
import { planIdentityFingerprintRepairs, type StoredIdentityRow } from '../src/lib/companyIdentityFingerprintRepair';

/**
 * Re-hashes stored job identities written before Workday entity codes were
 * stripped from company keys (23202d0). Without this, ingestion's fingerprint
 * lookup cannot find an older "USA-NILIN Nilfisk, Inc." row for a new
 * "Nilfisk, Inc." posting of the same role.
 *
 * Only `identityFingerprint` changes: no title, company, status, score or
 * `updatedAt`. A row is rewritten only when its stored value is exactly the
 * pre-cleanup hash of its current labels, and the UPDATE re-checks that value.
 * Dry run by default; `--apply` also writes an undo file of old values.
 */

const PAGE = 5000;
const BATCH = 500;

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const repairs: ReturnType<typeof planIdentityFingerprintRepairs> = [];
  let scanned = 0;
  let after = '';
  for (;;) {
    // Only names that start with a code or end in "Legal Entity" can hash
    // differently; the planner verifies every row regardless.
    const rows = await prisma.$queryRaw<StoredIdentityRow[]>(Prisma.sql`
      SELECT id, title, company, location, "identityFingerprint"
      FROM "Job"
      WHERE id > ${after}
        AND "identityFingerprint" IS NOT NULL
        AND (company ~ '^[0-9A-Z][0-9A-Z]*[-0-9 ]' OR company ~* ' Legal Entity$')
      ORDER BY id
      LIMIT ${PAGE}
    `);
    if (rows.length === 0) break;
    scanned += rows.length;
    after = rows.at(-1)!.id;
    repairs.push(...planIdentityFingerprintRepairs(rows));
  }

  console.log(`${apply ? 'APPLY' : 'DRY RUN'} — company identity fingerprint repair`);
  console.log(`  coded-looking rows scanned: ${scanned.toLocaleString()}`);
  console.log(`  stale fingerprints to re-hash: ${repairs.length.toLocaleString()}`);
  if (!apply) {
    console.log('\nZero writes performed. Re-run with --apply to write.');
    return;
  }

  const undoPath = `tmp/company-identity-repair-undo-${Date.now()}.json`;
  writeFileSync(undoPath, JSON.stringify(repairs.map(({ id, from }) => ({ id, identityFingerprint: from }))));
  console.log(`  undo file: ${undoPath}`);

  let written = 0;
  for (let index = 0; index < repairs.length; index += BATCH) {
    const batch = repairs.slice(index, index + BATCH);
    const values = Prisma.join(batch.map(repair => Prisma.sql`(${repair.id}, ${repair.from}, ${repair.to})`));
    written += await prisma.$executeRaw(Prisma.sql`
      UPDATE "Job" AS job SET "identityFingerprint" = repair.next
      FROM (VALUES ${values}) AS repair(id, previous, next)
      WHERE job.id = repair.id AND job."identityFingerprint" = repair.previous
    `);
  }
  console.log(`  written: ${written.toLocaleString()} (skipped because changed meanwhile: ${(repairs.length - written).toLocaleString()})`);
}

main()
  .catch((error: unknown) => {
    console.error(`Company identity repair failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
