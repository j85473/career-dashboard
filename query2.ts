import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const jobs = await prisma.job.findMany({
    where: {
      aimFitScore: { not: null },
      reqFitScore: { not: null },
      OR: [
        { aimFitScore: { lt: 75 } },
        { reqFitScore: { lt: 75 } }
      ]
    },
    take: 500,
    orderBy: { createdAt: 'desc' },
    select: {
      aimFitScore: true,
      reqFitScore: true
    }
  });

  let aimFail = 0;
  let expFail = 0;
  let bothFail = 0;
  const total = jobs.length;

  for (const job of jobs) {
    const aim = job.aimFitScore!;
    const exp = job.reqFitScore!;
    
    if (aim < 75 && exp < 75) {
      bothFail++;
    } else if (aim < 75) {
      aimFail++;
    } else if (exp < 75) {
      expFail++;
    }
  }

  console.log(`Total analyzed: ${total}`);
  console.log(`Failed only Aim Fit: ${aimFail}`);
  console.log(`Failed only Experience Fit: ${expFail}`);
  console.log(`Failed both: ${bothFail}`);
  console.log(`Failed due to Aim Fit primarily (including both): ${aimFail + bothFail}`);
  console.log(`Failed due to Experience Fit primarily (including both): ${expFail + bothFail}`);
}

main().then(() => prisma.$disconnect());
