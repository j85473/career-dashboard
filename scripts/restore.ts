import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // The exact timestamp of the updateMany batch that cleared the inbox jobs
  const originalInboxJobs = await prisma.job.findMany({
    where: { updatedAt: { equals: new Date('2026-07-30T17:21:25.416Z') } },
    select: { id: true }
  });

  const originalDismissedIds = [
    '551d748f-38e6-448f-ba3b-c46ad668e3e1',
    '8f700163-724d-44fe-80bc-75c766980cd0',
    '02f751ab-a6b2-4799-a5ec-f0c3ef93a7d3'
  ];

  const originalIds = [
    ...originalInboxJobs.map(j => j.id),
    ...originalDismissedIds
  ];

  console.log(`Found ${originalIds.length} original jobs to restore.`);

  // 1. Clear everything currently staged
  await prisma.job.updateMany({
    where: { tailoringStaged: true },
    data: { tailoringStaged: false }
  });

  // 2. Restore the original jobs
  await prisma.job.updateMany({
    where: { id: { in: originalIds } },
    data: { tailoringStaged: true }
  });

  const needed = 30 - originalIds.length;
  console.log(`Need ${needed} more jobs to reach 30.`);

  if (needed > 0) {
    // 3. Stage the best 'needed' jobs from inbox
    const topJobs = await prisma.job.findMany({
      where: {
        status: 'inbox',
        tailoringStaged: false,
        fitScore: { not: null },
        aimFitScore: { not: null }
      },
      orderBy: [
        { fitScore: 'desc' },
        { aimFitScore: 'desc' },
        { travelScore: 'desc' }
      ],
      take: needed
    });

    for (const job of topJobs) {
      await prisma.job.update({
        where: { id: job.id },
        data: { tailoringStaged: true }
      });
      console.log(`- Staged: ${job.title} at ${job.company}`);
    }
  }

  const finalCount = await prisma.job.count({ where: { tailoringStaged: true } });
  console.log(`Final staged jobs count: ${finalCount}`);
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
