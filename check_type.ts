import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function run() {
  const result = await prisma.$queryRawUnsafe(`
    SELECT column_name, data_type 
    FROM information_schema.columns 
    WHERE table_name = 'Job' AND column_name = 'id';
  `);
  console.log(result);
}
run().finally(() => prisma.$disconnect());
