import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const jobs = await prisma.job.findMany({
    where: { passReason: { not: null } },
    select: { id: true, title: true, status: true, passReason: true }
  });
  console.log(`Found ${jobs.length} jobs with a passReason.`);
  const nonInbox = jobs.filter(j => j.status !== 'inbox' && j.status !== 'dismissed');
  console.log(JSON.stringify(nonInbox, null, 2));
}
main().catch(console.error).finally(() => prisma.$disconnect());
