import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  await prisma.job.updateMany({
    where: { 
      company: 'Total Quality Logistics',
      title: 'Sales Representative - Uncapped Commission',
      status: 'inbox'
    },
    data: {
      status: 'passed',
      passReason: 'Already manually passed previously.'
    }
  });
  console.log("Restored TQL job to passed.");
}
main().catch(console.error).finally(() => prisma.$disconnect());
