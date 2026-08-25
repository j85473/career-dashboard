import 'dotenv/config';

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { Prisma, type PrismaClient } from '@prisma/client';

import { buildPipelineEventKey } from '../src/lib/ingestionControl';
import {
  EXPERIENCE_RERUN_COHORT,
  EXPERIENCE_RERUN_STALE_REASON,
  EXPERIENCE_RERUN_VERSION,
  experienceRerunGuardHash,
  planExperienceRerun,
  type ExperienceRerunEvidence,
  type ExperienceRerunPlan,
  type ExperienceRerunSpec,
} from '../src/lib/experienceRerunCohort';
import { assertJobLifecycleInvariants } from '../src/lib/jobLifecycleInvariant';
import { latestJobScoreEvents } from '../src/lib/jobScoreAuthorityQuery';
import { operationalQueueWhere } from '../src/lib/operationalQueue';
import { prisma } from '../src/lib/prisma';
import { resolveStagedScoreAuthority } from '../src/lib/scoreAuthority';
import { canonicalJsonSha256 } from '../src/lib/scoringCanonicalJson';
import { USER_LIFECYCLE_INTENT_EVENT_TYPES } from '../src/lib/userLifecycleAuthority';

type DbClient = PrismaClient | Prisma.TransactionClient;

const jobSelect = {
  id: true,
  status: true,
  scoringStatus: true,
  experienceStatus: true,
  tailoringStaged: true,
  source: true,
  sourceId: true,
  aimFitScore: true,
  reqFitScore: true,
  reqFitRationale: true,
  batchJobId: true,
  jdBatchId: true,
  afBatchId: true,
  updatedAt: true,
  pipelineEvents: {
    where: { eventType: { in: [...USER_LIFECYCLE_INTENT_EVENT_TYPES] } },
    orderBy: [{ occurredAt: 'desc' as const }, { id: 'desc' as const }],
    select: { id: true, eventType: true, occurredAt: true, details: true },
  },
  scoringBatchItems: {
    where: { status: 'leased' },
    select: { id: true },
  },
} satisfies Prisma.JobSelect;

async function loadEvidence(
  client: DbClient,
  spec: ExperienceRerunSpec,
): Promise<ExperienceRerunEvidence | null> {
  const job = await client.job.findUnique({ where: { id: spec.id }, select: jobSelect });
  if (!job) return null;
  const bundle = (await latestJobScoreEvents([spec.id], client)).get(spec.id) || null;
  const authority = bundle ? resolveStagedScoreAuthority(bundle) : null;
  return {
    current: {
      id: job.id,
      status: job.status,
      scoringStatus: job.scoringStatus,
      experienceStatus: job.experienceStatus,
      tailoringStaged: job.tailoringStaged,
      source: job.source,
      aimFitScore: job.aimFitScore,
      reqFitScore: job.reqFitScore,
      reqFitRationale: job.reqFitRationale,
      batchJobId: job.batchJobId,
      jdBatchId: job.jdBatchId,
      afBatchId: job.afBatchId,
      updatedAt: job.updatedAt.toISOString(),
    },
    userEvents: job.pipelineEvents.map((event) => ({
      id: event.id,
      eventType: event.eventType,
      occurredAt: event.occurredAt.toISOString(),
      details: event.details,
    })),
    leasedBatchItemIds: job.scoringBatchItems.map((item) => item.id),
    currentExperienceEvent: authority?.currentExperience
      ? {
        id: authority.currentExperience.id,
        experienceFitScore: authority.currentExperience.experienceFitScore ?? null,
        lifecycleApplied: true,
        createdAt: authority.currentExperience.createdAt.toISOString(),
      }
      : null,
    currentAimEvent: authority?.currentAim
      ? {
        id: authority.currentAim.id,
        aimFitScore: authority.currentAim.aimFitScore ?? null,
        passed: authority.currentAim.passed === true,
      }
      : null,
  };
}

function exactCurrentWhere(current: NonNullable<ExperienceRerunPlan['current']>): Prisma.JobWhereInput {
  return {
    id: current.id,
    updatedAt: new Date(current.updatedAt),
    status: current.status,
    scoringStatus: current.scoringStatus,
    experienceStatus: current.experienceStatus,
    tailoringStaged: current.tailoringStaged,
    aimFitScore: current.aimFitScore,
    reqFitScore: current.reqFitScore,
    reqFitRationale: current.reqFitRationale,
    batchJobId: current.batchJobId,
    jdBatchId: current.jdBatchId,
    afBatchId: current.afBatchId,
  };
}

async function buildPreview(client: DbClient): Promise<ExperienceRerunPlan[]> {
  const plans: ExperienceRerunPlan[] = [];
  for (const spec of EXPERIENCE_RERUN_COHORT) {
    plans.push(planExperienceRerun(spec, await loadEvidence(client, spec)));
  }
  return plans;
}

function selectionHash(plans: ExperienceRerunPlan[]): string {
  return canonicalJsonSha256(plans.map((plan) => ({
    id: plan.id, outcome: plan.outcome, target: plan.target, guardHash: plan.guardHash,
  })));
}

