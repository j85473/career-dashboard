import assert from 'node:assert/strict';
import test from 'node:test';

import type { PrismaClient } from '@prisma/client';

import { canonicalJson, canonicalJsonSha256, normalizedTextSha256 } from '../scoringCanonicalJson';
import { applyScoringImport, previewScoringImport } from '../scoringImport';
import { scoringManifestHash } from '../scoringInputBinding';
import { HISTORICAL_AIM_V1_HARD_STOP_CODES as AIM_HARD_STOP_CODES } from '../historicalAimScoringPolicy';
import { currentScoringInputVersions } from '../scoringInputVersions';

const BATCH_ID = '11111111-1111-4111-8111-111111111111';
const ITEM_ID = '22222222-2222-4222-8222-222222222222';
const JOB_ID = '33333333-3333-4333-8333-333333333333';
const FAILED_ITEM_ID = '44444444-4444-4444-8444-444444444444';
const FAILED_JOB_ID = '55555555-5555-4555-8555-555555555555';
const SECRET = 'test-only-scoring-approval-secret-32-bytes-minimum';
const HASH = 'a'.repeat(64);

type FakeState = {
  batch: Record<string, unknown> & { items: Array<Record<string, unknown>> };
  jobs: Array<Record<string, unknown>>;
  artifacts: Array<Record<string, unknown>>;
  scoreEvents: Array<Record<string, unknown>>;
};

function withResultHash<T extends Record<string, unknown>>(value: T): T & { resultHash: string } {
  return { ...value, resultHash: canonicalJsonSha256(value) };
}

