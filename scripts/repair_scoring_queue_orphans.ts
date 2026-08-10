import 'dotenv/config';

import { createHash } from 'node:crypto';

import { Prisma, PrismaClient } from '@prisma/client';

import { isScorableJobDescription } from '../src/lib/jobDescriptionQuality';

const prisma = new PrismaClient();
const REPAIR_ID = 'scoring-queue-orphans-2026-08-09';

type Arguments = { apply: boolean; confirmSelection?: string };

function parseArguments(argv: string[]): Arguments {
  const parsed: Arguments = { apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--apply') {
      parsed.apply = true;
    } else if (argv[index] === '--confirm-selection') {
      parsed.confirmSelection = argv[index + 1] || '';
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argv[index]}`);
    }
  }
  if (parsed.apply && !/^[a-f0-9]{64}$/i.test(parsed.confirmSelection || '')) {
    throw new Error('Apply mode requires --confirm-selection <dry-run-sha256>');
  }
  return parsed;
}

type QueueRepairSelection = {
  id: string;
  action: 'needs_jd' | 'queued';
  status: string;
  scoringStatus: string;
  scoreAttempts: number;
  updatedAt: string;
};

function selectionHash(rows: QueueRepairSelection[]): string {
  return createHash('sha256')
    .update(`${JSON.stringify({ repairId: REPAIR_ID, rows: [...rows].sort((a, b) => a.id.localeCompare(b.id)) })}\n`)
    .digest('hex');
}

function needsJdReview(description: string | null): boolean {
  return !isScorableJobDescription(description || '');
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const [schema] = await prisma.$queryRaw<Array<{ pipelineEvents: boolean }>>`
    SELECT to_regclass('"JobPipelineEvent"') IS NOT NULL AS "pipelineEvents";
  `;
  if (args.apply && !schema?.pipelineEvents) {
    throw new Error('Apply mode requires the expand migration (JobPipelineEvent is missing)');
  }
  const candidates = await prisma.job.findMany({
    where: {
      status: 'pending_af',
      tailoringStaged: false,
      batchJobId: null,
      jdBatchId: null,
      afBatchId: null,
      OR: [
        { scoringStatus: 'failed' },
        { scoringStatus: 'skipped' },
      ],
    },
    orderBy: { id: 'asc' },
    select: {
      id: true,
      title: true,
      company: true,
      source: true,
      status: true,
      scoringStatus: true,
      scoreAttempts: true,
      scoreError: true,
      passReason: true,
      description: true,
      updatedAt: true,
    },
  });
  const repairs = candidates.map((job) => ({
    ...job,
    action: needsJdReview(job.description) ? 'needs_jd' as const : 'queued' as const,
  }));
  const selected: QueueRepairSelection[] = repairs.map((job) => ({
    id: job.id,
    action: job.action,
    status: job.status,
    scoringStatus: job.scoringStatus,
    scoreAttempts: job.scoreAttempts,
    updatedAt: job.updatedAt.toISOString(),
  }));
  const hash = selectionHash(selected);
  const report = {
    mode: args.apply ? 'apply' : 'dry-run',
    repairId: REPAIR_ID,
    selectionHash: hash,
    selected: repairs.length,
    actions: {
      queued: repairs.filter((job) => job.action === 'queued').length,
      needsJd: repairs.filter((job) => job.action === 'needs_jd').length,
    },
    jobs: repairs.map(({ description: _description, ...job }) => job),
  };

  if (!args.apply) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.stderr.write(
      `Dry run only. Review selection hash ${hash}, then rerun with --apply --confirm-selection ${hash}.\n`,
    );
    return;
  }
  if (args.confirmSelection !== hash) {
    throw new Error(`Selection changed: expected ${args.confirmSelection}, current ${hash}. Run a new dry run.`);
  }

  const repairedAt = new Date();
  await prisma.$transaction(async (tx) => {
    for (const repair of repairs) {
      const update = await tx.job.updateMany({
        where: {
          id: repair.id,
          status: 'pending_af',
          tailoringStaged: false,
          scoringStatus: repair.scoringStatus,
          scoreAttempts: repair.scoreAttempts,
          updatedAt: repair.updatedAt,
          batchJobId: null,
          jdBatchId: null,
          afBatchId: null,
        },
        data: {
          scoringStatus: repair.action,
          scoreAttempts: 0,
          scoreError: null,
          deepseekScoreAttempts: 0,
          deepseekScoreError: null,
        },
      });
      if (update.count !== 1) {
        throw new Error(`Queue state changed while repairing ${repair.id}; transaction aborted`);
      }
      await tx.jobPipelineEvent.create({
        data: {
          eventKey: `score-replay-queued:${REPAIR_ID}:${repair.id}`,
          jobId: repair.id,
          eventType: 'score_replay_queued',
          stage: repair.action === 'needs_jd' ? 'jd_extraction' : 'local_scoring',
          details: {
            repairId: REPAIR_ID,
            priorScoringStatus: repair.scoringStatus,
            priorScoreAttempts: repair.scoreAttempts,
            nextScoringStatus: repair.action,
          } satisfies Prisma.InputJsonValue,
          occurredAt: repairedAt,
        },
      });
    }
  });

  process.stdout.write(`${JSON.stringify({ ...report, appliedAt: repairedAt.toISOString() }, null, 2)}\n`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
