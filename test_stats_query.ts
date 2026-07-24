import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
  try {
    const recentIngestionRuns = await prisma.ingestionSourceRun.findMany({
      distinct: ['source'],
      orderBy: [{ source: 'asc' }, { createdAt: 'desc' }],
      take: 30,
      select: {
        id: true,
        source: true,
        status: true,
        seenCount: true,
        insertedCount: true,
        duplicateCount: true,
        filteredCount: true,
        errorCount: true,
        error: true,
        finishedAt: true,
        durationMs: true,
        createdAt: true,
      }
    });
    console.log("Success! Count:", recentIngestionRuns.length);
  } catch (e) {
    console.error("Prisma error:", e);
  }
}
main().catch(console.error).finally(() => prisma.$disconnect());
