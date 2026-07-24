import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const job = await prisma.job.findUnique({
    where: { id: 'd2ebbd8c-6151-4a38-a83e-5724ec83bbdf' },
    select: { url: true, canonicalUrl: true, source: true }
  });
  console.log('Job:', job);
}

main().catch(console.error).finally(() => prisma.$disconnect());
