import 'dotenv/config';

import fs from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const apply = process.argv.slice(2).includes('--apply');

async function main() {
  const [activeRequests, activeInbox, activeLeases] = await Promise.all([
    prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS count FROM "NativeScoringRequest"
      WHERE status IN ('queued', 'running')
        AND (phase ILIKE '%wildcard%' OR "wildcardBatchId" IS NOT NULL)
    `,
    prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS count FROM "Job"
      WHERE "luckyStatus" IN ('inbox', 'pending', 'queued', 'scoring')
    `,
    prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS count FROM "Job" WHERE "luckyBatchId" IS NOT NULL
    `,
  ]);
  const blockers = {
    activeRequests: Number(activeRequests[0]?.count || 0),
    activeInbox: Number(activeInbox[0]?.count || 0),
    activeLeases: Number(activeLeases[0]?.count || 0),
  };
  console.log(JSON.stringify({ safe: Object.values(blockers).every((count) => count === 0), blockers }, null, 2));
  if (Object.values(blockers).some((count) => count > 0)) {
    throw new Error('Contract cleanup aborted because active legacy scoring state still exists.');
  }
  if (!apply) {
    console.log('Preflight passed. Re-run with --apply only after the runtime-removal release is deployed.');
    return;
  }
  const sql = fs.readFileSync(
    path.join(process.cwd(), 'prisma/contracts/20260804_remove_wildcard.sql'),
    'utf8',
  );
  const statements = sql.split(';').map((statement) => statement.trim()).filter(Boolean);
  await prisma.$transaction(async (tx) => {
    for (const statement of statements) await tx.$executeRawUnsafe(statement);
  }, { timeout: 60_000 });
  console.log('Legacy scoring columns and profile/query tables were removed; historical JobScoreEvent rows were preserved.');
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
