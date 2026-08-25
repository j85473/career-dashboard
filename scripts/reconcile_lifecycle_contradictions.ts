import 'dotenv/config';

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { Prisma, type PrismaClient } from '@prisma/client';

import { buildPipelineEventKey } from '../src/lib/ingestionControl';
import {
  LIFECYCLE_RECONCILIATION_COHORT,
  lifecycleReconciliationGuardHash,
  planLifecycleReconciliation,
  type LifecycleReconciliationPlan,
  type LifecycleReconciliationSpec,
  type ReconciliationCurrentFields,
  type ReconciliationEvidence,
  type ReconciliationScoreEvent,
} from '../src/lib/lifecycleContradictionReconciliation';
import {
  MANUAL_IMPORT_INITIAL_LIFECYCLE,
  normalizeManualImportMetadata,
} from '../src/lib/manualImportPolicy';
import { operationalQueueWhere } from '../src/lib/operationalQueue';
import { prisma } from '../src/lib/prisma';
import { latestJobScoreEvents, type LatestJobScoreEvent } from '../src/lib/jobScoreAuthorityQuery';
import { resolveStagedScoreAuthority } from '../src/lib/scoreAuthority';
import { canonicalJsonSha256 } from '../src/lib/scoringCanonicalJson';
import { USER_LIFECYCLE_INTENT_EVENT_TYPES } from '../src/lib/userLifecycleAuthority';

const RECONCILIATION_VERSION = 'contradictory-lifecycle-v1';

type DbClient = PrismaClient | Prisma.TransactionClient;

const guardedJobSelect = {
  id: true,
  title: true,
  company: true,
  location: true,
  description: true,
  url: true,
  source: true,
  sourceId: true,
  status: true,
  scoringStatus: true,
  scoreAttempts: true,
  scoreError: true,
  fitScore: true,
  fitCategory: true,
  fitRationale: true,
  passReason: true,
  tailoringStaged: true,
  aimFitScore: true,
  reqFitScore: true,
  reqFitRationale: true,
  experienceStatus: true,
  batchJobId: true,
  jdBatchId: true,
  afBatchId: true,
  updatedAt: true,
  pipelineEvents: {
    where: { eventType: { in: [...USER_LIFECYCLE_INTENT_EVENT_TYPES] } },
    orderBy: [{ occurredAt: 'desc' as const }, { id: 'desc' as const }],
    select: { id: true, eventType: true, occurredAt: true, details: true },
  },
  scoreEvents: {
    orderBy: [{ createdAt: 'desc' as const }, { id: 'desc' as const }],
    select: { id: true },
  },
  scoringBatchItems: {
    where: { status: 'leased' },
    orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }],
    select: { id: true },
  },
} satisfies Prisma.JobSelect;

type GuardedJob = Prisma.JobGetPayload<{ select: typeof guardedJobSelect }>;

function scoreEventSummary(event: LatestJobScoreEvent | null): ReconciliationScoreEvent | null {
  if (!event?.id) return null;
  return {
    id: event.id,
    evaluationType: event.evaluationType,
    passed: event.passed === true,
    aimFitScore: event.aimFitScore ?? null,
    experienceFitScore: event.experienceFitScore ?? null,
    decisionCode: event.decisionCode ?? null,
    lifecycleProjection: null,
    staleAt: event.staleAt ? new Date(event.staleAt).toISOString() : null,
    createdAt: event.createdAt.toISOString(),
  };
}

function currentFields(job: GuardedJob): ReconciliationCurrentFields {
  return {
    id: job.id,
    title: job.title,
    company: job.company,
    location: job.location,
    source: job.source,
    status: job.status,
    scoringStatus: job.scoringStatus,
    scoreAttempts: job.scoreAttempts,
    scoreError: job.scoreError,
    fitScore: job.fitScore,
    fitCategory: job.fitCategory,
    fitRationale: job.fitRationale,
    passReason: job.passReason,
    tailoringStaged: job.tailoringStaged,
    aimFitScore: job.aimFitScore,
    reqFitScore: job.reqFitScore,
    reqFitRationale: job.reqFitRationale,
    batchJobId: job.batchJobId,
    jdBatchId: job.jdBatchId,
    afBatchId: job.afBatchId,
    experienceStatus: job.experienceStatus,
    updatedAt: job.updatedAt.toISOString(),
  };
}

