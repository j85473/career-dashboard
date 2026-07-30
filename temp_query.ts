import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const statuses = await prisma.job.findMany({
    distinct: ['status'],
    select: { status: true }
  });
  console.log('Statuses:', statuses.map(s => s.status));

  const scoringStatuses = await prisma.job.findMany({
    distinct: ['scoringStatus'],
    select: { scoringStatus: true }
  });
  console.log('Scoring Statuses:', scoringStatuses.map(s => s.scoringStatus));

  const fitCategories = await prisma.job.findMany({
    distinct: ['fitCategory'],
    select: { fitCategory: true }
  });
  console.log('Fit Categories:', fitCategories.map(s => s.fitCategory));
}
main().catch(console.error).finally(() => prisma.$disconnect());
