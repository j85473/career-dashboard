import assert from 'node:assert/strict';
import test from 'node:test';

import { readFileSync } from 'node:fs';
import nodePath from 'node:path';

import { reconcileScoringInputVersions } from '../scoringInputReconciliation';
import { currentScoringInputVersions } from '../scoringInputVersions';

test('scoring-input reconciliation dry run reports v2 drift and performs zero writes', async () => {
  const versions = currentScoringInputVersions();
  let transactionCalls = 0;
  const now = new Date('2026-08-13T12:00:00.000Z');
  const prisma = {
    jobScoreEvent: { findMany: async () => [
      {
        id: 'aim-stale', jobId: 'job-a', evaluationType: 'aim_fit',
        schemaVersion: 'career-dashboard-aim-result-v2', inputBindings: { globalInputVersionsHash: 'stale' },
        cleanedJdArtifactId: null, lifecycleProjection: 'pending_af', createdAt: now,
      },
      {
        id: 'aim-v1-history', jobId: 'job-history', evaluationType: 'aim_fit',
        schemaVersion: 'career-dashboard-aim-result-v1', inputBindings: { globalInputVersionsHash: 'stale' },
        cleanedJdArtifactId: 'artifact-history', lifecycleProjection: 'pending_af', createdAt: now,
      },
      {
        id: 'experience-current', jobId: 'job-e', evaluationType: 'experience_fit',
        schemaVersion: 'career-dashboard-experience-result-v2',
        inputBindings: { globalInputVersionsHash: versions.experienceInputVersionsHash },
        cleanedJdArtifactId: null, lifecycleProjection: 'inbox', createdAt: now,
      },
    ] },
    aimFactualExtraction: { findMany: async () => [
      {
        id: 'extraction-stale',
        questionRegistryHash: 'stale', promptContractHash: versions.promptContractHash,
        responseContractHash: versions.responseContractHash, runnerProtocolHash: versions.runnerProtocolHash,
        packetStrategyHash: versions.packetStrategyHash, canonicalizationVersion: versions.canonicalizationVersion,
        anonymizationPolicyVersion: versions.anonymizationPolicyVersion,
        anonymizationPolicyHash: versions.anonymizationPolicyHash,
        extractorSemanticVersion: versions.extractorSemanticVersion,
      },
      {
        id: 'extraction-runner-only-drift',
        questionRegistryHash: versions.questionRegistryHash, promptContractHash: versions.promptContractHash,
        responseContractHash: versions.responseContractHash, runnerProtocolHash: 'historical-runner-provenance',
        packetStrategyHash: versions.packetStrategyHash, canonicalizationVersion: versions.canonicalizationVersion,
        anonymizationPolicyVersion: versions.anonymizationPolicyVersion,
        anonymizationPolicyHash: versions.anonymizationPolicyHash,
        extractorSemanticVersion: versions.extractorSemanticVersion,
      },
    ] },
    jobScoringArtifact: { findMany: async () => [{ id: 'artifact-stale' }] },
    scoringBatch: { findMany: async () => [{ id: 'batch-stale', stage: 'aim', inputVersionsHash: 'stale' }] },
    job: { findMany: async () => [{
      id: 'job-a', status: 'pending_af', tailoringStaged: false, pipelineEvents: [],
    }] },
    $transaction: async () => { transactionCalls += 1; },
  };
  const report = await reconcileScoringInputVersions(prisma as never, { dryRun: true, now });
  assert.deepEqual(report, {
    generatedAt: now.toISOString(),
    staleAimEventIds: ['aim-stale'],
    staleExperienceEventIds: [],
    staleArtifactIds: [],
    staleExtractionIds: ['extraction-stale'],
    supersededBatchIds: ['batch-stale'],
    requeuedJobIds: ['job-a'],
    actionNeededJobIds: [],
    applied: false,
  });
  assert.equal(transactionCalls, 0);
});

