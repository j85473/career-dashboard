import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '../src/lib/prisma';
import { legacyMissingCareerRetryAt } from '../src/lib/atsFirstCollectionRetry';

/** Retain every candidate and its failure evidence; change legacy daily retry dates only. */
async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const report = args.find(arg => arg.startsWith('--report='))?.slice(9);
  if (args.some(arg => arg !== '--apply' && !arg.startsWith('--report=')) || apply && (!report || !path.isAbsolute(report))) {
    throw new Error('Usage: repair_ats_validation_retry_dates.ts [--apply --report=/absolute/receipt.json]');
  }
  const result = await prisma.$transaction(async tx => {
    if (apply) {
      await tx.$queryRaw`SELECT id FROM "AtsFirstCollectionPolicy" WHERE id='new-providers' FOR UPDATE`;
      const policy = await tx.atsFirstCollectionPolicy.findUniqueOrThrow({ where: { id: 'new-providers' } });
      if (policy.validationLeaseExpiresAt && policy.validationLeaseExpiresAt > new Date()) {
        throw new Error('A validator is in flight; retry this repair after it finishes');
      }
    } else await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    const candidates = await tx.atsFirstCollectionCandidate.findMany({ where: {
      state: 'discovered', lastError: { in: ['Feed HTTP 404', 'Feed HTTP 410', 'Career page HTTP 404', 'Career page HTTP 410'] },
    } });
    const changes = candidates.flatMap(candidate => {
      const retryAt = legacyMissingCareerRetryAt(candidate);
      return retryAt ? [{ platform: candidate.platform, slug: candidate.slug, lastError: candidate.lastError,
        lastValidationStartedAt: candidate.lastValidationStartedAt!.toISOString(),
        previousRetryAt: candidate.nextValidationAt.toISOString(), nextRetryAt: retryAt.toISOString() }] : [];
    });
    const receipt = { status: 'planned', observedAt: new Date().toISOString(), changes };
    if (apply && changes.length) {
      // Persist the exact cohort before mutation so interrupted output remains inspectable.
      fs.writeFileSync(report!, JSON.stringify(receipt, null, 2), { flag: 'wx', mode: 0o600 });
      const changed = await tx.$executeRaw`
        UPDATE "AtsFirstCollectionCandidate" c SET "nextValidationAt"=p."nextRetryAt", "updatedAt"=(now() AT TIME ZONE 'UTC')
        FROM jsonb_to_recordset(${JSON.stringify(changes)}::jsonb) AS p(platform text, slug text, "lastError" text,
          "lastValidationStartedAt" timestamp, "previousRetryAt" timestamp, "nextRetryAt" timestamp)
        WHERE c.platform=p.platform AND c.slug=p.slug AND c.state='discovered' AND c."lastError"=p."lastError"
          AND c."lastValidationStartedAt"=p."lastValidationStartedAt" AND c."nextValidationAt"=p."previousRetryAt"
      `;
      if (changed !== changes.length) throw new Error('Candidate cohort changed; the transaction was rolled back');
    }
    return { ...receipt, status: apply ? 'applied' : 'preview' };
  }, { timeout: 30_000 });
  if (apply && result.changes.length) fs.writeFileSync(report!, JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ status: result.status, candidates: result.changes.length,
    byReason: result.changes.reduce<Record<string, number>>((counts, change) => {
      counts[change.lastError!] = (counts[change.lastError!] || 0) + 1; return counts;
    }, {}), ...(apply ? { report } : {}) }));
}

main().catch(error => { console.error(error instanceof Error ? error.message : 'Retry repair failed'); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
