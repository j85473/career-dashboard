import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const apply = process.argv.includes('--apply');
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  const standardWhere = {
    createdAt: { gte: sevenDaysAgo },
    status: { in: ['inbox', 'dismissed'] },
  };
  const [standardCount, luckyCount] = await Promise.all([
    prisma.job.count({ where: standardWhere }),
    prisma.job.count({
      where: {
        ...standardWhere,
        luckyStatus: { not: 'none' },
      },
    }),
  ]);

  console.log(`Rescore window starts ${sevenDaysAgo.toISOString()} and uses createdAt (ingestion time).`);
  console.log(`Standard jobs selected: ${standardCount}`);
  console.log(`Wildcard jobs selected: ${luckyCount}`);

  if (!apply) {
    console.log('Dry run only. Re-run with --apply to clear these recent scores.');
    return;
  }

  const standardUpdated = await prisma.job.updateMany({
    where: standardWhere,
    data: {
      status: 'pending_af',
      aimFitScore: null,
      reqFitScore: null,
      reqFitRationale: null,
      travelScore: null,
      passReason: null,
      afBatchId: null,
      scoreAttempts: 0,
      scoreError: null,
      deepseekScoreAttempts: 0,
      deepseekScoreError: null,
      scoringStatus: 'scored',
      experienceStatus: 'queued',
      luckyStatus: 'none',
      luckyAimFitScore: null,
      luckyFitScore: null,
      luckyPassReason: null,
      luckyFitCategory: 'unscored',
      luckyScoreAttempts: 0,
      luckyScoreError: null,
      luckyBatchId: null,
    },
  });

  console.log(`Reset ${standardUpdated.count} recent jobs, including ${luckyCount} with stale wildcard state.`);
  console.log('Done. The pipeline can now evaluate only jobs ingested during the last seven days.');
}
main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