function driftedExperiencePrisma(
  now: Date,
  sinks: {
    jobUpdates: Array<{ where: unknown; data: Record<string, unknown> }>;
    eventUpdates: unknown[];
    pipelineEvents: unknown[];
  },
  options: { mutateBeforeLockedRead?: (job: Record<string, unknown>) => void } = {},
) {
  const job = {
    id: 'job-inbox', title: 'Partner Manager', company: 'Example', location: 'Chicago, IL',
    description: 'A complete fixture job description.', url: 'https://example.test/job', source: 'fixture',
    status: 'inbox', scoringStatus: 'scored', tailoringStaged: false, fitScore: 80,
    fitRationale: 'Local Scoring Engine fixture', passReason: null,
    aimFitScore: 75, reqFitScore: 88, pipelineEvents: [], _count: { scoreEvents: 1 },
    updatedAt: new Date('2026-08-20T19:00:00Z'),
  };
  return {
    jobScoreEvent: { findMany: async () => [{
      id: 'experience-stale', jobId: 'job-inbox', evaluationType: 'experience_fit',
      schemaVersion: 'career-dashboard-experience-result-v2',
      inputBindings: { globalInputVersionsHash: 'old-policy' },
      cleanedJdArtifactId: null, lifecycleProjection: 'inbox', createdAt: now,
    }] },
    aimFactualExtraction: { findMany: async () => [] },
    scoringBatch: { findMany: async () => [] },
    job: { findMany: async () => [job] },
    $transaction: async (operation: (tx: unknown) => Promise<void>) => operation({
      jobScoreEvent: { updateMany: async (args: unknown) => { sinks.eventUpdates.push(args); } },
      jobScoringArtifact: { updateMany: async () => undefined },
      aimFactualExtraction: { updateMany: async () => undefined },
      scoringBatch: { updateMany: async () => undefined },
      job: {
        updateMany: async (args: { where: unknown; data: Record<string, unknown> }) => {
          sinks.jobUpdates.push(args);
          Object.assign(job, args.data);
          return { count: 1 };
        },
        findMany: async ({ where, select }: { where: Record<string, unknown>; select: Record<string, unknown> }) => {
          if (select._count) return [job];
          const predicate = (where.AND as Array<Record<string, unknown>> | undefined)?.[1];
          if (!predicate) return [job];
          if ((predicate.OR as Array<Record<string, unknown>> | undefined)?.[0]?.status === 'pending_af') return [job];
          return predicate.scoringStatus === 'scored'
            && (predicate.aimFitScore as { not?: null } | undefined)?.not === null
            ? [{ id: job.id }]
            : [];
        },
      },
      jobPipelineEvent: { createMany: async (args: unknown) => { sinks.pipelineEvents.push(args); } },
      aimScoringFailureReceipt: { findMany: async () => [] },
      $queryRaw: async () => {
        if (options.mutateBeforeLockedRead) {
          options.mutateBeforeLockedRead(job);
          options.mutateBeforeLockedRead = undefined;
          return [{ id: job.id }];
        }
        return [{
        id: 'experience-stale', jobId: job.id, evaluationType: 'experience_fit', family: 'experience',
        model: 'fixture', promptVersion: 'fixture', requestId: null, resultHash: null, policyVersion: null,
        schemaVersion: 'career-dashboard-experience-result-v2', batchId: null, batchItemId: null,
        decisionCode: null, aimFitScore: null, experienceFitScore: 88, travelScore: null,
        aimReason: null, experienceReason: null, domainMatch: null, requiredDomain: null,
        candidateDomain: null, qualificationBasis: null, mandatoryRequirementAssessments: null,
        aimAssessments: null, travelAssessment: null, compensationAssessment: null,
        inputBindings: { globalInputVersionsHash: 'old-policy' }, workerProvenance: null,
        sourceAimEventId: null, cleanedJdArtifactId: null, aimFactualExtractionId: null,
        semanticResultHash: null, scoringIdentity: null, questionRegistryHash: null,
        scoringPolicyHash: null, resultBuilderSemanticVersion: null, lifecyclePriorStatus: 'pending_af',
        lifecycleApplied: true, passed: true, staleAt: now, staleReason: 'global-scoring-input-version-changed',
        createdAt: now, artifactId: null, artifactHash: null, artifactStaleAt: null,
        extractionId: null, extractionSourceJdHash: null, extractionStaleAt: null,
        }];
      },
    }),
  };
}

test('refining a policy does not retract the scores made before it', async () => {
  // Re-scoring the backlog costs real manual hours. Version drift is reported
  // and nothing is written unless invalidation is asked for explicitly.
  const now = new Date('2026-08-20T20:00:00.000Z');
  const sinks = { jobUpdates: [], eventUpdates: [], pipelineEvents: [] } as Parameters<typeof driftedExperiencePrisma>[1];
  const report = await reconcileScoringInputVersions(
    driftedExperiencePrisma(now, sinks) as never,
    { now },
  );
  assert.equal(report.applied, false);
  assert.deepEqual(report.requeuedJobIds, ['job-inbox']);
  assert.match(report.withheldReason || '', /left untouched/i);
  assert.equal(sinks.jobUpdates.length, 0);
  assert.equal(sinks.eventUpdates.length, 0);
  assert.equal(sinks.pipelineEvents.length, 0);
});

