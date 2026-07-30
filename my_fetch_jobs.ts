import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';

const prisma = new PrismaClient();

async function main() {
  const ids = [
    'd05a8546-b9b4-436a-b589-04a58a0c3708',
    'f0336672-284e-43ae-9e28-b7583767dd04',
    'f3f17275-7b55-4a3e-8c1b-bd934c2f3aad',
    'f4636668-2960-4322-a2f0-bbe6912117f3'
  ];
  const jobs = await prisma.job.findMany({
    where: { id: { in: ids } }
  });
  
  fs.writeFileSync('my_temp_jobs.json', JSON.stringify(jobs, null, 2));
}

main().catch(console.error).finally(() => prisma.$disconnect());
