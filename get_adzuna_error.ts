import { prisma } from './src/lib/prisma';
async function run() {
  const r = await prisma.ingestionSourceRun.findMany({
    where: { source: 'Adzuna' },
    orderBy: { createdAt: 'desc' },
    take: 3
  });
  console.log(r.map(x => ({ id: x.id, err: x.error, created: x.createdAt })));
}
run();
