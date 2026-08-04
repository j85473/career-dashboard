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
  const [contextLeases, standardLeases, scoreEvents, contextRevisions] = await Promise.all([
    prisma.job.count({ where: { contextBatchId: batchId } }),
    prisma.job.count({ where: { afBatchId: batchId } }),
    prisma.jobScoreEvent.count({
      where: {
        OR: [
          { batchId },
          { idempotencyKey: { startsWith: `${batchId}:` } },
          // Preserve compatibility with V6.1 events that stored the batch ID
          // directly in requestId.
          { requestId: batchId },
        ],
      },
    }),
    prisma.contextRuleRevision.count({ where: { batchId } }),
  ]);

  console.log(`Batch: ${batchId}`);
  console.log(`Context leases: ${contextLeases}`);
  console.log(`Standard leases: ${standardLeases}`);
  console.log(`Existing score events: ${scoreEvents}`);
  console.log(`Existing context revisions: ${contextRevisions}`);

  if (scoreEvents > 0 || contextRevisions > 0) {
    throw new Error('This batch has applied provenance records and cannot be released as abandoned');
  }
  if (!apply) {
    console.log('Dry run only. Re-run with --apply to release these leases.');
    return;
  }

  const [releasedContext, releasedStandard] = await prisma.$transaction([
    prisma.job.updateMany({
      where: { contextBatchId: batchId },
      data: { contextBatchId: null },
    }),
    prisma.job.updateMany({
      where: { afBatchId: batchId },
      data: { afBatchId: null },
    }),
  ]);

  let requestId: string | null = null;
  if (fs.existsSync(lockPath)) {
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { batchId?: unknown };
    if (typeof (lock as { requestId?: unknown }).requestId === 'string') {
      requestId = (lock as { requestId: string }).requestId;
    }
    if (lock.batchId === batchId) {
      fs.unlinkSync(lockPath);
    }
  }
  if (requestId) {
    await prisma.nativeScoringRequest.updateMany({
      where: { id: requestId, status: { in: ['queued', 'running', 'failed'] } },
      data: {
        status: 'failed',
        progress: 'The active phase was explicitly released; retry will prepare a fresh phase.',
        error: 'Native scoring phase was explicitly released.',
      },
    });
  }
  console.log(
    `Released ${releasedContext.count} context and ${releasedStandard.count} standard leases. Artifacts were preserved.`,
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
