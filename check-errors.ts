import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const jobs = await prisma.job.findMany({
    where: { scoringStatus: 'needs_jd' },
    select: { id: true, title: true, scoreError: true, jdBatchId: true }
  });
  const errors = jobs.filter(j => j.scoreError).map(j => j.scoreError);
  console.log(`Found ${errors.length} jobs with scoreError`);
  console.log(Array.from(new Set(errors)));
}
main().catch(console.error).finally(() => prisma.$disconnect());