function fixture() {
  const inputVersionsHash = currentScoringInputVersions().aimInputVersionsHash;
  const submittedAt = new Date();
  submittedAt.setMilliseconds(0);
  const createdAt = new Date(submittedAt.valueOf() - 60_000);
  const expiresAt = new Date(submittedAt.valueOf() + 60 * 60 * 1000);
  const originalJd = 'Build and grow a partner channel.';
  const sourceJdHash = normalizedTextSha256(originalJd);
  const inputHash = 'b'.repeat(64);
  const manifestHash = scoringManifestHash({
    batchId: BATCH_ID,
    stage: 'aim',
    schemaVersion: 'career-dashboard-aim-export-v1',
    protocolVersion: 'career-dashboard-scoring-protocol-v1',
    policyVersion: 'aim-policy-v1',
    items: [{ ordinal: 0, jobId: JOB_ID, inputHash }],
  });
  const exportPayload = {
    schemaVersion: 'career-dashboard-aim-export-v1',
    batch: {
      id: BATCH_ID,
      stage: 'aim',
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      protocolVersion: 'career-dashboard-scoring-protocol-v1',
      policyVersion: 'aim-policy-v1',
      manifestHash,
    },
    preferences: { policyHash: HASH, employerOverridesHash: HASH, employerOverrides: {} },
    jobs: [{
      jobId: JOB_ID,
      ordinal: 0,
      submittedUpdatedAt: submittedAt.toISOString(),
      company: 'Example',
      title: 'Channel Manager',
      location: 'Minneapolis, MN',
      sourceUrl: null,
      originalJd,
      sourceJdHash,
      metadataHash: HASH,
      inputHash,
    }],
  };
  const binding = { source: 'original_jd', span: null };
  const itemResult = withResultHash({
    jobId: JOB_ID,
    ordinal: 0,
    inputHash,
    workers: [{
      phase: 'aim_evaluator',
      model: 'test-model',
      effort: 'high',
      promptVersion: 'aim-evaluator-v1',
      startedAt: createdAt.toISOString(),
      completedAt: submittedAt.toISOString(),
      invocationReceipt: 'test-worker-receipt',
    }],
    result: {
      kind: 'evaluation',
      cleanedArtifact: {
        cleanerVersion: 'jd-cleaner-v2',
        sourceJdHash,
        cleanedText: originalJd,
        cleanedTextHash: sourceJdHash,
        removedSpans: [],
        coverageAudit: { complete: true, findings: [] },
        repairHistory: [],
      },
      hardStops: AIM_HARD_STOP_CODES.map((code) => ({
        code,
        state: 'absent',
        rationale: 'No affirmative conflict in the supplied posting.',
        binding,
      })),
      decision: 'survivor',
      rubric: {
        coreWork: { band: 'strong_fit', points: 34, rationale: 'Strong channel work.', binding },
        buildingAutonomy: { band: 'strong_ownership_or_growth', points: 19, rationale: 'Owns growth.', binding },
        productIndustry: { band: 'interesting_technology', points: 14, rationale: 'Interesting product.', binding },
        travel: { band: 'none_or_unstated', points: 0, rationale: 'Travel is unstated.', binding },
      },
      travel: {
        kind: 'unstated',
        minimumPercent: null,
        maximumPercent: null,
        qualitativeFrequency: null,
        band: 'none_or_unstated',
        points: 0,
        source: null,
      },
      compensation: {
        stated: false,
        source: null,
        currency: null,
        period: null,
        baseMinimum: null,
        baseMaximum: null,
        totalMinimum: null,
        totalMaximum: null,
        variablePayContext: null,
      },
      aimFitScore: 67,
    },
  });
  const resultPayload = withResultHash({
    schemaVersion: 'career-dashboard-aim-result-v1',
    batch: {
      id: BATCH_ID,
      stage: 'aim',
      protocolVersion: 'career-dashboard-scoring-protocol-v1',
      policyVersion: 'aim-policy-v1',
      manifestHash,
    },
    runner: {
      runnerVersion: 'test-runner-v1',
      model: 'test-model',
      effort: 'high',
      promptVersion: 'aim-workers-v2',
      startedAt: createdAt.toISOString(),
      completedAt: submittedAt.toISOString(),
      invocationReceipt: 'test-runner-receipt',
    },
    results: [itemResult],
  });
  const inputSnapshot = {
    ...exportPayload.jobs[0],
    globalInputVersionsHash: inputVersionsHash,
    binding: {
      stage: 'aim',
      protocolVersion: 'career-dashboard-scoring-protocol-v1',
      schemaVersion: 'career-dashboard-aim-export-v1',
      globalInputVersionsHash: inputVersionsHash,
      policyHash: HASH,
      sourceJdHash,
      metadataHash: HASH,
      employerOverridesHash: HASH,
      preferencesHash: HASH,
    },
  };
  const state: FakeState = {
    batch: {
      id: BATCH_ID,
      stage: 'aim',
      status: 'exported',
      schemaVersion: 'career-dashboard-aim-export-v1',
      protocolVersion: 'career-dashboard-scoring-protocol-v1',
      policyVersion: 'aim-policy-v1',
      exportHash: canonicalJsonSha256(exportPayload),
      manifestHash,
      preferenceHash: HASH,
      employerOverridesHash: HASH,
      resumeHash: null,
      evidenceHash: null,
      inputVersionsHash,
      manifestSnapshot: [{ ordinal: 0, jobId: JOB_ID, inputHash }],
      exportJson: canonicalJson(exportPayload),
      exportByteLength: Buffer.byteLength(canonicalJson(exportPayload)),
      acceptedResultHash: null,
      createdAt,
      expiresAt,
      completedAt: null,
      releasedAt: null,
      supersededAt: null,
      supersededReason: null,
      items: [{
        id: ITEM_ID,
        batchId: BATCH_ID,
        jobId: JOB_ID,
        stage: 'aim',
        ordinal: 0,
        status: 'leased',
        submittedUpdatedAt: submittedAt,
        sourceJdHash,
        inputHash,
        inputSnapshot,
        sourceAimEventId: null,
        cleanedArtifactId: null,
        acceptedResultHash: null,
        acceptedResultSnapshot: null,
        importedScoreEventId: null,
        createdAt,
        importedAt: null,
        releasedAt: null,
      }],
    },
    jobs: [{
      id: JOB_ID,
      updatedAt: submittedAt,
      status: 'pending_af',
      tailoringStaged: false,
      source: 'test',
      sourceId: 'test-source-id',
      aimFitScore: null,
      travelScore: null,
    }],
    artifacts: [],
    scoreEvents: [],
  };
  return { state, resultJson: canonicalJson(resultPayload), resultPayload };
}

