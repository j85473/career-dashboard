import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type { PrismaClient } from '@prisma/client';

import {
  aimResultEnvelopeHash,
  aimResultItemHash,
} from '../aimIdentity';
import { canonicalJson, canonicalJsonSha256 } from '../scoringCanonicalJson';
import {
  AIM_EXPERIENCE_QUEUE_MINIMUM_SCORE,
  aimAdvancesToExperienceQueue,
  applyScoringImport,
  experienceSourceAimAuthorityIsCurrent,
  jobUpdateForScoringFailure,
  previewScoringImport,
  scoringFailurePreviewFields,
} from '../scoringImport';
import { currentScoringInputVersions } from '../scoringInputVersions';
import { SCORING_IMPORT_TRANSACTION_TIMEOUT_MS } from '../scoringLimits';

const SECRET = 'test-only-scoring-approval-secret-32-bytes-minimum';
const NOW = new Date('2026-08-13T12:30:00.000Z');
const FIXTURE_ROOT = path.join(process.cwd(), 'tests/fixtures/scoring/aim-v2');

test('Aim and Experience technical failures both move to Action Needed', () => {
  assert.deepEqual(jobUpdateForScoringFailure('aim', 'worker unavailable'), {
    scoringStatus: 'failed',
    scoreError: 'Aim Fit could not score this job: worker unavailable',
  });
  assert.deepEqual(jobUpdateForScoringFailure('experience', 'worker unavailable'), {
    scoringStatus: 'failed',
    scoreError: 'Experience Fit could not score this job: worker unavailable',
    reqFitScore: null,
    reqFitRationale: null,
  });
  const experiencePreview = scoringFailurePreviewFields('experience', undefined, undefined);
  assert.deepEqual(experiencePreview, { lifecycleAction: 'action_needed' });
  assert.doesNotThrow(() => canonicalJson({ projections: [experiencePreview] }));
  assert.deepEqual(scoringFailurePreviewFields('aim', 'retry-key', 2), {
    lifecycleAction: 'action_needed',
    failureSeriesOrdinal: 3,
    suppressionActiveAfterApply: true,
  });
});

test('a scored survivor only advances to the Experience queue at or above the Dashboard floor', () => {
  assert.equal(AIM_EXPERIENCE_QUEUE_MINIMUM_SCORE, 60);
  assert.equal(
    aimAdvancesToExperienceQueue({ variant: 'scored_survivor', score: AIM_EXPERIENCE_QUEUE_MINIMUM_SCORE }),
    true,
    'exactly at the floor advances',
  );
  assert.equal(
    aimAdvancesToExperienceQueue({ variant: 'scored_survivor', score: AIM_EXPERIENCE_QUEUE_MINIMUM_SCORE - 1 }),
    false,
    'one point under the floor is withheld',
  );
  assert.equal(
    aimAdvancesToExperienceQueue({ variant: 'scored_survivor', score: 100 }),
    true,
  );
  assert.equal(
    aimAdvancesToExperienceQueue({ variant: 'scored_survivor', score: 0 }),
    false,
  );
});

test('a Stage 1 kill never advances to the Experience queue regardless of score', () => {
  // These variants never carry a score (see the terminal-result builder), but
  // the floor check must not accidentally treat a killed job as eligible.
  for (const variant of ['local_policy_kill', 'factual_screen_kill', 'compensation_floor_kill']) {
    assert.equal(aimAdvancesToExperienceQueue({ variant, score: null }), false, variant);
    assert.equal(aimAdvancesToExperienceQueue({ variant, score: 100 }), false, variant);
  }
});

test('Experience import treats Aim transport-version drift as informational', () => {
  const sourceEvent = {
    id: '14444444-4444-4444-8444-444444444444',
    jobId: '13333333-3333-4333-8333-333333333333',
    evaluationType: 'aim_fit',
    schemaVersion: 'career-dashboard-aim-result-v2',
    staleAt: null,
    passed: true,
    aimFactualExtractionId: '15555555-5555-4555-8555-555555555555',
    semanticResultHash: 'a'.repeat(64),
    inputBindings: { globalInputVersionsHash: 'historical-transport-only-version' },
  };
  const continuity = {
    sourceEvent,
    newestAimEventId: sourceEvent.id,
    jobId: sourceEvent.jobId,
    aimFactualExtractionId: sourceEvent.aimFactualExtractionId,
    aimSemanticResultHash: sourceEvent.semanticResultHash,
  };

  assert.equal(experienceSourceAimAuthorityIsCurrent(continuity), true);
  assert.equal(experienceSourceAimAuthorityIsCurrent({
    ...continuity,
    newestAimEventId: '16666666-6666-4666-8666-666666666666',
  }), false);
  assert.equal(experienceSourceAimAuthorityIsCurrent({
    ...continuity,
    sourceEvent: { ...sourceEvent, staleAt: NOW },
  }), false);
  assert.equal(experienceSourceAimAuthorityIsCurrent({
    ...continuity,
    aimSemanticResultHash: 'b'.repeat(64),
  }), false);
});

