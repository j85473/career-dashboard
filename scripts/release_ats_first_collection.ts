/** Preview by default; --apply releases only untouched boards validated by --run-id. */
import { prisma } from '../src/lib/prisma';
import { firstCollectionCatchupQuery } from '../src/lib/atsFirstCollectionCatchup';

async function main(): Promise<void> {
  const runId = process.argv.find((argument) => argument.startsWith('--run-id='))?.slice(9) || '';
  const apply = process.argv.includes('--apply');
  const query = firstCollectionCatchupQuery(runId, apply);
  const boards = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL statement_timeout = '20s'`;
    return tx.$queryRaw<Array<{ slug: string; platform: string; previousNextCheckDate: Date }>>(query);
  }, { timeout: 25_000 });
  const byPlatform: Record<string, number> = {};
  for (const board of boards) byPlatform[board.platform] = (byPlatform[board.platform] || 0) + 1;
  console.log(JSON.stringify({ apply, runId, boards: boards.length, byPlatform, released: boards }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
