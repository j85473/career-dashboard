import 'dotenv/config';

import { createHash } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const SOURCE_REQUEST_ID = 'efef76fc-4171-4c16-8772-a6cb130b2df5';
const QUEUE_LIMIT = 250;
const TARGET_TITLE = /\b(?:account executive|account director|account manager|customer success|client success|channel|partner(?:ship)?s?|territory|regional sales|district sales|sales manager|field sales|business development|client partner|commercial)\b/i;

const resetScores = {
  aimFitScore: null,
  reqFitScore: null,
  reqFitRationale: null,
  travelScore: null,
  experienceStatus: 'queued',
  luckyStatus: 'none',
  luckyAimFitScore: null,
  luckyFitScore: null,
  luckyFitCategory: 'unscored',
  luckyPassReason: null,
  luckyBatchId: null,
  luckyScoreError: null,
  afBatchId: null,
  scoreError: null,
  deepseekScoreError: null,
} as const;

async function buildSelection(tx: Prisma.TransactionClient | PrismaClient) {
  const request = await tx.nativeScoringRequest.findUnique({ where: { id: SOURCE_REQUEST_ID } });
  if (!request || request.status !== 'completed') {
    throw new Error(`Completed source request ${SOURCE_REQUEST_ID} was not found`);
  }

  const sourceScores = await tx.jobScoreEvent.findMany({
    where: { requestId: SOURCE_REQUEST_ID, evaluationType: 'standard' },
    select: { jobId: true, aimFitScore: true, experienceFitScore: true },
  });
  if (sourceScores.length !== 614) {
    throw new Error(`Expected 614 standard results in the source request; found ${sourceScores.length}`);
  }

  const sourceIds = sourceScores.map((event) => event.jobId);
  const priorScores = await tx.jobScoreEvent.findMany({
    where: {
      jobId: { in: sourceIds },
      evaluationType: 'standard',
      createdAt: { lt: request.createdAt },
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { jobId: true, passed: true },
  });
  const latestPriorPass = new Map<string, boolean>();
  for (const event of priorScores) {
    if (!latestPriorPass.has(event.jobId)) latestPriorPass.set(event.jobId, event.passed);
  }
  const priorDismissalIds = sourceIds.filter((id) => latestPriorPass.get(id) === false);

  const eligibleJobs = await tx.job.findMany({
    where: {
      id: { in: priorDismissalIds },
      status: 'dismissed',
      scoringStatus: 'scored',
      tailoringStaged: false,
      jdBatchId: null,
      batchJobId: null,
      afBatchId: null,
      luckyBatchId: null,
    },
    select: { id: true, title: true, company: true },
  });
  const sourceScoreByJob = new Map(sourceScores.map((event) => [event.jobId, event]));
  const selected = eligibleJobs
    .sort((left, right) => {
      const leftTarget = TARGET_TITLE.test(left.title) ? 1 : 0;
      const rightTarget = TARGET_TITLE.test(right.title) ? 1 : 0;
      const leftScore = sourceScoreByJob.get(left.id);
      const rightScore = sourceScoreByJob.get(right.id);
      return rightTarget - leftTarget
        || (rightScore?.experienceFitScore || 0) - (leftScore?.experienceFitScore || 0)
        || (rightScore?.aimFitScore || 0) - (leftScore?.aimFitScore || 0)
        || left.id.localeCompare(right.id);
    })
    .slice(0, QUEUE_LIMIT);

  if (selected.length !== QUEUE_LIMIT) {
    throw new Error(`Expected ${QUEUE_LIMIT} eligible recovery jobs; found ${selected.length}`);
  }
  return {
    selected,
    eligibleCount: eligibleJobs.length,
    selectionHash: createHash('sha256').update(selected.map((job) => job.id).join('\n')).digest('hex'),
  };
}

async function main(): Promise<void> {
  const apply = process.argv.slice(2).includes('--apply');
  if (process.argv.slice(2).some((argument) => argument !== '--apply')) {
    throw new Error('Usage: scoring:queue:sellsig-recovery -- [--apply]');
  }

  const preview = await buildSelection(prisma);
  const inboxCount = await prisma.job.count({ where: { status: 'inbox', tailoringStaged: false } });
  const stagedCount = await prisma.job.count({ where: { status: 'inbox', tailoringStaged: true } });
  if (!apply) {
    console.log(JSON.stringify({
      apply: false,
      sourceRequestId: SOURCE_REQUEST_ID,
      eligibleRecoveryJobs: preview.eligibleCount,
      selectedJobs: preview.selected.length,
      selectionHash: preview.selectionHash,
      reviewInboxToClear: inboxCount,
      tailoringJobsPreserved: stagedCount,
      sample: preview.selected.slice(0, 10),
    }, null, 2));
    return;
  }

  const result = await prisma.$transaction(async (tx) => {
    const [activeRequest, existingQueue, selection] = await Promise.all([
      tx.nativeScoringRequest.findUnique({ where: { activeKey: 'global' }, select: { id: true } }),
      tx.job.count({
        where: {
          status: { in: ['inbox', 'pending_af'] },
          scoringStatus: 'scored',
          jdBatchId: null,
          batchJobId: null,
          afBatchId: null,
          aimFitScore: null,
        },
      }),
      buildSelection(tx),
    ]);
    if (activeRequest) throw new Error(`Agy request ${activeRequest.id} is active`);
    if (existingQueue !== 0) throw new Error(`Expected an empty standard queue; found ${existingQueue} job(s)`);
    if (selection.selectionHash !== preview.selectionHash) {
      throw new Error('Recovery selection changed between preview and transaction');
    }

    const clearedInbox = await tx.job.updateMany({
      where: { status: 'inbox', tailoringStaged: false },
      data: {
        ...resetScores,
        status: 'dismissed',
        passReason: 'Invalidated: rescoring requires the SellSig/CS baseline resume',
      },
    });
    const queued = await tx.job.updateMany({
      where: {
        id: { in: selection.selected.map((job) => job.id) },
        status: 'dismissed',
        tailoringStaged: false,
        jdBatchId: null,
        batchJobId: null,
        afBatchId: null,
        luckyBatchId: null,
      },
      data: {
        ...resetScores,
        status: 'pending_af',
        passReason: null,
      },
    });
    if (queued.count !== QUEUE_LIMIT) {
      throw new Error(`Atomic queue update selected ${QUEUE_LIMIT} jobs but changed ${queued.count}`);
    }
    return {
      clearedInbox: clearedInbox.count,
      queued: queued.count,
      tailoringJobsPreserved: stagedCount,
      selectionHash: selection.selectionHash,
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 15_000, timeout: 60_000 });

  console.log(JSON.stringify({ apply: true, ...result }, null, 2));
}

main()
  .catch((error) => {
    console.error(`SellSig/CS recovery queue failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
