import { prisma } from '../src/lib/prisma';
import { reconcileScoringInputVersions } from '../src/lib/scoringInputReconciliation';

const dryRun = process.argv.includes('--dry-run');

function maxRequeueArgument(): number | undefined {
  const index = process.argv.indexOf('--max-requeue');
  if (index === -1) return undefined;
  const value = Number.parseInt(process.argv[index + 1] || '', 10);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error('--max-requeue requires a non-negative integer');
  }
  return value;
}

async function main(): Promise<void> {
  const [schema] = await prisma.$queryRaw<Array<{ extraction: string | null }>>`
    SELECT to_regclass('public."AimFactualExtraction"')::text AS extraction
  `;
  if (!schema?.extraction) {
    console.log(JSON.stringify({
      generatedAt: new Date().toISOString(),
      applied: false,
      ready: false,
      blocker: 'manual_scoring_v2_schema_missing',
      message: 'Input-version reconciliation requires the additive Aim v2 schema migration.',
    }, null, 2));
    process.exitCode = 1;
    return;
  }

  // Reporting by default. Version drift does not retract a score that was
  // already paid for in manual scoring time; clearing them is opt-in.
  const invalidateDrifted = process.argv.includes('--invalidate-drifted');
  const report = await reconcileScoringInputVersions(prisma, {
    dryRun,
    invalidateDrifted,
    maxRequeue: maxRequeueArgument(),
  });
  console.log(JSON.stringify(report, null, 2));
  if (report.withheldReason) {
    console.warn(`No scores were changed: ${report.withheldReason}.`);
    if (!invalidateDrifted && report.requeuedJobIds.length > 0) {
      console.warn('Pass --invalidate-drifted only if this change really does void those judgments.');
    }
  }
}

main().finally(() => prisma.$disconnect());
