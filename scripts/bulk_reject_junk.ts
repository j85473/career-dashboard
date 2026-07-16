import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const jobs = await prisma.job.findMany({
    where: {
      status: { in: ['pending_af', 'inbox'] },
      scoringStatus: 'scored',
      afBatchId: null,
      aimFitScore: null
    },
    select: { id: true, title: true, company: true }
  });

  const junkKeywords = [
    'therapist', 'nurse', 'hvac', 'maintenance', 'investment', 'banking', 
    'recruitment', 'talent community', 'retail', 'pharmacist', 
    'teacher', 'physician', 'plumber', 'electrician', 'mechanic', 
    'technician', 'operator', 'assembler', 'welder', 'carpenter', 
    'cleaner', 'janitor', 'delivery', 'driver', 'cashier', 'server', 
    'bartender', 'barista', 'warehouse', 'clerk', 'bookkeeper', 
    'receptionist', 'administrative', 'coordinator', 'assistant'
  ];

  const regex = new RegExp(`\\b(${junkKeywords.join('|')})\\b`, 'i');

  const junkJobIds = jobs.filter(j => regex.test(j.title)).map(j => j.id);

  if (junkJobIds.length === 0) {
    console.log('No junk jobs found in the queue.');
    return;
  }

  console.log(`Found ${junkJobIds.length} irrelevant jobs to purge out of ${jobs.length} total.`);
  
  const result = await prisma.job.updateMany({
    where: { id: { in: junkJobIds } },
    data: { status: 'archived', scoreError: 'Bulk rejected as irrelevant junk' }
  });

  console.log(`Successfully archived ${result.count} junk jobs.`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
