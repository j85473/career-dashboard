import { prisma } from '../src/lib/prisma';
import { reconcileScoringInputVersions } from '../src/lib/scoringInputReconciliation';

const dryRun = process.argv.includes('--dry-run');

reconcileScoringInputVersions(prisma, { dryRun })
  .then((report) => {
    console.log(JSON.stringify(report, null, 2));
  })
  .finally(() => prisma.$disconnect());
