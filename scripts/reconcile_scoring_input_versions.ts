import { prisma } from '../src/lib/prisma';
import { reconcileScoringInputVersions } from '../src/lib/scoringInputReconciliation';

const dryRun = process.argv.includes('--dry-run');

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

  const report = await reconcileScoringInputVersions(prisma, { dryRun });
  console.log(JSON.stringify(report, null, 2));
}

main().finally(() => prisma.$disconnect());