// Dynamic golden-exchange mutation is the purpose of this adversarial test harness.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonRecord = Record<string, any>;
type V2State = {
  batch: JsonRecord & { items: JsonRecord[] };
  jobs: JsonRecord[];
  extractions: JsonRecord[];
  scoreEvents: JsonRecord[];
  failureReceipts: JsonRecord[];
};

function readFixture(name: string): JsonRecord {
  return JSON.parse(readFileSync(path.join(FIXTURE_ROOT, name), 'utf8')) as JsonRecord;
}

function stateFromFixtures(exportName: string, resultName: string): {
  state: V2State;
  resultPayload: JsonRecord;
  resultJson: string;
} {
  const exported = readFixture(exportName);
  const resultPayload = readFixture(resultName);
  return stateFromPayloads(exported, resultPayload);
}

function stateFromPayloads(exported: JsonRecord, resultPayload: JsonRecord): {
  state: V2State;
  resultPayload: JsonRecord;
  resultJson: string;
} {
  const versions = currentScoringInputVersions();
  const exportJson = canonicalJson(exported);
  const batchAuthority = exported.batch as JsonRecord;
  const createdAt = new Date(batchAuthority.createdAt);
  const items = (exported.jobs as JsonRecord[]).map((job, index) => ({
    id: `92222222-2222-4222-8222-${String(index + 1).padStart(12, '0')}`,
    batchId: batchAuthority.id,
    jobId: job.jobId,
    stage: 'aim',
    ordinal: index,
    status: 'leased',
    submittedUpdatedAt: new Date(job.submittedUpdatedAt),
    sourceJdHash: job.source.sourceJdHash,
    inputHash: job.inputHash,
    inputSnapshot: { ...job, globalInputVersionsHash: versions.aimInputVersionsHash },
    sourceAimEventId: null,
    aimFactualExtractionId: job.reuse?.aimFactualExtractionId ?? null,
    cleanedArtifactId: null,
    latestPacketPlanHash: null,
    manualRetryOfFailureReceiptId: null,
    manualRetryReason: null,
    acceptedResultHash: null,
    acceptedResultSnapshot: null,
    importedScoreEventId: null,
    createdAt,
    importedAt: null,
    releasedAt: null,
  }));
  const batch = {
    id: batchAuthority.id,
    stage: 'aim',
    status: 'exported',
    schemaVersion: exported.schemaVersion,
    protocolVersion: batchAuthority.protocolVersion,
    policyVersion: batchAuthority.scoringPolicyVersion,
    exportHash: canonicalJsonSha256(exported),
    manifestHash: batchAuthority.manifestHash,
    preferenceHash: null,
    employerOverridesHash: null,
    resumeHash: null,
    evidenceHash: null,
    inputVersionsHash: versions.aimInputVersionsHash,
    questionRegistryHash: batchAuthority.questionRegistryHash,
    promptContractHash: batchAuthority.promptContractHash,
    responseContractHash: batchAuthority.responseContractHash,
    runnerProtocolHash: batchAuthority.runnerProtocolHash,
    packetStrategyHash: batchAuthority.packetStrategyHash,
    scoringPolicyHash: batchAuthority.scoringPolicyHash,
    anonymizationPolicyHash: batchAuthority.anonymizationPolicyHash,
    resultBuilderSemanticVersion: batchAuthority.resultBuilderSemanticVersion,
    manifestSnapshot: (exported.jobs as JsonRecord[]).map((job) => ({
      ordinal: job.ordinal, jobId: job.jobId, inputHash: job.inputHash,
    })),
    exportJson,
    exportByteLength: Buffer.byteLength(exportJson),
    acceptedResultHash: null,
    createdAt,
    expiresAt: new Date(batchAuthority.expiresAt),
    completedAt: null,
    releasedAt: null,
    supersededAt: null,
    supersededReason: null,
    items,
  };
  const jobs = (exported.jobs as JsonRecord[]).map((job, index) => ({
    id: job.jobId,
    updatedAt: new Date(job.submittedUpdatedAt),
    status: 'pending_af',
    tailoringStaged: false,
    source: 'fixture',
    sourceId: `fixture-${index}`,
    company: job.trustedMetadata.company,
    title: job.trustedMetadata.title,
    location: job.trustedMetadata.location,
    description: job.source.originalJd,
    aimFitScore: null,
    reqFitScore: null,
    travelScore: null,
    fitCategory: 'fixture',
    scoringStatus: 'queued',
    passReason: 'fixture',
  }));
  return {
    state: { batch, jobs, extractions: [], scoreEvents: [], failureReceipts: [] },
    resultPayload,
    resultJson: canonicalJson(resultPayload),
  };
}

