import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
  const verkadaApplied = await prisma.job.findMany({
    where: { company: { contains: 'verkada', mode: 'insensitive' }, status: { in: ['applied', 'interviewing'] } }
  });
  console.log("Verkada applied jobs:", verkadaApplied);
}
main().catch(console.error).finally(() => prisma.$disconnect());
