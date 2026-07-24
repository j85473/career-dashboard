import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
  const job = await prisma.job.findUnique({ where: { id: '27129783-17d3-40b5-962f-f58ea47cb0e9' }});
  console.log('Status:', job?.status);
  console.log('Title:', job?.title);
  console.log('Company:', job?.company);
}
main().catch(console.error).finally(() => prisma.$disconnect());