function queryText(args: unknown[]): string {
  const first = args[0] as { strings?: readonly string[] } | readonly string[] | undefined;
  if (Array.isArray(first)) return first.join('?');
  if (first && Array.isArray((first as { strings?: readonly string[] }).strings)) {
    return (first as { strings: readonly string[] }).strings.join('?');
  }
  return String(first ?? '');
}

function fakePrisma(
  initial: V2State,
  options: { serializableConflicts?: number } = {},
): { prisma: PrismaClient; state: () => V2State; transactionOptions: () => JsonRecord | null } {
  let state = structuredClone(initial);
  let serializableConflicts = options.serializableConflicts ?? 0;
  let latestTransactionOptions: JsonRecord | null = null;

  function client(target: V2State, transactional: boolean): JsonRecord {
    return {
      scoringBatch: {
        findUnique: async ({ where }: JsonRecord) => where.id === target.batch.id ? target.batch : null,
        update: async ({ where, data }: JsonRecord) => {
          if (where.id !== target.batch.id) throw new Error('batch not found');
          Object.assign(target.batch, data);
          return target.batch;
        },
      },
      scoringBatchItem: {
        update: async ({ where, data }: JsonRecord) => {
          const item = target.batch.items.find((candidate) => candidate.id === where.id);
          if (!item) throw new Error('item not found');
          Object.assign(item, data);
          return item;
        },
        count: async ({ where }: JsonRecord) => target.batch.items.filter((item) => (
          item.batchId === where.batchId && item.status === where.status
        )).length,
      },
      job: {
        findMany: async ({ where, select }: JsonRecord = {}) => {
          const idClause = where?.id || where?.AND?.[0]?.id;
          const ids = idClause?.in as string[] | undefined;
          const candidates = ids ? target.jobs.filter((job) => ids.includes(job.id)) : target.jobs;
          if (select?._count) return candidates.map((job) => ({
            ...job,
            fitScore: job.fitScore ?? null,
            fitRationale: job.fitRationale ?? null,
            pipelineEvents: job.pipelineEvents || [],
            _count: { scoreEvents: target.scoreEvents.filter((event) => event.jobId === job.id).length },
          }));
          const predicate = where?.AND?.[1];
          if (!predicate) return candidates;
          const active = (job: JsonRecord) => ['pending_af', 'inbox'].includes(job.status)
            && job.tailoringStaged === false;
          if (predicate.OR?.[0]?.status === 'pending_af') {
            return candidates.filter((job) => active(job) && (
              job.status === 'pending_af'
              || ['needs_jd', 'queued', 'scoring', 'failed'].includes(job.scoringStatus)
            ));
          }
          if (predicate.OR?.[0]?.scoringStatus === 'needs_jd') {
            return candidates.filter((job) => active(job) && job.scoringStatus === 'needs_jd');
          }
          if (predicate.scoringStatus?.in?.includes('queued')) {
            return candidates.filter((job) => active(job) && ['queued', 'scoring'].includes(job.scoringStatus));
          }
          if (predicate.scoringStatus === 'scored' && predicate.aimFitScore === null) {
            return candidates.filter((job) => active(job) && job.scoringStatus === 'scored' && job.aimFitScore == null);
          }
          if (predicate.scoringStatus === 'scored' && predicate.aimFitScore?.not === null) {
            return candidates.filter((job) => active(job) && job.scoringStatus === 'scored'
              && job.aimFitScore != null && job.reqFitScore == null);
          }
          if (predicate.OR?.[0]?.scoringStatus === 'failed') {
            return candidates.filter((job) => active(job) && job.scoringStatus === 'failed');
          }
          return [];
        },
        findUniqueOrThrow: async ({ where }: JsonRecord) => {
          const job = target.jobs.find((candidate) => candidate.id === where.id);
          if (!job) throw new Error('job not found');
          return job;
        },
        update: async ({ where, data }: JsonRecord) => {
          const job = target.jobs.find((candidate) => candidate.id === where.id);
          if (!job) throw new Error('job not found');
          Object.assign(job, data);
          return job;
        },
      },
      aimFactualExtraction: {
        findUnique: async ({ where }: JsonRecord) => {
          const key = where.jobId_extractionIdentity_scope;
          return target.extractions.find((row) => row.jobId === key.jobId
            && row.extractionIdentity === key.extractionIdentity && row.scope === key.scope) ?? null;
        },
        findMany: async ({ where }: JsonRecord) => target.extractions.filter((row) => (
          row.jobId === where.jobId && row.extractionIdentity === where.extractionIdentity
          && (where.staleAt === undefined || row.staleAt === where.staleAt)
        )),
        create: async ({ data }: JsonRecord) => {
          const row = { ...data, staleAt: null, staleReason: null, createdAt: NOW };
          target.extractions.push(row);
          return row;
        },
      },
      aimScoringFailureReceipt: {
        groupBy: async ({ where }: JsonRecord) => (where.retrySeriesKey.in as string[]).flatMap((key) => {
          const rows = target.failureReceipts.filter((row) => row.retrySeriesKey === key);
          return rows.length ? [{ retrySeriesKey: key, _max: { seriesOrdinal: Math.max(...rows.map((row) => row.seriesOrdinal)) } }] : [];
        }),
        findMany: async ({ where }: JsonRecord) => {
          if (where.suppressionActive === true) {
            const ids = where.jobId?.in as string[] | undefined;
            return target.failureReceipts
              .filter((row) => row.suppressionActive && row.clearedAt === null
                && (!ids || ids.includes(row.jobId)))
              .map((row) => ({ ...row, job: target.jobs.find((job) => job.id === row.jobId) }));
          }
          return target.failureReceipts
            .filter((row) => row.jobId === where.jobId && row.retrySeriesKey === where.retrySeriesKey)
            .sort((left, right) => right.seriesOrdinal - left.seriesOrdinal)
            .slice(0, 1);
        },
        create: async ({ data }: JsonRecord) => {
          const row = {
            id: `failure-${target.failureReceipts.length + 1}`,
            ...data,
            clearedAt: null,
            clearedReason: null,
            clearedActor: null,
            createdAt: NOW,
          };
          target.failureReceipts.push(row);
          return row;
        },
        updateMany: async () => ({ count: 0 }),
      },
      jobScoreEvent: {
        create: async ({ data }: JsonRecord) => {
          const row = { ...data, createdAt: NOW, staleAt: null, staleReason: null };
          target.scoreEvents.push(row);
          return row;
        },
      },
      $queryRaw: async (...args: unknown[]) => {
        if (!transactional) throw new Error('row locks require a transaction');
        const sql = queryText(args);
        if (sql.includes('FROM "ScoringBatch"')) return [{ id: target.batch.id }];
        if (sql.includes('FROM "ScoringBatchItem"')) return target.batch.items.map((item) => ({ id: item.id }));
        if (sql.includes('FROM "Job"')) return target.jobs.map((job) => ({ id: job.id, updatedAt: job.updatedAt }));
        return [];
      },
    };
  }

  const root = client(state, false);
  root.$transaction = async (callback: (tx: unknown) => Promise<unknown>, transactionOptions: JsonRecord) => {
    latestTransactionOptions = transactionOptions;
    if (serializableConflicts > 0) {
      serializableConflicts -= 1;
      throw Object.assign(new Error('fixture serialization conflict'), { code: 'P2034' });
    }
    const working = structuredClone(state);
    const result = await callback(client(working, true));
    state = working;
    return result;
  };
  return {
    prisma: root as PrismaClient,
    state: () => state,
    transactionOptions: () => latestTransactionOptions,
  };
}

