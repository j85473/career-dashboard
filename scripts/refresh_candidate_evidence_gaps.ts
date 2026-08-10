import 'dotenv/config';

import { PrismaClient } from '@prisma/client';

import { refreshEvidenceGapReport } from '../src/lib/candidateEvidenceGaps';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const result = await refreshEvidenceGapReport(prisma);
  console.log(`Validated and refreshed ${result.reportPath} (${result.conceptCount} active concepts).`);
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
