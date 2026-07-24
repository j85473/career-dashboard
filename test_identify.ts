import { identifyAts } from './src/lib/atsUtils';
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
  const job = await prisma.job.findUnique({ where: { id: 'f0336672-284e-43ae-9e28-b7583767dd04' }});
  
  // Test with original values (before manualAts was set)
  const testJob = {
    url: job?.url,
    source: job?.source,
    manualAts: null
  };
  console.log('Original testJob:', testJob);
  console.log('identifyAts returns:', identifyAts(testJob));
}
main().catch(console.error).finally(() => prisma.$disconnect());