function observable(state: V2State): unknown {
  return structuredClone(state);
}

function rehashAimResult(payload: JsonRecord): JsonRecord {
  const copy = structuredClone(payload);
  copy.results = copy.results.map((raw: JsonRecord) => {
    const item = { ...raw };
    delete item.resultHash;
    return { ...item, resultHash: aimResultItemHash(item) };
  });
  delete copy.resultHash;
  copy.resultHash = aimResultEnvelopeHash(copy);
  return copy;
}

test('v2 calibration artifacts are rejected before preview can authorize an import', async () => {
  const fixture = stateFromFixtures('valid-export.json', 'valid-scored-result.json');
  const fake = fakePrisma(fixture.state);
  const before = observable(fake.state());
  const calibration = rehashAimResult({ ...fixture.resultPayload, artifactPurpose: 'calibration' });
  await assert.rejects(
    previewScoringImport(fake.prisma, canonicalJson(calibration), { approvalSecret: SECRET, now: NOW }),
    /calibration Aim artifacts are not importable/,
  );
  assert.deepEqual(observable(fake.state()), before);
});

test('v2 preview is zero-write, rebuilds arithmetic, and binds approval to exact bytes', async () => {
  const { state, resultJson, resultPayload } = stateFromFixtures('valid-export.json', 'valid-scored-result.json');
  const fake = fakePrisma(state);
  const before = observable(fake.state());
  const previewed = await previewScoringImport(fake.prisma, resultJson, { approvalSecret: SECRET, now: NOW });
  assert.equal(previewed.preview.applicable, true);
  assert.equal(previewed.preview.projections[0].variant, 'scored_survivor');
  assert.equal(previewed.preview.projections[0].score, 50);
  assert.ok(previewed.approvalToken);
  assert.deepEqual(observable(fake.state()), before);

  const forged = structuredClone(resultPayload);
  forged.results[0].result.score = 1;
  const rehashed = rehashAimResult(forged);
  await assert.rejects(
    previewScoringImport(fake.prisma, canonicalJson(rehashed), { approvalSecret: SECRET, now: NOW }),
    /application-owned deterministic rebuild/,
  );
  assert.deepEqual(observable(fake.state()), before);
});

