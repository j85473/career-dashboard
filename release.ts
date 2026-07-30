import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
prisma.job.updateMany({data: {afBatchId: null, luckyBatchId: null}})
  .then(res => console.log('Released', res))
  .finally(() => prisma.$disconnect());
