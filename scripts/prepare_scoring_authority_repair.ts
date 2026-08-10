import 'dotenv/config';

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { Prisma, PrismaClient } from '@prisma/client';
import * as mammoth from 'mammoth';

const prisma = new PrismaClient();

const INVALID_PROMPT_VERSION = 'standard-job-evaluator-v6.7.1';
const REPAIR_ID = 'canonical-workday-resume-2026-08-09';
const EXPECTED_RESUME_PATH = path.resolve('data/resumes/JosephLamb_Resume.docx');
const EXPECTED_RESUME_SHA256 = '23ceb1cb09d9ec8d0350ae4da96da018b26517c0f9b58dbe2762f0e44e0ad059';
const EXPECTED_FORMAL_TITLE = 'Field Sales Representative — Channel Sales';
const FORBIDDEN_SUBSTITUTED_TITLE = 'Channel Account Manager';

type Arguments = {
  apply: boolean;
  confirmSelection?: string;
};

function parseArguments(argv: string[]): Arguments {
  const parsed: Arguments = { apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--apply') {
      parsed.apply = true;
    } else if (argument === '--confirm-selection') {
      parsed.confirmSelection = argv[index + 1] || '';
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (parsed.apply && !/^[a-f0-9]{64}$/i.test(parsed.confirmSelection || '')) {
    throw new Error('Apply mode requires the exact dry-run hash with --confirm-selection <sha256>');
  }
  return parsed;
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function assertCanonicalResume(): Promise<void> {
  if (!fs.existsSync(EXPECTED_RESUME_PATH)) {
    throw new Error(`Canonical scoring resume is missing: ${EXPECTED_RESUME_PATH}`);
  }
  const bytes = fs.readFileSync(EXPECTED_RESUME_PATH);
  const actualHash = sha256(bytes);
  if (actualHash !== EXPECTED_RESUME_SHA256) {
    throw new Error(`Canonical scoring resume hash mismatch: expected ${EXPECTED_RESUME_SHA256}, received ${actualHash}`);
  }

  const extracted = (await mammoth.extractRawText({ buffer: bytes })).value.replace(/\s+/g, ' ').trim();
  if (!extracted.includes(EXPECTED_FORMAL_TITLE)) {
    throw new Error(`Canonical scoring resume is missing the formal title: ${EXPECTED_FORMAL_TITLE}`);
  }
  if (extracted.includes(FORBIDDEN_SUBSTITUTED_TITLE)) {
    throw new Error(`Canonical scoring resume contains the substituted title: ${FORBIDDEN_SUBSTITUTED_TITLE}`);
  }
}

type RepairScoreEvent = {
  id: string;
  jobId: string;
  passed: boolean;
  aimFitScore: number | null;
  experienceFitScore: number | null;
  travelScore: number | null;
  createdAt: Date;
};

type RepairJob = {
  id: string;
  status: string;
  scoringStatus: string;
  tailoringStaged: boolean;
  fitCategory: string;
  passReason: string | null;
  aimFitScore: number | null;
  reqFitScore: number | null;
  travelScore: number | null;
  updatedAt: Date;
};

type SelectionPlan = {
  jobId: string;
  action: 'preserve_visible_inbox' | 'rerun_local_then_native' | 'protect';
  reason: string;
  status: string;
  scoringStatus: string;
  updatedAt: string;
  latestInvalidEventId: string | null;
  latestStandardEventId: string | null;
  latestHumanDecisionEventId: string | null;
};

function stableSelectionHash(eventIds: string[], plan: SelectionPlan[]): string {
  return sha256(`${JSON.stringify({
    repairId: REPAIR_ID,
    promptVersion: INVALID_PROMPT_VERSION,
    eventIds: [...eventIds].sort(),
    plan: [...plan].sort((left, right) => left.jobId.localeCompare(right.jobId)),
  })}\n`);
}

function replayProtectionReason(input: {
  job: RepairJob;
  latestInvalid: RepairScoreEvent | undefined;
  latestStandard: RepairScoreEvent | undefined;
  hasHumanDecision: boolean;
  hasLaterStatusTransition: boolean;
}): string | null {
  const { job, latestInvalid, latestStandard } = input;
  if (job.tailoringStaged) return 'tailoring_staged';
  if (input.hasHumanDecision) return 'immutable_human_decision';
  if (input.hasLaterStatusTransition) return 'later_lifecycle_transition';
  if (job.fitCategory === 'promoted' || /^Promoted by user:/i.test(job.passReason || '')) return 'human_promotion_marker';
  if (!latestInvalid || !latestStandard || latestInvalid.id !== latestStandard.id) return 'newer_or_missing_standard_score';
  if (
    job.aimFitScore !== latestInvalid.aimFitScore
    || job.reqFitScore !== latestInvalid.experienceFitScore
    || job.travelScore !== latestInvalid.travelScore
  ) {
    return 'current_scalar_scores_do_not_match_invalid_event';
  }
  // A score that passed but is now dismissed/passed/cooldown reflects a later
  // human or lifecycle decision. Invalidate the defective provenance, but do
  // not reopen the job merely to obtain a replacement score.
  if (latestInvalid.passed && job.status !== 'inbox' && job.status !== 'pending_af') return 'passed_score_with_later_nonactive_status';
  if (!['inbox', 'dismissed', 'pending_af'].includes(job.status)) return 'protected_lifecycle_status';
  return null;
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  await assertCanonicalResume();

  const [schema] = await prisma.$queryRaw<Array<{ scoreStaleness: boolean; pipelineEvents: boolean }>>`
    SELECT
      EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'JobScoreEvent' AND column_name = 'staleAt'
      ) AS "scoreStaleness",
      to_regclass('"JobPipelineEvent"') IS NOT NULL AS "pipelineEvents";
  `;
  if (args.apply && (!schema?.scoreStaleness || !schema?.pipelineEvents)) {
    throw new Error('Apply mode requires the expand migration (score staleness and pipeline-event schema)');
  }

  const events: RepairScoreEvent[] = schema?.scoreStaleness
    ? await prisma.jobScoreEvent.findMany({
        where: {
          evaluationType: 'standard',
          promptVersion: INVALID_PROMPT_VERSION,
          staleAt: null,
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          jobId: true,
          passed: true,
          aimFitScore: true,
          experienceFitScore: true,
          travelScore: true,
          createdAt: true,
        },
      })
    : await prisma.$queryRaw<RepairScoreEvent[]>`
        SELECT id, "jobId", passed, "aimFitScore", "experienceFitScore", "travelScore", "createdAt"
        FROM "JobScoreEvent"
        WHERE "evaluationType" = 'standard'
          AND "promptVersion" = ${INVALID_PROMPT_VERSION}
        ORDER BY "createdAt" ASC, id ASC;
      `;
  const jobIds = [...new Set(events.map((event) => event.jobId))].sort();
  const jobs = jobIds.length === 0 ? [] : await prisma.job.findMany({
    where: { id: { in: jobIds } },
    orderBy: { id: 'asc' },
    select: {
      id: true,
      title: true,
      company: true,
      status: true,
      scoringStatus: true,
      tailoringStaged: true,
      fitCategory: true,
      passReason: true,
      aimFitScore: true,
      reqFitScore: true,
      travelScore: true,
      experienceStatus: true,
      updatedAt: true,
    },
  });
  const latestStandardRows: RepairScoreEvent[] = jobIds.length > 0
    ? await prisma.$queryRaw<RepairScoreEvent[]>(Prisma.sql`
        SELECT DISTINCT ON ("jobId")
          id, "jobId", passed, "aimFitScore", "experienceFitScore", "travelScore", "createdAt"
        FROM "JobScoreEvent"
        WHERE "jobId" IN (${Prisma.join(jobIds)})
          AND "evaluationType" IN ('standard', 'ae_fit')
        ORDER BY "jobId", "createdAt" DESC, id DESC
      `)
    : [];
  const userDecisionRows = schema?.pipelineEvents && jobIds.length > 0
    ? await prisma.jobPipelineEvent.findMany({
        where: {
          jobId: { in: jobIds },
          eventType: { in: ['user_promote', 'user_reject'] },
        },
        orderBy: [{ jobId: 'asc' }, { occurredAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
        distinct: ['jobId'],
        select: { id: true, jobId: true },
      })
    : [];
  const latestUserDecisionByJob = new Map(
    userDecisionRows.flatMap((row) => row.jobId ? [[row.jobId, row.id] as const] : []),
  );
  const latestInvalidByJob = new Map<string, RepairScoreEvent>();
  for (const event of events) latestInvalidByJob.set(event.jobId, event);
  const latestStandardByJob = new Map(latestStandardRows.map((event) => [event.jobId, event]));
  const statusHistoryRows = jobIds.length > 0
    ? await prisma.jobStatusHistory.findMany({
        where: { jobId: { in: jobIds } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { jobId: true, createdAt: true },
      })
    : [];
  const laterStatusTransitionJobIds = new Set<string>();
  for (const history of statusHistoryRows) {
    const invalid = latestInvalidByJob.get(history.jobId);
    if (invalid && history.createdAt.getTime() > invalid.createdAt.getTime() + 1_000) {
      laterStatusTransitionJobIds.add(history.jobId);
    }
  }
  const selectionPlan: SelectionPlan[] = jobs.map((job) => {
    const latestInvalid = latestInvalidByJob.get(job.id);
    const latestStandard = latestStandardByJob.get(job.id);
    const protectionReason = replayProtectionReason({
      job,
      latestInvalid,
      latestStandard,
      hasHumanDecision: latestUserDecisionByJob.has(job.id),
      hasLaterStatusTransition: laterStatusTransitionJobIds.has(job.id),
    });
    return {
      jobId: job.id,
      action: protectionReason
        ? 'protect'
        : job.status === 'inbox' ? 'preserve_visible_inbox' : 'rerun_local_then_native',
      reason: protectionReason || 'latest_invalid_score_is_current_machine_state',
      status: job.status,
      scoringStatus: job.scoringStatus,
      updatedAt: job.updatedAt.toISOString(),
      latestInvalidEventId: latestInvalid?.id || null,
      latestStandardEventId: latestStandard?.id || null,
      latestHumanDecisionEventId: latestUserDecisionByJob.get(job.id) || null,
    };
  });
  const planByJob = new Map(selectionPlan.map((plan) => [plan.jobId, plan]));
  const replayJobs = jobs.filter((job) => planByJob.get(job.id)?.action !== 'protect');
  const protectedJobs = jobs.filter((job) => planByJob.get(job.id)?.action === 'protect');
  const selectionHash = stableSelectionHash(
    events.map((event) => event.id),
    selectionPlan,
  );

  const report = {
    mode: args.apply ? 'apply' : 'dry-run',
    repairId: REPAIR_ID,
    invalidPromptVersion: INVALID_PROMPT_VERSION,
    selectionHash,
    canonicalResume: {
      path: path.relative(process.cwd(), EXPECTED_RESUME_PATH),
      sha256: EXPECTED_RESUME_SHA256,
      formalTitle: EXPECTED_FORMAL_TITLE,
    },
    events: {
      selected: events.length,
      uniqueJobs: jobIds.length,
      passes: events.filter((event) => event.passed).length,
    },
    replay: {
      selected: replayJobs.length,
      byCurrentStatus: Object.fromEntries(
        [...new Set(replayJobs.map((job) => job.status))]
          .sort()
          .map((status) => [status, replayJobs.filter((job) => job.status === status).length]),
      ),
      jobs: replayJobs.map((job) => ({ ...job, repairPlan: planByJob.get(job.id) })),
    },
    protected: {
      selected: protectedJobs.length,
      byCurrentStatus: Object.fromEntries(
        [...new Set(protectedJobs.map((job) => job.status))]
          .sort()
          .map((status) => [status, protectedJobs.filter((job) => job.status === status).length]),
      ),
      jobs: protectedJobs.map((job) => ({ ...job, repairPlan: planByJob.get(job.id) })),
    },
  };

  if (!args.apply) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.stderr.write(
      `Dry run only. Review selection hash ${selectionHash}, then rerun with --apply --confirm-selection ${selectionHash}.\n`,
    );
    return;
  }
  if (args.confirmSelection !== selectionHash) {
    throw new Error(`Selection changed: expected ${args.confirmSelection}, current ${selectionHash}. Run a new dry run.`);
  }

  const invalidatedAt = new Date();
  const staleReason = `${REPAIR_ID}: evaluator used a one-line resume variant that substituted Channel Account Manager for the canonical formal title.`;
  const inboxIds = replayJobs.filter((job) => job.status === 'inbox').map((job) => job.id);
  const localReplayIds = replayJobs.filter((job) => job.status !== 'inbox').map((job) => job.id);

  await prisma.$transaction(async (tx) => {
    if (replayJobs.length > 0) {
      const unchangedJobs = await tx.job.count({
        where: {
          OR: replayJobs.map((job) => ({ id: job.id, updatedAt: job.updatedAt })),
        },
      });
      if (unchangedJobs !== replayJobs.length) {
        throw new Error('A replay candidate changed after selection; transaction aborted');
      }
      const humanDecisions = await tx.jobPipelineEvent.count({
        where: {
          jobId: { in: replayJobs.map((job) => job.id) },
          eventType: { in: ['user_promote', 'user_reject'] },
        },
      });
      if (humanDecisions > 0) {
        throw new Error('A replay candidate now has an immutable human-decision event; transaction aborted');
      }
      const latestScores = await tx.jobScoreEvent.findMany({
        where: {
          jobId: { in: replayJobs.map((job) => job.id) },
          evaluationType: { in: ['standard', 'ae_fit'] },
        },
        orderBy: [{ jobId: 'asc' }, { createdAt: 'desc' }, { id: 'desc' }],
        distinct: ['jobId'],
        select: { id: true, jobId: true },
      });
      if (latestScores.length !== replayJobs.length || latestScores.some((event) => (
        planByJob.get(event.jobId)?.latestStandardEventId !== event.id
      ))) {
        throw new Error('A replay candidate received a newer standard score after selection; transaction aborted');
      }
    }

    const invalidated = await tx.jobScoreEvent.updateMany({
      where: { id: { in: events.map((event) => event.id) }, staleAt: null },
      data: { staleAt: invalidatedAt, staleReason },
    });
    if (invalidated.count !== events.length) {
      throw new Error(`Expected to invalidate ${events.length} score events, invalidated ${invalidated.count}`);
    }

    if (events.length > 0) {
      await tx.jobPipelineEvent.createMany({
        data: events.map((event) => ({
          eventKey: `score-invalidated:${REPAIR_ID}:${event.id}`,
          jobId: event.jobId,
          eventType: 'score_invalidated',
          stage: 'native_scoring',
          details: {
            repairId: REPAIR_ID,
            invalidPromptVersion: INVALID_PROMPT_VERSION,
            invalidatedEventId: event.id,
            staleReason,
          } satisfies Prisma.InputJsonValue,
          occurredAt: invalidatedAt,
        })),
        skipDuplicates: true,
      });
    }

    if (inboxIds.length > 0) {
      const updated = await tx.job.updateMany({
        where: {
          id: { in: inboxIds },
          status: 'inbox',
          tailoringStaged: false,
          fitCategory: { not: 'promoted' },
          OR: [
            { passReason: null },
            { NOT: { passReason: { startsWith: 'Promoted by user:', mode: 'insensitive' } } },
          ],
        },
        data: {
          experienceStatus: 'rescore_queued',
          afBatchId: null,
          scoreError: null,
          deepseekScoreError: null,
        },
      });
      if (updated.count !== inboxIds.length) {
        throw new Error('An Inbox job changed or was human-promoted after the dry run; transaction aborted');
      }
    }

    if (localReplayIds.length > 0) {
      const updated = await tx.job.updateMany({
        where: {
          id: { in: localReplayIds },
          status: { in: ['dismissed', 'pending_af'] },
          tailoringStaged: false,
          fitCategory: { not: 'promoted' },
          OR: [
            { passReason: null },
            { NOT: { passReason: { startsWith: 'Promoted by user:', mode: 'insensitive' } } },
          ],
        },
        data: {
          status: 'pending_af',
          scoringStatus: 'queued',
          batchJobId: null,
          jdBatchId: null,
          afBatchId: null,
          aimFitScore: null,
          reqFitScore: null,
          reqFitRationale: null,
          travelScore: null,
          experienceStatus: 'queued',
          scoreAttempts: 0,
          scoreError: null,
          deepseekScoreError: null,
        },
      });
      if (updated.count !== localReplayIds.length) {
        throw new Error('A replay candidate changed or was human-promoted after the dry run; transaction aborted');
      }
    }

    if (replayJobs.length > 0) {
      await tx.jobPipelineEvent.createMany({
        data: replayJobs.map((job) => ({
          eventKey: `score-replay-queued:${REPAIR_ID}:${job.id}`,
          jobId: job.id,
          eventType: 'score_replay_queued',
          stage: 'native_scoring',
          details: {
            repairId: REPAIR_ID,
            priorStatus: job.status,
            replayPath: job.status === 'inbox' ? 'preserve_visible_inbox' : 'rerun_local_then_native',
          } satisfies Prisma.InputJsonValue,
          occurredAt: invalidatedAt,
        })),
        skipDuplicates: true,
      });
    }
  }, {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    maxWait: 15_000,
    timeout: 300_000,
  });

  process.stdout.write(`${JSON.stringify({ ...report, appliedAt: invalidatedAt.toISOString() }, null, 2)}\n`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
