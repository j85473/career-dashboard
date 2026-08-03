import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  console.log('Starting job label migration...');

  // 1. Fix pending_user -> inbox
  const res1 = await prisma.$executeRawUnsafe(`
    UPDATE "Job" 
    SET status = 'inbox' 
    WHERE status = 'pending_user'
  `);
  console.log(`Updated ${res1} jobs from 'pending_user' to 'inbox'.`);

  // 2. Fix Failed -> dismissed
  const res2 = await prisma.$executeRawUnsafe(`
    UPDATE "Job" 
    SET status = 'dismissed' 
    WHERE status = 'Failed'
  `);
  console.log(`Updated ${res2} jobs from 'Failed' to 'dismissed'.`);



  console.log('Migration complete!');
}

main().catch(console.error).finally(() => prisma.$disconnect());