test('v2 preview and apply accept a checkpoint-built Stage 1 factual-screen kill', async () => {
  const fixture = stateFromFixtures('valid-stage1-kill-export.json', 'valid-stage1-kill-result.json');
  const fake = fakePrisma(fixture.state);
  const before = observable(fake.state());
  const previewed = await previewScoringImport(fake.prisma, fixture.resultJson, {
    approvalSecret: SECRET,
    now: NOW,
  });

  assert.equal(previewed.preview.applicable, true);
  assert.equal(previewed.preview.acceptedCount, 1);
  assert.equal(previewed.preview.safeFailureCount, 0);
  assert.equal(previewed.preview.projections[0].variant, 'factual_screen_kill');
  assert.equal(previewed.preview.projections[0].decision, 'killed_by_factual_screen');
  assert.equal(previewed.preview.projections[0].score, null);
  assert.deepEqual(observable(fake.state()), before);

  const receipt = await applyScoringImport(
    fake.prisma,
    fixture.resultJson,
    previewed.approvalToken!,
    { approvalSecret: SECRET, now: NOW },
  );
  assert.equal(receipt.imported, 1);
  assert.equal(receipt.released, 0);
  assert.equal(fake.state().batch.items[0].status, 'imported');
  assert.equal(fake.state().jobs[0].status, 'dismissed');
  assert.equal(fake.state().scoreEvents.length, 1);
  assert.equal(fake.state().extractions.length, 1);
});

test('v2 apply retries bounded serializable conflicts and commits once', async () => {
  const fixture = stateFromFixtures('valid-export.json', 'valid-scored-result.json');
  const fake = fakePrisma(fixture.state, { serializableConflicts: 2 });
  const previewed = await previewScoringImport(fake.prisma, fixture.resultJson, {
    approvalSecret: SECRET,
    now: NOW,
  });
  const receipt = await applyScoringImport(
    fake.prisma,
    fixture.resultJson,
    previewed.approvalToken!,
    { approvalSecret: SECRET, now: NOW },
  );
  assert.equal(receipt.idempotentReplay, false);
  assert.equal(fake.state().scoreEvents.length, 1);
  assert.equal(fake.state().extractions.length, 1);
  assert.equal(SCORING_IMPORT_TRANSACTION_TIMEOUT_MS, 60_000);
  assert.equal(fake.transactionOptions()?.timeout, SCORING_IMPORT_TRANSACTION_TIMEOUT_MS);
});

