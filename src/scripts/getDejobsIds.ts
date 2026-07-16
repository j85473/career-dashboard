import { prisma } from '../lib/prisma';

async function run() {
  const jobsToRescue = await prisma.job.findMany({
    where: {
      OR: [
        { url: { contains: 'dejobs.org' } },
        { url: { contains: 'jobsyn.org' } },
        { canonicalUrl: { contains: 'dejobs.org' } },
        { canonicalUrl: { contains: 'jobsyn.org' } },
      ]
    },
    select: { id: true }
  });

  console.log(JSON.stringify(jobsToRescue.map(j => j.id)));
}

run().finally(() => prisma.$disconnect());
