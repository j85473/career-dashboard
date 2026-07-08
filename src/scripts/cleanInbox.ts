import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const jobs = await prisma.job.findMany({
    where: { status: 'inbox' },
    select: { id: true, title: true, company: true }
  });

  const badRegex = /retail|\\bstore\\b|cashier|customer service|front desk|assistant manager|shift lead|barista|bartender|server|hostess|receptionist|inside sales|b2c|entry level|entry-level|door to door|door-to-door|nursing/i;
  
  // Exclude jobs that might be senior even if they have "retail" (like "Retail Partnerships")
  const safeRegex = /partner|b2b|enterprise|software|saas|director|vp|head|president/i;

  let passedCount = 0;

  for (const job of jobs) {
    if (badRegex.test(job.title) && !safeRegex.test(job.title)) {
      console.log(`Passing retail/junior job: ${job.company} - ${job.title}`);
      await prisma.job.update({
        where: { id: job.id },
        data: { status: 'passed', passReason: 'Auto-dismissed retail/B2C role' }
      });
      passedCount++;
    }
  }

  console.log(`Successfully auto-passed ${passedCount} retail/B2C jobs.`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