test('v2 scored apply atomically persists extraction/event, rolls back on injection, and replays exactly', async () => {
  const fixture = stateFromFixtures('valid-export.json', 'valid-scored-result.json');
  const rollbackFake = fakePrisma(fixture.state);
  const rollbackPreview = await previewScoringImport(rollbackFake.prisma, fixture.resultJson, { approvalSecret: SECRET, now: NOW });
  const rollbackBefore = observable(rollbackFake.state());
  await assert.rejects(
    applyScoringImport(rollbackFake.prisma, fixture.resultJson, rollbackPreview.approvalToken!, {
      approvalSecret: SECRET, now: NOW, injectFailureAfterItems: 1,
    }),
    /injected scoring import failure/,
  );
  assert.deepEqual(observable(rollbackFake.state()), rollbackBefore);

  const fake = fakePrisma(fixture.state);
  const previewed = await previewScoringImport(fake.prisma, fixture.resultJson, { approvalSecret: SECRET, now: NOW });
  const receipt = await applyScoringImport(fake.prisma, fixture.resultJson, previewed.approvalToken!, {
    approvalSecret: SECRET, now: NOW,
  });
  assert.deepEqual(receipt, {
    batchId: fixture.state.batch.id,
    resultHash: fixture.resultPayload.resultHash,
    idempotentReplay: false,
    imported: 1,
    released: 0,
  });
  const committed = fake.state();
  assert.equal(committed.batch.status, 'completed');
  assert.equal(committed.batch.items[0].status, 'imported');
  assert.equal(committed.extractions.length, 1);
  assert.equal(committed.scoreEvents.length, 1);
  assert.equal(committed.scoreEvents[0].aimFactualExtractionId, committed.extractions[0].id);
  assert.equal(committed.scoreEvents[0].cleanedJdArtifactId, null);
  assert.equal(committed.jobs[0].aimFitScore, 50);
  // Score persists either way; 50 is below AIM_EXPERIENCE_QUEUE_MINIMUM_SCORE
  // (60), so this scored_survivor is dismissed rather than queued.
  assert.equal(committed.jobs[0].status, 'dismissed');
  assert.equal(committed.jobs[0].fitCategory, 'fixture');
  assert.equal(committed.jobs[0].scoringStatus, 'queued');
  assert.equal(committed.jobs[0].passReason, 'fixture');

  const replay = await applyScoringImport(fake.prisma, fixture.resultJson, 'unused-on-replay', {
    approvalSecret: SECRET, now: NOW,
  });
  assert.equal(replay.idempotentReplay, true);
  assert.equal(fake.state().extractions.length, 1);
  assert.equal(fake.state().scoreEvents.length, 1);

  const divergent = structuredClone(fixture.resultPayload);
  divergent.controller.completedAt = '2026-08-13T12:00:01.000Z';
  const rehashed = rehashAimResult(divergent);
  await assert.rejects(
    applyScoringImport(fake.prisma, canonicalJson(rehashed), 'unused', { approvalSecret: SECRET, now: NOW }),
    /completed batch rejects divergent replay/,
  );
});

test('unstaged pending Manual Import preserves lifecycle through preview and apply', async () => {
  const fixture = stateFromFixtures('valid-export.json', 'valid-scored-result.json');
  fixture.state.jobs[0].source = 'Manual Import';
  fixture.state.jobs[0].status = 'pending_af';
  fixture.state.jobs[0].tailoringStaged = false;
  const fake = fakePrisma(fixture.state);

  const previewed = await previewScoringImport(fake.prisma, fixture.resultJson, {
    approvalSecret: SECRET,
    now: NOW,
  });
  assert.equal(previewed.preview.projections[0].proposedStatus, 'dismissed');
  assert.equal(previewed.preview.projections[0].lifecycleAction, 'preserve_protected');
  assert.equal(previewed.preview.protectedLifecycleCount, 1);

  await applyScoringImport(fake.prisma, fixture.resultJson, previewed.approvalToken!, {
    approvalSecret: SECRET,
    now: NOW,
  });
  assert.equal(fake.state().jobs[0].status, 'pending_af');
  assert.equal(fake.state().jobs[0].aimFitScore, 50);
  assert.equal(fake.state().scoreEvents[0].lifecycleProjection, 'dismissed');
  assert.equal(fake.state().scoreEvents[0].lifecycleApplied, false);
});

