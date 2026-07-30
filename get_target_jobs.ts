import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const jobs = await prisma.job.findMany({
    where: {
      id: {
        in: [
          '560aaca0-b83c-4786-a38e-01d6d7526011',
          '56292ecc-98aa-4ad3-9e63-6c9f77101ce0',
          '57b361b3-f7ab-42f7-a12a-cc49dbb23c71',
          '5bcbd7a4-9d82-47dd-b4f1-060cdc86806e',
          '60be80c3-972a-445e-8a23-1c651c13d888'
        ]
      }
    },
    select: {
      id: true,
      title: true,
      company: true,
      description: true,
      location: true
    }
  });

  const fs = require('fs');
  fs.writeFileSync('target_jobs_output.json', JSON.stringify(jobs, null, 2));
  console.log('Saved to target_jobs_output.json');
}

main().catch(console.error).finally(() => prisma.$disconnect());
