import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
  const missing = await prisma.job.findMany({
    where: { 
      status: 'inbox',
      NOT: {
        AND: [
          { tailoringStaged: false },
          { luckyStatus: { not: 'inbox' } },
          { aimFitScore: { not: null } }
        ]
      }
    },
    select: { tailoringStaged: true, luckyStatus: true, aimFitScore: true }
  });
  console.log("Missing breakdown:", missing.reduce((acc, j) => {
    const key = `tailoring:${j.tailoringStaged}, lucky:${j.luckyStatus}, aim:${j.aimFitScore !== null}`;
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {} as Record<string, number>));
}
main().catch(console.error).finally(() => prisma.$disconnect());