test('scoring import protects only effective latest user lifecycle intent', async () => {
  const rawInbox = stateFromFixtures('valid-export.json', 'valid-scored-result.json');
  rawInbox.state.jobs[0].status = 'inbox';
  const rawFake = fakePrisma(rawInbox.state);
  const rawPreview = await previewScoringImport(rawFake.prisma, rawInbox.resultJson, {
    approvalSecret: SECRET, now: NOW,
  });
  assert.equal(rawPreview.preview.projections[0].lifecycleAction, 'apply');
  await applyScoringImport(rawFake.prisma, rawInbox.resultJson, rawPreview.approvalToken!, {
    approvalSecret: SECRET, now: NOW,
  });
  assert.equal(rawFake.state().jobs[0].status, 'dismissed');
  assert.equal(rawFake.state().scoreEvents[0].lifecycleApplied, true);

  const protectedInbox = stateFromFixtures('valid-export.json', 'valid-scored-result.json');
  protectedInbox.state.jobs[0].status = 'inbox';
  protectedInbox.state.jobs[0].pipelineEvents = [{
    id: 'promote', eventType: 'user_promote', occurredAt: new Date('2026-08-13T12:00:00Z'),
    details: { nextStatus: 'inbox' },
  }];
  const protectedFake = fakePrisma(protectedInbox.state);
  const protectedPreview = await previewScoringImport(protectedFake.prisma, protectedInbox.resultJson, {
    approvalSecret: SECRET, now: NOW,
  });
  assert.equal(protectedPreview.preview.projections[0].lifecycleAction, 'preserve_protected');
  await applyScoringImport(
    protectedFake.prisma,
    protectedInbox.resultJson,
    protectedPreview.approvalToken!,
    { approvalSecret: SECRET, now: NOW },
  );
  assert.equal(protectedFake.state().jobs[0].status, 'inbox');
  assert.equal(protectedFake.state().scoreEvents[0].lifecycleApplied, false);

  const rescoredInbox = stateFromFixtures('valid-export.json', 'valid-scored-result.json');
  rescoredInbox.state.jobs[0].status = 'inbox';
  rescoredInbox.state.jobs[0].pipelineEvents = [
    {
      id: 'promote', eventType: 'user_promote', occurredAt: new Date('2026-08-13T11:00:00Z'),
      details: { nextStatus: 'inbox' },
    },
    {
      id: 'rescore', eventType: 'user_rescore', occurredAt: new Date('2026-08-13T12:00:00Z'),
      details: { nextStatus: 'pending_af' },
    },
  ];
  const rescoredFake = fakePrisma(rescoredInbox.state);
  const rescoredPreview = await previewScoringImport(rescoredFake.prisma, rescoredInbox.resultJson, {
    approvalSecret: SECRET, now: NOW,
  });
  assert.equal(rescoredPreview.preview.projections[0].lifecycleAction, 'apply');
  await applyScoringImport(
    rescoredFake.prisma,
    rescoredInbox.resultJson,
    rescoredPreview.approvalToken!,
    { approvalSecret: SECRET, now: NOW },
  );
  assert.equal(rescoredFake.state().jobs[0].status, 'dismissed');
  assert.equal(rescoredFake.state().scoreEvents[0].lifecycleApplied, true);
});

test('raw user-facing statuses are not scoring-import authority without effective intent', () => {
  const source = readFileSync(path.join(process.cwd(), 'src/lib/scoringImport.ts'), 'utf8');
  const policy = source.slice(
    source.indexOf('function lifecycleProtected'),
    source.indexOf('/**\n * Dashboard-owned floor'),
  );
  assert.match(policy, /latestUserLifecycleIntent/);
  assert.match(policy, /'applied', 'interviewing', 'expired', 'archived', 'cooldown'/);
  assert.doesNotMatch(policy, /'inbox'|'passed'|'dismissed'|'bookmarked'/);
});

test('v2 mixed apply imports complete jobs and sends safe failures to Action Needed', async () => {
  const fixture = stateFromFixtures('valid-mixed-export.json', 'valid-mixed-result.json');
  const fake = fakePrisma(fixture.state);
  const previewed = await previewScoringImport(fake.prisma, fixture.resultJson, { approvalSecret: SECRET, now: NOW });
  assert.equal(previewed.preview.acceptedCount, 1);
  assert.equal(previewed.preview.safeFailureCount, 1);
  assert.equal(previewed.preview.projections[1].lifecycleAction, 'action_needed');
  assert.equal(previewed.preview.projections[1].suppressionActiveAfterApply, true);
  const receipt = await applyScoringImport(fake.prisma, fixture.resultJson, previewed.approvalToken!, {
    approvalSecret: SECRET, now: NOW,
  });
  assert.equal(receipt.imported, 1);
  assert.equal(receipt.released, 1);
  assert.deepEqual(fake.state().batch.items.map((item) => item.status), ['imported', 'released']);
  assert.equal(fake.state().scoreEvents.length, 1);
  assert.equal(fake.state().extractions.length, 1);
  assert.equal(fake.state().failureReceipts.length, 1);
  assert.equal(fake.state().failureReceipts[0].suppressionActive, true);
  assert.equal(fake.state().jobs[1].status, 'pending_af');
  assert.equal(fake.state().jobs[1].scoringStatus, 'failed');
  assert.match(fake.state().jobs[1].scoreError, /^Aim Fit could not score this job:/);
  assert.equal(fake.state().jobs[1].aimFitScore, null);
});

