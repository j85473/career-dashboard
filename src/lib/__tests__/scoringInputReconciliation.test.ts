import assert from 'node:assert/strict';
import test from 'node:test';

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

test('scoring-input reconciliation clears stale Experience projections before requeueing', async () => {
  const now = new Date('2026-08-20T20:00:00.000Z');
  const jobUpdates: Array<{ where: unknown; data: Record<string, unknown> }> = [];
  const eventUpdates: unknown[] = [];
  const pipelineEvents: unknown[] = [];
  const prisma = {
    jobScoreEvent: { findMany: async () => [{
      id: 'experience-stale', jobId: 'job-inbox', evaluationType: 'experience_fit',
      schemaVersion: 'career-dashboard-experience-result-v2',
      inputBindings: { globalInputVersionsHash: 'old-policy' },
      cleanedJdArtifactId: null, lifecycleProjection: 'inbox', createdAt: now,
    }] },
    aimFactualExtraction: { findMany: async () => [] },
    scoringBatch: { findMany: async () => [] },
    job: { findMany: async () => [{
      id: 'job-inbox', status: 'inbox', tailoringStaged: false, pipelineEvents: [],
    }] },
    $transaction: async (operation: (tx: unknown) => Promise<void>) => operation({
      jobScoreEvent: { updateMany: async (args: unknown) => { eventUpdates.push(args); } },
      jobScoringArtifact: { updateMany: async () => undefined },
      aimFactualExtraction: { updateMany: async () => undefined },
      scoringBatch: { updateMany: async () => undefined },
      job: { updateMany: async (args: { where: unknown; data: Record<string, unknown> }) => { jobUpdates.push(args); } },
      jobPipelineEvent: { createMany: async (args: unknown) => { pipelineEvents.push(args); } },
    }),
  };

  const report = await reconcileScoringInputVersions(prisma as never, { now });
  assert.equal(report.applied, true);
  assert.deepEqual(report.requeuedJobIds, ['job-inbox']);
  assert.equal(eventUpdates.length, 1);
  assert.equal(jobUpdates.length, 1);
  assert.deepEqual(jobUpdates[0].data, {
    status: 'pending_af',
    reqFitScore: null,
    reqFitRationale: null,
    experienceStatus: 'queued',
  });
  assert.equal(pipelineEvents.length, 1);
});
