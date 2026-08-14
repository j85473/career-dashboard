import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { Prisma, PrismaClient } from '@prisma/client';

import { aimResultEnvelopeHash, aimResultItemHash } from '../../src/lib/aimIdentity';
import { canonicalJson, canonicalJsonSha256 } from '../../src/lib/scoringCanonicalJson';
import { applyScoringImport, previewScoringImport } from '../../src/lib/scoringImport';
import { currentScoringInputVersions } from '../../src/lib/scoringInputVersions';

const VERIFY_DATABASE = '/career_dashboard_scoring_v2_verify';
const ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const SECRET = 'postgres-integration-scoring-approval-secret-32-bytes';
const NOW = new Date('2026-08-13T12:30:00.000Z');
const FIXTURE_ROOT = path.join(process.cwd(), 'tests/fixtures/scoring/aim-v2');

function guardedDatabaseUrl(): string {
  if (process.env.SCORING_V2_MIGRATION_VERIFY_ACTIVE !== '1') {
    throw new Error('PostgreSQL scoring integration runs only through scoring:aim:migration-verify');
  }
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error('guarded PostgreSQL integration requires DATABASE_URL');
  const parsed = new URL(raw);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)
    || parsed.pathname !== VERIFY_DATABASE
    || !ALLOWED_HOSTS.has(parsed.hostname)) {
    throw new Error('refusing nonlocal or non-verification PostgreSQL database');
  }
  return raw;
}

const prisma = new PrismaClient({ datasources: { db: { url: guardedDatabaseUrl() } } });

// Dynamic golden-exchange mutation is the purpose of this guarded integration harness.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonRecord = Record<string, any>;

function fixture(name: string): JsonRecord {
  return JSON.parse(readFileSync(path.join(FIXTURE_ROOT, name), 'utf8')) as JsonRecord;
}

