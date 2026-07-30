import { PrismaClient } from '@prisma/client';
import fs from 'fs';
const prisma = new PrismaClient();

async function main() {
  const jobs = await prisma.job.findMany({
    where: { status: 'passed', contextBatched: false },
    select: { id: true, title: true, company: true, url: true },
    take: 10
  });
  
  const batch1 = jobs.slice(0, 5);
  const batch2 = jobs.slice(5, 10);
  
  fs.writeFileSync('batch1.json', JSON.stringify(batch1, null, 2));
  fs.writeFileSync('batch2.json', JSON.stringify(batch2, null, 2));
}
main().catch(console.error).finally(() => prisma.$disconnect());
