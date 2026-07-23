import { prisma } from './src/lib/prisma';
async function run() {
  const r = await prisma.ingestionSourceRun.findMany({
    where: { source: 'Adzuna' },
    orderBy: { createdAt: 'desc' },
    take: 5
  });
  console.log(JSON.stringify(r, null, 2));
}
run();