async function loadEvidence(
  client: DbClient,
  spec: LifecycleReconciliationSpec,
): Promise<ReconciliationEvidence | null> {
  const job = await client.job.findUnique({ where: { id: spec.id }, select: guardedJobSelect });
  if (!job) return null;
  const bundle = (await latestJobScoreEvents([spec.id], client)).get(spec.id) || {
    legacy: null,
    aim: null,
    experience: null,
    cleanedArtifact: null,
    aimExtraction: null,
  };
  const authority = resolveStagedScoreAuthority(bundle);
  const normalization = normalizeManualImportMetadata({
    source: job.source,
    title: job.title,
    company: job.company,
    location: job.location,
    description: job.description,
    url: job.url,
  });
  const manualImportTarget = spec.action === 'manual_import_tailoring' && normalization.readyForScoring
    ? {
      title: normalization.title,
      company: normalization.company,
      location: normalization.location,
      ...MANUAL_IMPORT_INITIAL_LIFECYCLE,
      scoringStatus: 'queued',
      batchJobId: null,
      jdBatchId: null,
      afBatchId: null,
      scoreAttempts: 0,
      scoreError: null,
      fitScore: null,
      fitCategory: 'unscored',
      fitRationale: null,
      passReason: null,
      aimFitScore: null,
      reqFitScore: null,
      reqFitRationale: null,
      experienceStatus: 'queued',
    }
    : null;
  return {
    current: currentFields(job),
    inputFingerprint: canonicalJsonSha256({
      sourceId: job.sourceId,
      url: job.url,
      description: job.description,
    }),
    userEvents: job.pipelineEvents.map((event) => ({
      id: event.id,
      eventType: event.eventType,
      occurredAt: event.occurredAt.toISOString(),
      details: event.details,
    })),
    rawScoreEventIds: job.scoreEvents.map((event) => event.id),
    leasedBatchItemIds: job.scoringBatchItems.map((item) => item.id),
    scoreAuthority: {
      mode: authority.mode,
      aimState: authority.aimAuthorityState,
      experienceState: authority.experienceAuthorityState,
      currentAim: scoreEventSummary(authority.currentAim),
      currentExperience: scoreEventSummary(authority.currentExperience),
      currentLegacy: scoreEventSummary(authority.currentLegacy),
      staleAim: scoreEventSummary(authority.staleAim),
      staleExperience: scoreEventSummary(authority.staleExperience),
      staleReason: authority.staleScoreReason,
    },
    manualImportTarget,
  };
}

function exactCurrentWhere(current: ReconciliationCurrentFields): Prisma.JobWhereInput {
  return {
    id: current.id,
    updatedAt: new Date(current.updatedAt),
    title: current.title,
    company: current.company,
    location: current.location,
    source: current.source,
    status: current.status,
    scoringStatus: current.scoringStatus,
    scoreAttempts: current.scoreAttempts,
    scoreError: current.scoreError,
    fitScore: current.fitScore,
    fitCategory: current.fitCategory,
    fitRationale: current.fitRationale,
    passReason: current.passReason,
    tailoringStaged: current.tailoringStaged,
    aimFitScore: current.aimFitScore,
    reqFitScore: current.reqFitScore,
    reqFitRationale: current.reqFitRationale,
    batchJobId: current.batchJobId,
    jdBatchId: current.jdBatchId,
    afBatchId: current.afBatchId,
    experienceStatus: current.experienceStatus,
  };
}

async function buildPreview(client: DbClient): Promise<LifecycleReconciliationPlan[]> {
  const plans: LifecycleReconciliationPlan[] = [];
  for (const spec of LIFECYCLE_RECONCILIATION_COHORT) {
    plans.push(planLifecycleReconciliation(spec, await loadEvidence(client, spec)));
  }
  return plans;
}

function selectionHash(plans: LifecycleReconciliationPlan[]): string {
  return canonicalJsonSha256(plans.map((plan) => ({
    id: plan.id,
    disposition: plan.disposition,
    target: plan.target,
    guardHash: plan.guardHash,
  })));
}

function structuredPreview(plans: LifecycleReconciliationPlan[]) {
  return {
    mode: 'dry-run',
    version: RECONCILIATION_VERSION,
    generatedAt: new Date().toISOString(),
    cohortCount: LIFECYCLE_RECONCILIATION_COHORT.length,
    selectionHash: selectionHash(plans),
    counts: {
      ready: plans.filter((plan) => plan.disposition === 'ready').length,
      noop: plans.filter((plan) => plan.disposition === 'noop').length,
      blocked: plans.filter((plan) => plan.disposition === 'blocked').length,
      missing: plans.filter((plan) => plan.disposition === 'missing').length,
    },
    jobs: plans,
    writesPerformed: 0,
  };
}