async function applyOne(
  initial: ExperienceRerunPlan,
): Promise<{ id: string; result: 'applied' | 'blocked'; reason: string }> {
  return prisma.$transaction(async (tx) => {
    const [locked] = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "Job" WHERE id = ${initial.id} FOR UPDATE
    `;
    if (!locked) return { id: initial.id, result: 'blocked', reason: 'job_missing_after_preview' };

    const spec = EXPERIENCE_RERUN_COHORT.find((item) => item.id === initial.id);
    if (!spec) return { id: initial.id, result: 'blocked', reason: 'cohort_definition_missing' };
    const freshEvidence = await loadEvidence(tx, spec);
    const fresh = planExperienceRerun(spec, freshEvidence);
    if (fresh.outcome !== 'ready'
      || !initial.guardHash
      || !freshEvidence
      || experienceRerunGuardHash(freshEvidence) !== initial.guardHash
      || fresh.guardHash !== initial.guardHash) {
      return { id: initial.id, result: 'blocked', reason: 'state_or_authority_changed_after_preview' };
    }

    // Preserve the record of the bad result; only remove its authority.
    const staled = await tx.jobScoreEvent.updateMany({
      where: { id: initial.staleEventId!, staleAt: null },
      data: { staleAt: new Date(), staleReason: EXPERIENCE_RERUN_STALE_REASON },
    });
    if (staled.count !== 1) {
      return { id: initial.id, result: 'blocked', reason: 'experience_event_already_stale' };
    }

    const updated = await tx.job.updateMany({
      where: exactCurrentWhere(initial.current!),
      data: initial.target as Prisma.JobUpdateManyMutationInput,
    });
    if (updated.count !== 1) {
      return { id: initial.id, result: 'blocked', reason: 'exact_current_field_guard_failed' };
    }

    const exporterEligible = await tx.job.count({
      where: { id: initial.id, ...operationalQueueWhere('experience_fit', []) },
    });
    if (exporterEligible !== 1) {
      throw new Error(`Experience queue target is not exporter-eligible for ${initial.id}`);
    }

    const occurredAt = new Date();
    const eventType = 'score_replay_queued' as const;
    await tx.jobPipelineEvent.upsert({
      where: {
        eventKey: buildPipelineEventKey({
          eventType,
          jobId: initial.id,
          source: initial.current!.source,
          identityParts: [EXPERIENCE_RERUN_VERSION, initial.guardHash],
        }),
      },
      update: {},
      create: {
        eventKey: buildPipelineEventKey({
          eventType,
          jobId: initial.id,
          source: initial.current!.source,
          identityParts: [EXPERIENCE_RERUN_VERSION, initial.guardHash],
        }),
        eventType,
        jobId: initial.id,
        stage: 'experience_fit',
        source: initial.current!.source,
        occurredAt,
        details: {
          route: 'requeue_experience_reruns',
          version: EXPERIENCE_RERUN_VERSION,
          reason: EXPERIENCE_RERUN_STALE_REASON,
          excludedReason: initial.excludedReason,
          disposition: initial.disposition,
          staledScoreEventId: initial.staleEventId,
          prior: initial.current,
          actor: 'system',
        } as unknown as Prisma.InputJsonValue,
      },
    });

    await assertJobLifecycleInvariants(tx, [initial.id]);
    return { id: initial.id, result: 'applied', reason: 'requeued_for_fresh_experience_run' };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 });
}

function parseMode(argv: string[]): { apply: boolean; approvedSelectionHash: string | null } {
  if (argv.length === 0) return { apply: false, approvedSelectionHash: null };
  if (argv.length !== 3 || argv[0] !== '--apply' || argv[1] !== '--selection-hash'
    || !/^[a-f0-9]{64}$/.test(argv[2])) {
    throw new Error(
      'Usage: requeue_experience_reruns.ts [--apply --selection-hash <reviewed-dry-run-hash>]',
    );
  }
  return { apply: true, approvedSelectionHash: argv[2] };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { apply, approvedSelectionHash } = parseMode(argv);
  const plans = await buildPreview(prisma);
  const preview = {
    mode: apply ? 'apply-preview' : 'dry-run',
    version: EXPERIENCE_RERUN_VERSION,
    generatedAt: new Date().toISOString(),
    cohortCount: EXPERIENCE_RERUN_COHORT.length,
    selectionHash: selectionHash(plans),
    counts: {
      ready: plans.filter((plan) => plan.outcome === 'ready').length,
      noop: plans.filter((plan) => plan.outcome === 'noop').length,
      blocked: plans.filter((plan) => plan.outcome === 'blocked').length,
      missing: plans.filter((plan) => plan.outcome === 'missing').length,
    },
    effect: 'Returns each job to the Experience Fit queue for a fresh manual run. '
      + 'Aim scores and every stored event are preserved; the bad Experience event is marked '
      + 'stale, not deleted. No score is invented, and the Deepgram case is marked for '
      + 'adjudication rather than automatic acceptance.',
    jobs: plans,
    writesPerformed: 0,
  };
  console.log(JSON.stringify(preview, null, 2));

  const missing = plans.filter((plan) => plan.outcome === 'missing');
  if (missing.length > 0) {
    throw new Error(
      `Cohort entries resolve to no job: ${missing.map((plan) => `${plan.label} (${plan.id})`).join(', ')}. `
      + 'No writes were attempted.',
    );
  }
  if (!apply) return;
  if (preview.selectionHash !== approvedSelectionHash) {
    throw new Error(
      `Selection hash mismatch: reviewed ${approvedSelectionHash}; current ${preview.selectionHash}. No writes were attempted.`,
    );
  }

  const results = [];
  for (const plan of plans) {
    if (plan.outcome !== 'ready') continue;
    results.push(await applyOne(plan));
  }
  console.log(JSON.stringify({
    mode: 'apply',
    version: EXPERIENCE_RERUN_VERSION,
    applied: results.filter((result) => result.result === 'applied').length,
    blocked: results.filter((result) => result.result === 'blocked').length,
    results,
  }, null, 2));
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main()
    .catch((error: unknown) => {
      console.error(`Experience rerun requeue failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    })
    .finally(async () => prisma.$disconnect());
}
