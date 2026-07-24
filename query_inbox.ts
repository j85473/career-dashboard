import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
  const verkadaInbox = await prisma.job.findMany({
    where: { company: { contains: 'verkada', mode: 'insensitive' }, OR: [{ status: 'inbox' }, { luckyStatus: 'inbox' }] }
  });
  console.log("Verkada inbox jobs:", verkadaInbox);
}
main().catch(console.error).finally(() => prisma.$disconnect());