async function applyOne(
  initial: LifecycleReconciliationPlan,
): Promise<{ id: string; result: 'applied' | 'blocked'; reason: string }> {
  return prisma.$transaction(async (tx) => {
    const [locked] = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "Job" WHERE id = ${initial.id} FOR UPDATE
    `;
    if (!locked) return { id: initial.id, result: 'blocked', reason: 'job_missing_after_preview' };

    const spec = LIFECYCLE_RECONCILIATION_COHORT.find((item) => item.id === initial.id);
    if (!spec) return { id: initial.id, result: 'blocked', reason: 'cohort_definition_missing' };
    const freshEvidence = await loadEvidence(tx, spec);
    const fresh = planLifecycleReconciliation(spec, freshEvidence);
    if (fresh.disposition !== 'ready'
      || !initial.guardHash
      || !freshEvidence
      || lifecycleReconciliationGuardHash(freshEvidence) !== initial.guardHash
      || fresh.guardHash !== initial.guardHash) {
      return { id: initial.id, result: 'blocked', reason: 'state_or_authority_changed_after_preview' };
    }

    const updated = await tx.job.updateMany({
      where: exactCurrentWhere(initial.current!),
      data: initial.target as Prisma.JobUpdateManyMutationInput,
    });
    if (updated.count !== 1) {
      return { id: initial.id, result: 'blocked', reason: 'exact_current_field_guard_failed' };
    }
    if (initial.requestedAction === 'experience_queue') {
      const exporterEligible = await tx.job.count({
        where: { id: initial.id, ...operationalQueueWhere('experience_fit', []) },
      });
      if (exporterEligible !== 1) {
        throw new Error(`Experience queue target is not exporter-eligible for ${initial.id}`);
      }
    }

    const occurredAt = new Date();
    const eventType = 'lifecycle_reconciled' as const;
    const eventKey = buildPipelineEventKey({
      eventType,
      jobId: initial.id,
      source: initial.current!.source,
      identityParts: [RECONCILIATION_VERSION, initial.requestedAction, initial.guardHash],
    });
    await tx.jobPipelineEvent.upsert({
      where: { eventKey },
      update: {},
      create: {
        eventKey,
        eventType,
        jobId: initial.id,
        stage: 'lifecycle_reconciliation',
        source: initial.current!.source,
        details: {
          route: 'reconcile_lifecycle_contradictions',
          version: RECONCILIATION_VERSION,
          requestedAction: initial.requestedAction,
          authority: initial.authority,
          prior: initial.current,
          target: initial.target,
          guardHash: initial.guardHash,
        } as unknown as Prisma.InputJsonValue,
        occurredAt,
      },
    });
    return { id: initial.id, result: 'applied', reason: 'guarded_transition_committed' };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 });
}

function parseMode(argv: string[]): { apply: boolean; approvedSelectionHash: string | null } {
  if (argv.length === 0) return { apply: false, approvedSelectionHash: null };
  if (argv.length !== 3 || argv[0] !== '--apply' || argv[1] !== '--selection-hash'
    || !/^[a-f0-9]{64}$/.test(argv[2])) {
    throw new Error(
      'Usage: reconcile_lifecycle_contradictions.ts [--apply --selection-hash <reviewed-dry-run-hash>]',
    );
  }
  return { apply: true, approvedSelectionHash: argv[2] };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { apply, approvedSelectionHash } = parseMode(argv);

  const plans = await buildPreview(prisma);
  const preview = structuredPreview(plans);
  console.log(JSON.stringify(preview, null, 2));

  // A cohort entry that resolves to nothing is far more likely to be a
  // mistyped job ID than a genuinely deleted row, and reading it as "already
  // handled" is exactly how a contradiction stays unreconciled. Two entries
  // reached review with single-character transcription errors, so this is a
  // hard failure rather than a line in the report.
  const missing = plans.filter((plan) => plan.disposition === 'missing');
  if (missing.length > 0) {
    throw new Error(
      `Cohort entries resolve to no job: ${missing.map((plan) => `${plan.label} (${plan.id})`).join(', ')}. `
      + 'Verify each ID against production before reconciling. No writes were attempted.',
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
    if (plan.disposition !== 'ready') continue;
    results.push(await applyOne(plan));
  }
  console.log(JSON.stringify({
    mode: 'apply',
    version: RECONCILIATION_VERSION,
    applied: results.filter((result) => result.result === 'applied').length,
    blocked: results.filter((result) => result.result === 'blocked').length,
    results,
  }, null, 2));
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main()
    .catch((error: unknown) => {
      console.error(`Lifecycle contradiction reconciliation failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    })
    .finally(async () => prisma.$disconnect());
}
