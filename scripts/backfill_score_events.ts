import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function processInChunks(items: any[], chunkSize: number, processFn: (chunk: any[]) => Promise<void>) {
  for (let i = 0; i < items.length; i += chunkSize) {
    const chunk = items.slice(i, i + chunkSize);
    await processFn(chunk);
  }
}

async function main() {
  const startOfDay = new Date();
  startOfDay.setHours(0,0,0,0);
  
  console.log('Finding jobs scored today that are missing a JobScoreEvent...');

  const jobs = await prisma.job.findMany({ 
    where: { 
      updatedAt: { gte: startOfDay }, 
      scoringStatus: 'scored',
      aimFitScore: { not: null }
    }, 
    select: { id: true, aimFitScore: true } 
  });
  
  const events = await prisma.jobScoreEvent.findMany({ 
    where: { createdAt: { gte: startOfDay } }, 
    select: { jobId: true } 
  });
  
  const eventJobIds = new Set(events.map(e => e.jobId)); 
  const missing = jobs.filter(j => !eventJobIds.has(j.id)); 
  
  console.log(`Found ${missing.length} missing events to backfill.`);

  await processInChunks(missing, 100, async (chunk) => {
    const creates = chunk.map((job) => {
      const passed = (job.aimFitScore || 0) >= 50;
      return prisma.jobScoreEvent.create({
        data: {
          jobId: job.id,
          evaluationType: 'ae_fit',
          model: 'agentic_bypass',
          promptVersion: 'v4',
          aimFitScore: job.aimFitScore,
          experienceFitScore: job.aimFitScore,
          passed: passed,
          aimReason: 'Backfilled from agentic bypass evaluation'
        }
      });
    });

    await prisma.$transaction(creates);
    console.log(`Backfilled chunk of ${creates.length} events...`);
  });

  console.log('Backfill complete!');
}

main().catch(console.error).finally(() => prisma.$disconnect());
