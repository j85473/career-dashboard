import 'dotenv/config';
import { prisma } from '../src/lib/prisma';
import { Prisma } from '../src/lib/prismaClient';
import { BROWSER_ATS_PLATFORMS } from '../src/lib/browserAtsBoards';

// Release only the exact first-retry delay created by an API routing error.
// Browser attempts, acquired data, completed boards and operator dates remain protected.
const eligible = Prisma.sql`
  board.platform IN (${Prisma.join(BROWSER_ATS_PLATFORMS)})
  AND board.status IN ('active','parked')
  AND board."lastSynchronizedAt" IS NULL
  AND board."failCount"=1 AND board."retryCount"=1
  AND board."nextCheckDate"=board."lastAttemptedAt" + INTERVAL '15 minutes'
  AND NOT EXISTS (SELECT 1 FROM "AtsBrowserSweep" sweep
    WHERE sweep.slug=board.slug AND sweep.platform=board.platform)
  AND EXISTS (SELECT 1 FROM "AtsIngestionBatch" batch
    WHERE batch.slug=board.slug AND batch.platform=board.platform
      AND batch."writerMode"='v2'
      AND batch."lastError"='Unsupported ATS platform: ' || board.platform
      AND batch."jobCount"=0 AND batch."rawObservationCount"=0
      AND batch."acquisitionBytes"=0 AND batch."respondedAt" IS NULL
      AND (batch."acquisitionClaimToken" IS NULL OR batch."acquisitionLeaseExpiresAt"<=CURRENT_TIMESTAMP))
  AND NOT EXISTS (SELECT 1 FROM "AtsIngestionBatch" batch
    WHERE batch.slug=board.slug AND batch.platform=board.platform
      AND (batch."jobCount">0 OR batch."rawObservationCount">0 OR batch."acquisitionBytes">0))
`;
async function main() {
    if (process.argv.slice(2).some(arg => arg !== '--apply'))
        throw Error('Usage: release_browser_ats_routing_holds.ts [--apply]');
    const apply = process.argv.includes('--apply');
    const rows = await prisma.$queryRaw<Array<{ platform: string; count: number }>>(apply ? Prisma.sql`
      WITH repaired AS (
        UPDATE "AtsCompany" board
        SET "failCount"=0,"retryCount"=0,"nextCheckDate"=CURRENT_TIMESTAMP AT TIME ZONE 'UTC'
        WHERE ${eligible} RETURNING platform
      ) SELECT platform,COUNT(*)::int AS count FROM repaired GROUP BY platform ORDER BY platform
    ` : Prisma.sql`
      SELECT platform,COUNT(*)::int AS count FROM "AtsCompany" board
      WHERE ${eligible} GROUP BY platform ORDER BY platform
    `);
    console.log(JSON.stringify({ apply, boards: rows.reduce((sum, row) => sum + row.count, 0), platforms: rows }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