test('v2 preview rejects safe failures with impossible worker or attempt provenance', async () => {
  const fixture = stateFromFixtures('valid-mixed-export.json', 'valid-mixed-result.json');

  const forgedWorker = structuredClone(fixture.resultPayload);
  forgedWorker.results[1].workers = [structuredClone(forgedWorker.results[0].workers[0])];
  forgedWorker.results[1].packetPlanHash = forgedWorker.results[0].packetPlanHash;
  forgedWorker.controller.totalModelCalls += 1;
  forgedWorker.controller.invocationReceipt = `aim-two-stage-calls:${forgedWorker.controller.totalModelCalls};run:${forgedWorker.batch.id}`;
  await assert.rejects(
    previewScoringImport(
      fakePrisma(fixture.state).prisma,
      canonicalJson(rehashAimResult(forgedWorker)),
      { approvalSecret: SECRET, now: NOW },
    ),
    /source_unusable failure has impossible worker provenance/,
  );

  const forgedAttempts = structuredClone(fixture.resultPayload);
  forgedAttempts.results[1].result.attempts = 1;
  await assert.rejects(
    previewScoringImport(
      fakePrisma(fixture.state).prisma,
      canonicalJson(rehashAimResult(forgedAttempts)),
      { approvalSecret: SECRET, now: NOW },
    ),
    /source_unusable failure has impossible worker provenance/,
  );

  const forgedModel = structuredClone(fixture.resultPayload);
  forgedModel.controller.models = forgedModel.controller.models.map((model: JsonRecord) => ({
    ...model,
    model: 'unbound-model',
  }));
  await assert.rejects(
    previewScoringImport(
      fakePrisma(fixture.state).prisma,
      canonicalJson(rehashAimResult(forgedModel)),
      { approvalSecret: SECRET, now: NOW },
    ),
    /worker model does not match its packet/,
  );
});

test('v2 preview accepts an exact Stage 1 Dashboard reuse followed by fresh continuation only', async () => {
  const exported = readFixture('valid-export.json');
  const payload = readFixture('valid-scored-result.json');
  const item = payload.results[0];
  const stage1 = structuredClone(item.result.factualVector);
  const extractionId = '99999999-9999-4999-8999-999999999999';
  exported.jobs[0].reuse = {
    aimFactualExtractionId: extractionId,
    scope: 'stage1',
    extractionIdentity: stage1.extractionIdentity,
    factualVectorHash: stage1.factualVectorHash,
    factualVector: stage1,
  };

  item.workers = item.workers.filter((worker: JsonRecord) => worker.effort === 'high');
  payload.controller.totalModelCalls = item.workers.length;
  payload.controller.models = payload.controller.models.filter((model: JsonRecord) => model.effort === 'high');
  payload.controller.invocationReceipt = `aim-two-stage-calls:${item.workers.length};run:${payload.batch.id}`;
  const rebound = rehashAimResult(payload);
  const fixture = stateFromPayloads(exported, rebound);
  const previewed = await previewScoringImport(
    fakePrisma(fixture.state).prisma,
    fixture.resultJson,
    { approvalSecret: SECRET, now: NOW },
  );
  assert.equal(previewed.preview.applicable, true);
  assert.equal(previewed.preview.projections[0].variant, 'scored_survivor');
});

test('v2 preview rejects a scored survivor without its fresh holistic Stage 2 call', async () => {
  const exported = readFixture('valid-export.json');
  const payload = readFixture('valid-scored-result.json');
  const item = payload.results[0];
  item.workers = item.workers.filter((worker: JsonRecord) => worker.effort === 'medium');
  payload.controller.totalModelCalls = item.workers.length;
  payload.controller.models = payload.controller.models.filter((model: JsonRecord) => model.effort === 'medium');
  payload.controller.invocationReceipt = `aim-two-stage-calls:${item.workers.length};run:${payload.batch.id}`;
  const rebound = rehashAimResult(payload);
  const fixture = stateFromPayloads(exported, rebound);
  await assert.rejects(
    previewScoringImport(
      fakePrisma(fixture.state).prisma,
      fixture.resultJson,
      { approvalSecret: SECRET, now: NOW },
    ),
    /holistic worker/,
  );
});
