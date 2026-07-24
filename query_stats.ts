import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
  const runs = await prisma.ingestionSourceRun.findMany({
    distinct: ['source'],
    orderBy: [{ source: 'asc' }, { createdAt: 'desc' }],
    select: { source: true, createdAt: true, status: true }
  });
  console.log("Distinct runs:", runs);
}
main().catch(console.error).finally(() => prisma.$disconnect());
