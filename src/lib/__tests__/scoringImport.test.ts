import assert from 'node:assert/strict';
import test from 'node:test';

import type { PrismaClient } from '@prisma/client';

import { createScoringApprovalToken, verifyScoringApprovalToken } from '../scoringApproval';
import { canonicalJson, canonicalJsonSha256, normalizedTextSha256 } from '../scoringCanonicalJson';
import { applyScoringImport, previewScoringImport } from '../scoringImport';
import { scoringManifestHash } from '../scoringInputBinding';
import { AIM_HARD_STOP_CODES } from '../scoringPolicy';

const BATCH_ID = '11111111-1111-4111-8111-111111111111';
const ITEM_ID = '22222222-2222-4222-8222-222222222222';
const JOB_ID = '33333333-3333-4333-8333-333333333333';
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
        cleanerVersion: 'jd-cleaner-v1',
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
      promptVersion: 'aim-runner-v1',
      startedAt: createdAt.toISOString(),
      completedAt: submittedAt.toISOString(),
      invocationReceipt: 'test-runner-receipt',
    },
    results: [itemResult],
  });
  const inputSnapshot = {
    ...exportPayload.jobs[0],
    globalInputVersionsHash: HASH,
    binding: {
      stage: 'aim',
      protocolVersion: 'career-dashboard-scoring-protocol-v1',
      schemaVersion: 'career-dashboard-aim-export-v1',
      globalInputVersionsHash: HASH,
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
      inputVersionsHash: HASH,
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

test('preview is zero-write and approval binds the exact preview with expiry', async () => {
  const { state, resultJson } = fixture();
  const fake = fakePrisma(state);
  const before = structuredClone(observableState(fake.state()));
  const previewed = await previewScoringImport(fake.prisma, resultJson, { approvalSecret: SECRET });

  assert.equal(previewed.preview.applicable, true);
  assert.equal(previewed.preview.projections[0].score, 67);
  assert.ok(previewed.approvalToken);
  assert.deepEqual(observableState(fake.state()), before);

  const expected = {
    batchId: BATCH_ID,
    resultHash: previewed.preview.resultHash,
    preview: previewed.preview,
  };
  assert.doesNotThrow(() => verifyScoringApprovalToken(previewed.approvalToken!, expected, { secret: SECRET }));
  assert.throws(
    () => verifyScoringApprovalToken(previewed.approvalToken!, { ...expected, preview: { changed: true } }, { secret: SECRET }),
    /does not bind this preview/,
  );
  const expired = createScoringApprovalToken(expected, { now: new Date(0), ttlMs: 1_000, secret: SECRET });
  assert.throws(() => verifyScoringApprovalToken(expired.token, expected, { now: new Date(1_001), secret: SECRET }), /expired/);
});

test('forced mid-transaction failure rolls back every scoring write', async () => {
  const { state, resultJson } = fixture();
  const fake = fakePrisma(state);
  const previewed = await previewScoringImport(fake.prisma, resultJson, { approvalSecret: SECRET });
  const before = structuredClone(observableState(fake.state()));

  await assert.rejects(
    applyScoringImport(fake.prisma, resultJson, previewed.approvalToken!, {
      approvalSecret: SECRET,
      injectFailureAfterItems: 1,
    }),
    /injected scoring import failure/,
  );
  assert.deepEqual(observableState(fake.state()), before);
});

test('successful apply is atomic, binds the cleaned artifact, and exact replay is idempotent', async () => {
  const { state, resultJson, resultPayload } = fixture();
  const fake = fakePrisma(state);
  const previewed = await previewScoringImport(fake.prisma, resultJson, { approvalSecret: SECRET });
  const receipt = await applyScoringImport(fake.prisma, resultJson, previewed.approvalToken!, { approvalSecret: SECRET });
  const committed = fake.state();

  assert.deepEqual(receipt, { batchId: BATCH_ID, resultHash: resultPayload.resultHash, idempotentReplay: false, imported: 1 });
  assert.equal(committed.batch.status, 'completed');
  assert.equal(committed.batch.acceptedResultHash, resultPayload.resultHash);
  assert.equal(committed.batch.items[0].status, 'imported');
  assert.equal(committed.artifacts.length, 1);
  assert.equal(committed.scoreEvents.length, 1);
  assert.equal(committed.batch.items[0].cleanedArtifactId, committed.artifacts[0].id);
  assert.equal(committed.scoreEvents[0].cleanedJdArtifactId, committed.artifacts[0].id);
  assert.equal(committed.jobs[0].aimFitScore, 67);
  assert.equal(committed.jobs[0].status, 'pending_af');

  const replay = await applyScoringImport(fake.prisma, resultJson, 'unused-on-completed-exact-replay', { approvalSecret: SECRET });
  assert.deepEqual(replay, { batchId: BATCH_ID, resultHash: resultPayload.resultHash, idempotentReplay: true, imported: 1 });
  assert.equal(fake.state().artifacts.length, 1);
  assert.equal(fake.state().scoreEvents.length, 1);

  const changedBase = Object.fromEntries(Object.entries(resultPayload).filter(([key]) => key !== 'resultHash'));
  const divergent = withResultHash({ ...changedBase, runner: { ...resultPayload.runner, invocationReceipt: 'different-valid-receipt' } });
  await assert.rejects(
    applyScoringImport(fake.prisma, canonicalJson(divergent), 'unused', { approvalSecret: SECRET }),
    /completed batch rejects divergent replay/,
  );
});
