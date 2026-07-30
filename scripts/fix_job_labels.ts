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

  // 3. Fix wildcard -> inbox (if aimFitScore >= 50)
  const res3 = await prisma.$executeRawUnsafe(`
    UPDATE "Job" 
    SET status = 'inbox' 
    WHERE status = 'wildcard' AND "aimFitScore" >= 50
  `);
  console.log(`Updated ${res3} jobs from 'wildcard' to 'inbox'.`);

  // 4. Fix wildcard -> dismissed (if aimFitScore < 50 or null)
  const res4 = await prisma.$executeRawUnsafe(`
    UPDATE "Job" 
    SET status = 'dismissed' 
    WHERE status = 'wildcard'
  `);
  console.log(`Updated ${res4} jobs from 'wildcard' to 'dismissed'.`);

  console.log('Migration complete!');
}

main().catch(console.error).finally(() => prisma.$disconnect());