async function emptyVerificationDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "AimScoringFailureReceipt", "JobPipelineEvent", "JobScoreEvent",
      "AimFactualExtraction", "JobScoringArtifact", "ScoringBatchItem", "ScoringBatch", "Job"
    RESTART IDENTITY CASCADE
  `);
}

async function seedAimBatch(exportName: string, options: { firstJobStatus?: string } = {}) {
  const exported = fixture(exportName);
  const versions = currentScoringInputVersions();
  const exportJson = canonicalJson(exported);
  const authority = exported.batch as JsonRecord;
  for (const [index, job] of (exported.jobs as JsonRecord[]).entries()) {
    await prisma.job.create({ data: {
      id: job.jobId,
      title: job.trustedMetadata.title,
      company: job.trustedMetadata.company,
      description: job.source.originalJd,
      location: job.trustedMetadata.location,
      source: 'postgres-fixture',
      sourceId: `postgres-fixture-${index}`,
      postedAt: new Date('2026-08-13T10:00:00.000Z'),
      updatedAt: new Date(job.submittedUpdatedAt),
      status: index === 0 ? options.firstJobStatus ?? 'pending_af' : 'pending_af',
      fitCategory: 'fixture',
      scoringStatus: 'queued',
      passReason: 'fixture-preserved',
    } });
  }
  await prisma.scoringBatch.create({ data: {
    id: authority.id,
    stage: 'aim',
    status: 'exported',
    schemaVersion: exported.schemaVersion,
    protocolVersion: authority.protocolVersion,
    policyVersion: authority.scoringPolicyVersion,
    exportHash: canonicalJsonSha256(exported),
    manifestHash: authority.manifestHash,
    inputVersionsHash: versions.aimInputVersionsHash,
    questionRegistryHash: authority.questionRegistryHash,
    promptContractHash: authority.promptContractHash,
    responseContractHash: authority.responseContractHash,
    runnerProtocolHash: authority.runnerProtocolHash,
    packetStrategyHash: authority.packetStrategyHash,
    scoringPolicyHash: authority.scoringPolicyHash,
    anonymizationPolicyHash: authority.anonymizationPolicyHash,
    resultBuilderSemanticVersion: authority.resultBuilderSemanticVersion,
    manifestSnapshot: (exported.jobs as JsonRecord[]).map((job) => ({
      ordinal: job.ordinal, jobId: job.jobId, inputHash: job.inputHash,
    })) as Prisma.InputJsonValue,
    exportJson,
    exportByteLength: Buffer.byteLength(exportJson),
    createdAt: new Date(authority.createdAt),
    expiresAt: new Date(authority.expiresAt),
  } });
  for (const [index, job] of (exported.jobs as JsonRecord[]).entries()) {
    await prisma.scoringBatchItem.create({ data: {
      id: `a2222222-2222-4222-8222-${String(index + 1).padStart(12, '0')}`,
      batchId: authority.id,
      jobId: job.jobId,
      stage: 'aim',
      ordinal: index,
      status: 'leased',
      submittedUpdatedAt: new Date(job.submittedUpdatedAt),
      sourceJdHash: job.source.sourceJdHash,
      inputHash: job.inputHash,
      inputSnapshot: { ...job, globalInputVersionsHash: versions.aimInputVersionsHash } as Prisma.InputJsonValue,
    } });
  }
  return exported;
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

test.beforeEach(emptyVerificationDatabase);
test.after(async () => prisma.$disconnect());

test('real PostgreSQL mixed apply imports complete items, releases failure items, and replays exactly', async () => {
  const exported = await seedAimBatch('valid-mixed-export.json');
  const result = fixture('valid-mixed-result.json');
  const resultJson = canonicalJson(result);
  const previewed = await previewScoringImport(prisma, resultJson, { approvalSecret: SECRET, now: NOW });
  assert.equal(previewed.preview.acceptedCount, 1);
  assert.equal(previewed.preview.safeFailureCount, 1);
  const applied = await applyScoringImport(prisma, resultJson, previewed.approvalToken!, {
    approvalSecret: SECRET, now: NOW,
  });
  assert.deepEqual({ imported: applied.imported, released: applied.released }, { imported: 1, released: 1 });
  assert.deepEqual(
    (await prisma.scoringBatchItem.findMany({ orderBy: { ordinal: 'asc' } })).map((item) => item.status),
    ['imported', 'released'],
  );
  assert.equal(await prisma.aimFactualExtraction.count(), 1);
  assert.equal(await prisma.jobScoreEvent.count(), 1);
  const failure = await prisma.aimScoringFailureReceipt.findFirstOrThrow();
  assert.equal(failure.suppressionActive, true);
  assert.equal(failure.jobId, exported.jobs[1].jobId);
  const replay = await applyScoringImport(prisma, resultJson, 'unused-on-completed-replay', {
    approvalSecret: SECRET, now: NOW,
  });
  assert.equal(replay.idempotentReplay, true);

  const divergent = structuredClone(result);
  divergent.controller.completedAt = '2026-08-13T12:00:01.000Z';
  await assert.rejects(
    applyScoringImport(prisma, canonicalJson(rehashAimResult(divergent)), 'unused', {
      approvalSecret: SECRET, now: NOW,
    }),
    /completed batch rejects divergent replay/,
  );
});

test('real row locks serialize concurrent identical apply and preserve one event/extraction', async () => {
  await seedAimBatch('valid-export.json');
  const resultJson = canonicalJson(fixture('valid-scored-result.json'));
  const previewed = await previewScoringImport(prisma, resultJson, { approvalSecret: SECRET, now: NOW });
  const outcomes = await Promise.all([
    applyScoringImport(prisma, resultJson, previewed.approvalToken!, { approvalSecret: SECRET, now: NOW }),
    applyScoringImport(prisma, resultJson, previewed.approvalToken!, { approvalSecret: SECRET, now: NOW }),
  ]);
  assert.deepEqual(outcomes.map((outcome) => outcome.idempotentReplay).sort(), [false, true]);
  assert.equal(await prisma.jobScoreEvent.count(), 1);
  assert.equal(await prisma.aimFactualExtraction.count(), 1);
});

test('concurrent divergent apply cannot displace the exact approved result', async () => {
  await seedAimBatch('valid-export.json');
  const result = fixture('valid-scored-result.json');
  const resultJson = canonicalJson(result);
  const previewed = await previewScoringImport(prisma, resultJson, { approvalSecret: SECRET, now: NOW });
  const divergent = structuredClone(result);
  divergent.controller.completedAt = '2026-08-13T12:00:01.000Z';
  const settled = await Promise.allSettled([
    applyScoringImport(prisma, resultJson, previewed.approvalToken!, { approvalSecret: SECRET, now: NOW }),
    applyScoringImport(prisma, canonicalJson(rehashAimResult(divergent)), previewed.approvalToken!, {
      approvalSecret: SECRET, now: NOW,
    }),
  ]);
  assert.equal(settled.filter((outcome) => outcome.status === 'fulfilled').length, 1);
  assert.equal(settled.filter((outcome) => outcome.status === 'rejected').length, 1);
  assert.equal(await prisma.jobScoreEvent.count(), 1);
  assert.equal((await prisma.scoringBatch.findFirstOrThrow()).acceptedResultHash, result.resultHash);
});

test('injected failure rolls back extraction, event, item, job, and batch state', async () => {
  const exported = await seedAimBatch('valid-export.json');
  const resultJson = canonicalJson(fixture('valid-scored-result.json'));
  const previewed = await previewScoringImport(prisma, resultJson, { approvalSecret: SECRET, now: NOW });
  await assert.rejects(
    applyScoringImport(prisma, resultJson, previewed.approvalToken!, {
      approvalSecret: SECRET, now: NOW, injectFailureAfterItems: 1,
    }),
    /injected scoring import failure/,
  );
  assert.equal(await prisma.aimFactualExtraction.count(), 0);
  assert.equal(await prisma.jobScoreEvent.count(), 0);
  assert.equal((await prisma.scoringBatch.findUniqueOrThrow({ where: { id: exported.batch.id } })).status, 'exported');
  assert.equal((await prisma.scoringBatchItem.findFirstOrThrow()).status, 'leased');
  assert.equal((await prisma.job.findUniqueOrThrow({ where: { id: exported.jobs[0].jobId } })).aimFitScore, null);
});

test('partial unique indexes enforce scoring identity and active suppression while permitting cleared history', async () => {
  await seedAimBatch('valid-mixed-export.json');
  const resultJson = canonicalJson(fixture('valid-mixed-result.json'));
  const previewed = await previewScoringImport(prisma, resultJson, { approvalSecret: SECRET, now: NOW });
  await applyScoringImport(prisma, resultJson, previewed.approvalToken!, { approvalSecret: SECRET, now: NOW });
  const event = await prisma.jobScoreEvent.findFirstOrThrow();
  await assert.rejects(prisma.jobScoreEvent.create({ data: {
    jobId: event.jobId,
    evaluationType: 'aim_fit',
    model: 'constraint-test',
    promptVersion: 'constraint-test',
    passed: true,
    scoringIdentity: event.scoringIdentity,
  } }));

  const active = await prisma.aimScoringFailureReceipt.findFirstOrThrow();
  const extraBatchId = 'b1111111-1111-4111-8111-111111111111';
  const extraItemId = 'b2222222-2222-4222-8222-222222222222';
  await prisma.scoringBatch.create({ data: {
    id: extraBatchId, stage: 'aim', status: 'completed', schemaVersion: 'fixture', protocolVersion: 'fixture',
    policyVersion: 'fixture', exportHash: 'c'.repeat(64), manifestHash: 'd'.repeat(64),
    inputVersionsHash: 'e'.repeat(64), manifestSnapshot: [], exportJson: '{}', exportByteLength: 2,
    expiresAt: NOW, completedAt: NOW,
  } });
  await prisma.scoringBatchItem.create({ data: {
    id: extraItemId, batchId: extraBatchId, jobId: active.jobId, stage: 'aim', ordinal: 0,
    status: 'released', submittedUpdatedAt: NOW, sourceJdHash: 'f'.repeat(64), inputHash: '1'.repeat(64),
    inputSnapshot: {}, releasedAt: NOW,
  } });
  const duplicateData = {
    jobId: active.jobId,
    producedByBatchItemId: extraItemId,
    sourceIdentity: active.sourceIdentity,
    extractionIdentity: active.extractionIdentity,
    inputHash: active.inputHash,
    failureResolutionIdentity: active.failureResolutionIdentity,
    protocolVersion: active.protocolVersion,
    runnerProtocolHash: active.runnerProtocolHash,
    failureCode: active.failureCode,
    permanence: active.permanence,
    retrySeriesKey: active.retrySeriesKey,
    suppressionKey: active.suppressionKey,
    suppressionActive: true,
    seriesOrdinal: 2,
    failureReceiptHash: '2'.repeat(64),
    failureSnapshot: active.failureSnapshot as Prisma.InputJsonValue,
  };
  await assert.rejects(prisma.aimScoringFailureReceipt.create({ data: duplicateData }));
  await prisma.aimScoringFailureReceipt.update({
    where: { id: active.id },
    data: { suppressionActive: false, clearedAt: NOW, clearedReason: 'constraint-test', clearedActor: 'test' },
  });
  await assert.doesNotReject(prisma.aimScoringFailureReceipt.create({ data: duplicateData }));
});

test('protected lifecycle is preserved while an unprotected terminal kill applies', async () => {
  await seedAimBatch('valid-local-policy-kill-export.json');
  const resultJson = canonicalJson(fixture('valid-local-policy-kill-result.json'));
  let previewed = await previewScoringImport(prisma, resultJson, { approvalSecret: SECRET, now: NOW });
  await applyScoringImport(prisma, resultJson, previewed.approvalToken!, { approvalSecret: SECRET, now: NOW });
  assert.equal((await prisma.job.findFirstOrThrow()).status, 'dismissed');
  assert.equal((await prisma.jobScoreEvent.findFirstOrThrow()).lifecycleApplied, true);

  await emptyVerificationDatabase();
  await seedAimBatch('valid-local-policy-kill-export.json', { firstJobStatus: 'bookmarked' });
  previewed = await previewScoringImport(prisma, resultJson, { approvalSecret: SECRET, now: NOW });
  assert.equal(previewed.preview.projections[0].lifecycleAction, 'preserve_protected');
  await applyScoringImport(prisma, resultJson, previewed.approvalToken!, { approvalSecret: SECRET, now: NOW });
  assert.equal((await prisma.job.findFirstOrThrow()).status, 'bookmarked');
  assert.equal((await prisma.jobScoreEvent.findFirstOrThrow()).lifecycleApplied, false);
});
