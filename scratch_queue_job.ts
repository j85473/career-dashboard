import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const jobId = 'ba33c542-debc-4147-8422-d21676192bb1';
  
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) {
    console.error(`Job ${jobId} not found`);
    return;
  }
  
  const updated = await prisma.job.update({
    where: { id: jobId },
    data: { 
      scoringStatus: 'queued',
      status: 'pending_af',
      experienceStatus: 'queued',
      scoreAttempts: 0
    }
  });
  console.log(`Successfully added to queue: ${updated.title} at ${updated.company}`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
