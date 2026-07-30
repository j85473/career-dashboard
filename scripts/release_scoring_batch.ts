import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const projectRoot = process.cwd();
const lockPath = path.join(projectRoot, '.agents', 'scoring-lock.json');

function parseArguments(argv: string[]): { apply: boolean; batchId: string } {
  let apply = false;
  let batchId: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--apply') {
      apply = true;
    } else if (argv[index] === '--batch') {
      batchId = argv[index + 1] || null;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argv[index]}`);
    }
  }
  if (!batchId && fs.existsSync(lockPath)) {
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { batchId?: unknown };
    if (typeof lock.batchId === 'string') {
      batchId = lock.batchId;
    }
  }
  if (!batchId || !/^[A-Za-z0-9_-]{1,160}$/.test(batchId)) {
    throw new Error('Provide a safe batch ID with --batch, or prepare an active scoring run');
  }
  return { apply, batchId };
}

async function main(): Promise<void> {
  const { apply, batchId } = parseArguments(process.argv.slice(2));
  const [standardLeases, wildcardLeases, scoreEvents] = await Promise.all([
    prisma.job.count({ where: { afBatchId: batchId } }),
    prisma.job.count({ where: { luckyBatchId: batchId } }),
    prisma.jobScoreEvent.count({ where: { requestId: batchId } }),
  ]);

  console.log(`Batch: ${batchId}`);
  console.log(`Standard leases: ${standardLeases}`);
  console.log(`Wildcard leases: ${wildcardLeases}`);
  console.log(`Existing score events: ${scoreEvents}`);

  if (scoreEvents > 0) {
    throw new Error('This batch has score events and cannot be released as an abandoned run');
  }
  if (!apply) {
    console.log('Dry run only. Re-run with --apply to release these leases.');
    return;
  }

  const [releasedStandard, releasedWildcard] = await prisma.$transaction([
    prisma.job.updateMany({
      where: { afBatchId: batchId },
      data: { afBatchId: null },
    }),
    prisma.job.updateMany({
      where: { luckyBatchId: batchId },
      data: {
        luckyBatchId: null,
        luckyStatus: 'pending',
      },
    }),
  ]);

  if (fs.existsSync(lockPath)) {
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { batchId?: unknown };
    if (lock.batchId === batchId) {
      fs.unlinkSync(lockPath);
    }
  }
  console.log(
    `Released ${releasedStandard.count} standard and ${releasedWildcard.count} wildcard leases. Artifacts were preserved.`,
  );
}

main()
  .catch((error: unknown) => {
    console.error(`Batch release failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