function mixedFixture() {
  const base = fixture();
  const state = structuredClone(base.state);
  const resultPayload = structuredClone(base.resultPayload);
  const exportPayload = JSON.parse(String(state.batch.exportJson)) as {
    batch: { manifestHash: string };
    jobs: Array<Record<string, unknown>>;
  };
  const failedInputHash = 'c'.repeat(64);
  const failedJob = {
    ...exportPayload.jobs[0],
    jobId: FAILED_JOB_ID,
    ordinal: 1,
    company: 'Failed Example',
    title: 'Interrupted Role',
    inputHash: failedInputHash,
  };
  exportPayload.jobs.push(failedJob);
  const manifestHash = scoringManifestHash({
    batchId: BATCH_ID,
    stage: 'aim',
    schemaVersion: 'career-dashboard-aim-export-v1',
    protocolVersion: 'career-dashboard-scoring-protocol-v1',
    policyVersion: 'aim-policy-v1',
    items: [
      { ordinal: 0, jobId: JOB_ID, inputHash: state.batch.items[0].inputHash as string },
      { ordinal: 1, jobId: FAILED_JOB_ID, inputHash: failedInputHash },
    ],
  });
  exportPayload.batch.manifestHash = manifestHash;
  state.batch.manifestHash = manifestHash;
  state.batch.manifestSnapshot = [
    { ordinal: 0, jobId: JOB_ID, inputHash: state.batch.items[0].inputHash },
    { ordinal: 1, jobId: FAILED_JOB_ID, inputHash: failedInputHash },
  ];
  state.batch.exportJson = canonicalJson(exportPayload);
  state.batch.exportHash = canonicalJsonSha256(exportPayload);
  state.batch.exportByteLength = Buffer.byteLength(state.batch.exportJson as string);
  const failedItem = {
    ...structuredClone(state.batch.items[0]),
    id: FAILED_ITEM_ID,
    jobId: FAILED_JOB_ID,
    ordinal: 1,
    inputHash: failedInputHash,
    inputSnapshot: { ...failedJob, globalInputVersionsHash: state.batch.inputVersionsHash, binding: (state.batch.items[0].inputSnapshot as Record<string, unknown>).binding },
  };
  state.batch.items.push(failedItem);
  state.jobs.push({
    ...structuredClone(state.jobs[0]),
    id: FAILED_JOB_ID,
    sourceId: 'failed-source-id',
  });
  const failedResult = withResultHash({
    jobId: FAILED_JOB_ID,
    ordinal: 1,
    inputHash: failedInputHash,
    workers: [{
      phase: 'jd_cleaner', model: 'test-model', effort: 'high', promptVersion: 'jd-cleaner-v2',
      startedAt: resultPayload.runner.startedAt, completedAt: resultPayload.runner.completedAt,
      invocationReceipt: 'codex-thread:test;failed',
    }],
    result: { kind: 'safe_failure', code: 'worker_invocation_failed', detail: 'content filter' },
  });
  resultPayload.batch.manifestHash = manifestHash;
  resultPayload.results.push(failedResult as never);
  delete (resultPayload as Record<string, unknown>).resultHash;
  const hashedResult = withResultHash(resultPayload);
  return { state, resultJson: canonicalJson(hashedResult), resultPayload: hashedResult };
}

function fakePrisma(initial: FakeState): { prisma: PrismaClient; state: () => FakeState } {
  let state = structuredClone(initial);

  function client(target: FakeState, transactional: boolean) {
    let rawQueryCount = 0;
    return {
      scoringBatch: {
        findUnique: async ({ where }: { where: { id: string } }) => where.id === target.batch.id ? target.batch : null,
        update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          if (where.id !== target.batch.id) throw new Error('batch not found');
          Object.assign(target.batch, data);
          return target.batch;
        },
      },
      scoringBatchItem: {
        update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const item = target.batch.items.find((candidate) => candidate.id === where.id);
          if (!item) throw new Error('item not found');
          Object.assign(item, data);
          return item;
        },
      },
      job: {
        findMany: async () => target.jobs,
        findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
          const job = target.jobs.find((candidate) => candidate.id === where.id);
          if (!job) throw new Error('job not found');
          return job;
        },
        update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const job = target.jobs.find((candidate) => candidate.id === where.id);
          if (!job) throw new Error('job not found');
          Object.assign(job, data);
          return job;
        },
      },
      jobScoringArtifact: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          target.artifacts.push(data);
          return data;
        },
      },
      jobScoreEvent: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          target.scoreEvents.push(data);
          return data;
        },
      },
      $queryRaw: async () => {
        if (!transactional) throw new Error('row locks require a transaction');
        rawQueryCount += 1;
        if (rawQueryCount === 1) return [{ id: target.batch.id }];
        return target.jobs.map((job) => ({ id: job.id, updatedAt: job.updatedAt }));
      },
    };
  }

  const root = client(state, false) as Record<string, unknown>;
  root.$transaction = async (callback: (tx: unknown) => Promise<unknown>) => {
    const working = structuredClone(state);
    const result = await callback(client(working, true));
    state = working;
    return result;
  };
  return { prisma: root as unknown as PrismaClient, state: () => state };
}

