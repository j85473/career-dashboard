import { prisma } from './src/lib/prisma';
async function main() {
  const id = '6c95f324-b831-4b93-9540-81147e35d581';
  const job = await prisma.job.findUnique({ where: { id } });
  console.log('Current job:', { tailoringStaged: job?.tailoringStaged, status: job?.status });
}
main().catch(console.error).finally(() => prisma.$disconnect());
