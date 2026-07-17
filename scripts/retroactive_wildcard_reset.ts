import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const result = await prisma.job.updateMany({
    where: {
      luckyStatus: 'pending',
      OR: [
        { reqFitScore: { lt: 85 } },
        { reqFitScore: null }
      ]
    },
    data: {
      luckyStatus: 'none'
    }
  });

  console.log(`Successfully reset luckyStatus to 'none' for ${result.count} unqualified jobs.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
