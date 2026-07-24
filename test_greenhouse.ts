import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
  const job = await prisma.job.findUnique({ where: { id: 'f0336672-284e-43ae-9e28-b7583767dd04' }});
  console.log('Title:', job?.title);
  console.log('Company:', job?.company);
  console.log('URL:', job?.url);
  console.log('CanonicalUrl:', job?.canonicalUrl);
  console.log('ManualATS:', job?.manualAts);
}
main().catch(console.error).finally(() => prisma.$disconnect());