function observableState(state: FakeState) {
  return {
    batchStatus: state.batch.status,
    acceptedResultHash: state.batch.acceptedResultHash,
    item: state.batch.items[0],
    job: state.jobs[0],
    artifacts: state.artifacts,
    scoreEvents: state.scoreEvents,
  };
}

test('nonterminal historical v1 preview is zero-write and requires release plus v2 re-export', async () => {
  const { state, resultJson } = fixture();
  const fake = fakePrisma(state);
  const before = structuredClone(observableState(fake.state()));
  await assert.rejects(
    previewScoringImport(fake.prisma, resultJson, { approvalSecret: SECRET }),
    /legacy_nonterminal_requires_release_and_v2_reexport/,
  );
  assert.deepEqual(observableState(fake.state()), before);
});

test('historical nonterminal retirement precedes current-version reconciliation', async () => {
  const { state, resultJson } = fixture();
  state.batch.inputVersionsHash = HASH;
  const fake = fakePrisma(state);
  const before = structuredClone(observableState(fake.state()));
  await assert.rejects(
    previewScoringImport(fake.prisma, resultJson, { approvalSecret: SECRET }),
    /legacy_nonterminal_requires_release_and_v2_reexport/,
  );
  assert.deepEqual(observableState(fake.state()), before);
});

test('completed exact replay remains readable after input-version retirement', async () => {
  const { state, resultJson, resultPayload } = fixture();
  state.batch.status = 'completed';
  state.batch.acceptedResultHash = resultPayload.resultHash;
  state.batch.inputVersionsHash = HASH;
  state.batch.items[0].status = 'imported';
  const fake = fakePrisma(state);
  const previewed = await previewScoringImport(fake.prisma, resultJson, { approvalSecret: SECRET });
  assert.deepEqual(previewed.receipt, { batchId: BATCH_ID, resultHash: resultPayload.resultHash, idempotentReplay: true, imported: 1, released: 0 });
});

test('historical mixed nonterminal result cannot bypass v2 cutover', async () => {
  const { state, resultJson } = mixedFixture();
  const fake = fakePrisma(state);
  const before = structuredClone(fake.state());
  await assert.rejects(
    previewScoringImport(fake.prisma, resultJson, { approvalSecret: SECRET }),
    /legacy_nonterminal_requires_release_and_v2_reexport/,
  );
  assert.deepEqual(fake.state(), before);
});

test('historical nonterminal apply rolls back without any scoring write', async () => {
  const { state, resultJson } = fixture();
  const fake = fakePrisma(state);
  const before = structuredClone(observableState(fake.state()));
  await assert.rejects(
    applyScoringImport(fake.prisma, resultJson, 'not-used-for-retired-v1', { approvalSecret: SECRET }),
    /legacy_nonterminal_requires_release_and_v2_reexport/,
  );
  assert.deepEqual(observableState(fake.state()), before);
});

test('completed historical v1 replay is idempotent and divergent replay fails', async () => {
  const { state, resultJson, resultPayload } = fixture();
  state.batch.status = 'completed';
  state.batch.acceptedResultHash = resultPayload.resultHash;
  state.batch.items[0].status = 'imported';
  const fake = fakePrisma(state);
  const replay = await applyScoringImport(fake.prisma, resultJson, 'unused-on-completed-exact-replay', { approvalSecret: SECRET });
  assert.deepEqual(replay, { batchId: BATCH_ID, resultHash: resultPayload.resultHash, idempotentReplay: true, imported: 1, released: 0 });
  assert.equal(fake.state().artifacts.length, 0);
  assert.equal(fake.state().scoreEvents.length, 0);

  const changedBase = Object.fromEntries(Object.entries(resultPayload).filter(([key]) => key !== 'resultHash'));
  const divergent = withResultHash({ ...changedBase, runner: { ...resultPayload.runner, invocationReceipt: 'different-valid-receipt' } });
  await assert.rejects(
    applyScoringImport(fake.prisma, canonicalJson(divergent), 'unused', { approvalSecret: SECRET }),
    /completed batch rejects divergent replay/,
  );
});