test('explicit invalidation clears stale Experience projections before requeueing', async () => {
  const now = new Date('2026-08-20T20:00:00.000Z');
  const sinks = { jobUpdates: [], eventUpdates: [], pipelineEvents: [] } as Parameters<typeof driftedExperiencePrisma>[1];
  const report = await reconcileScoringInputVersions(
    driftedExperiencePrisma(now, sinks) as never,
    { now, invalidateDrifted: true },
  );
  assert.equal(report.applied, true);
  assert.deepEqual(report.requeuedJobIds, ['job-inbox']);
  assert.equal(sinks.eventUpdates.length, 1);
  assert.equal(sinks.jobUpdates.length, 1);
  assert.deepEqual(sinks.jobUpdates[0].where, {
    id: 'job-inbox',
    updatedAt: new Date('2026-08-20T19:00:00Z'),
    status: 'inbox',
    tailoringStaged: false,
  });
  assert.deepEqual(sinks.jobUpdates[0].data, {
    status: 'pending_af',
    reqFitScore: null,
    reqFitRationale: null,
    experienceStatus: 'queued',
  });
  assert.equal(sinks.pipelineEvents.length, 1);
});

test('an explicit invalidation still refuses an oversized unattended wipe', async () => {
  const now = new Date('2026-08-20T20:00:00.000Z');
  const sinks = { jobUpdates: [], eventUpdates: [], pipelineEvents: [] } as Parameters<typeof driftedExperiencePrisma>[1];
  const report = await reconcileScoringInputVersions(
    driftedExperiencePrisma(now, sinks) as never,
    { now, invalidateDrifted: true, maxRequeue: 0 },
  );
  assert.equal(report.applied, false);
  assert.match(report.withheldReason || '', /exceeds the 0-job unattended cap/);
  assert.equal(sinks.jobUpdates.length, 0);
});

test('transactional revalidation cannot overwrite a concurrent Applied decision', async () => {
  const now = new Date('2026-08-20T20:00:00.000Z');
  const sinks = { jobUpdates: [], eventUpdates: [], pipelineEvents: [] } as Parameters<typeof driftedExperiencePrisma>[1];
  const report = await reconcileScoringInputVersions(
    driftedExperiencePrisma(now, sinks, {
      mutateBeforeLockedRead: (job) => {
        job.status = 'applied';
        job.updatedAt = new Date('2026-08-20T19:30:00Z');
        job.pipelineEvents = [{
          id: 'applied-event', eventType: 'user_lifecycle', occurredAt: new Date('2026-08-20T19:30:00Z'),
          details: { nextStatus: 'applied' },
        }];
      },
    }) as never,
    { now, invalidateDrifted: true },
  );
  assert.deepEqual(report.requeuedJobIds, []);
  assert.deepEqual(report.actionNeededJobIds, ['job-inbox']);
  assert.equal(sinks.jobUpdates.length, 0);
  assert.equal(sinks.pipelineEvents.length, 0);
});

test('a score already paid for in manual time cannot be cleared without a stated bound', () => {
  // Version drift is provenance, not a verdict. Nothing may clear a stored
  // score automatically, and the deliberate path may not run unbounded.
  const script = readFileSync(
    nodePath.join(process.cwd(), 'scripts/reconcile_scoring_input_versions.ts'),
    'utf8',
  );
  assert.match(script, /if \(invalidateDrifted && maxRequeue === undefined\) \{/);
  assert.match(script, /Refusing to clear drifted scores without a bound/);

  const packageJson = JSON.parse(readFileSync(
    nodePath.join(process.cwd(), 'package.json'),
    'utf8',
  )) as { scripts: Record<string, string> };
  assert.match(packageJson.scripts['scoring:inputs:invalidate-drifted'], /--max-requeue$/);
  assert.equal(
    packageJson.scripts['scoring:inputs:reconcile'].includes('--invalidate-drifted'),
    false,
    'the plain reconcile command must stay reporting-only',
  );
});
