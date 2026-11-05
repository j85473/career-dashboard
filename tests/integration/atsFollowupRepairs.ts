/** Disposable schema-only PostgreSQL fixture; never runs against user data.
 * DATABASE_URL=postgresql://ats_followups@127.0.0.1:55481/career_ats_followups_20261104
 * node --import tsx tests/integration/atsFollowupRepairs.ts
 */
import assert from 'node:assert/strict';
import { prisma } from '../../src/lib/prisma';
import type { Prisma } from '../../src/lib/prismaClient';
import { employerProofFixture } from '../fixtures/atsEmployerProof';
import { applyRetainedEmployerPlan, retainedEmployerPlanHash, type RetainedEmployerPlan } from '../../src/lib/retainedAtsEmployerRepair';
import { verifiedAtsPostingEvidence } from '../../src/lib/atsEmployerRegistry';
import { atsV2PersistenceCapacityBacklog, publishReadyAtsV2Segments, atsLedgerHash, claimNextAtsV2Segment } from '../../src/lib/atsAcquisitionLedger';
import { ingestJobs } from '../../src/lib/jobIngestion';
import { ATS_JOB_ENRICHMENT_KEY } from '../../src/lib/atsJobEnrichment';
import { publicCrawlCapacity } from '../../src/lib/publicCrawlCapacity';
import { readAtsFlowSnapshot } from '../../src/lib/atsFlowHealth';

const database = new URL(process.env.DATABASE_URL!);
assert.equal(database.hostname, '127.0.0.1');
assert.equal(database.port, '55481');
assert.equal(database.username, 'ats_followups');
assert.equal(database.pathname, '/career_ats_followups_20261104');
assert.ok(!process.env.DATABASE_RUNTIME_HOST, 'Do not redirect the fixture connection');
const now = new Date();
const holdReason = 'oracle downloaded work awaits a verified employer';
const selection = (segment: { id: string; processingOffset: number; itemCount: number; manifestHash: string }) => ({
  id: segment.id, processingOffset: segment.processingOffset, itemCount: segment.itemCount, manifestHash: segment.manifestHash,
});
async function finish(where: Prisma.AtsIngestionSegmentWhereInput) {
  await prisma.atsIngestionSegment.updateMany({ where: { AND: [where, { status: 'published' }] }, data: { status: 'processing' } });
  await prisma.atsIngestionSegment.updateMany({ where: { AND: [where, { status: 'processing' }] }, data: {
    status: 'processed', processingOffset: 25, filteredCount: 25, leaseToken: null, leaseExpiresAt: null, processedAt: now,
  } });
}

async function main() {
  assert.equal(await prisma.job.count(), 0, 'Never run against user data');
  assert.equal(await prisma.atsIngestionBatch.count(), 0, 'Use an empty schema-only copy');
  const job = await prisma.job.create({ data: { title: 'Saved scored job', company: 'Saved Employer',
    source: 'fixture', postedAt: now, status: 'applied', aimFitScore: 88, reqFitScore: 74, description: 'Preserved description' } });
  await prisma.atsAcquisitionRuntimeGate.create({ data: { id: 'global', minimumWriterVersion: 3,
    compatibilityWriterVersion: 3, activatedLedgerVersion: 2, v2AuthorityActivatedAt: now } });
  await prisma.pipelineState.create({ data: { id: 'global', schedulePaused: false } });
  const proof = employerProofFixture();
  await prisma.atsCompany.create({ data: { platform: proof.platform, slug: proof.slug, acquisitionEngine: 'v2', checkDay: 3 } });
  const batch = await prisma.atsIngestionBatch.create({ data: { platform: proof.platform, slug: proof.slug,
    writerMode: 'v2', ledgerVersion: 2, activeLedgerGeneration: 1, segmentSize: 25 } });
  const createSegment = (ordinal: number, status: string, extra: Record<string, unknown> = {}) => prisma.atsIngestionSegment.create({ data: {
    batchId: batch.id, ledgerGeneration: 1, segmentOrdinal: ordinal, segmentSize: 25,
    firstOrdinal: ordinal * 25, lastOrdinal: ordinal * 25 + 24, itemCount: 25, enrichmentVersion: 1,
    manifestHash: `immutable-manifest-${ordinal}`, status, publishedAt: status === 'sealed' ? null : now,
    nextProcessAt: status === 'sealed' ? null : now, ...extra,
  } });
  const held = [];
  for (let i = 0; i < 11; i++) held.push(await createSegment(i, i === 9 ? 'processing' : 'published', {
    holdReason, retryCode: 'employer_unverified', retryScope: 'posting',
    ...(i === 8 ? { nextProcessAt: new Date(now.getTime() + 3600_000) } : {}),
    ...(i === 9 ? { leaseToken: 'live-fixture-lease', leaseExpiresAt: new Date(now.getTime() + 60000) } : {}),
  }));
  proof.segments = held.map(selection);
  await prisma.atsIngestionSegment.update({ where: { id: held[10].id }, data: { processingOffset: 1, filteredCount: 1 } });
  const raw = await prisma.atsIngestionItem.create({ data: { batchId: batch.id, ledgerGeneration: 1,
    canonicalOrdinal: 0, rawHash: 'saved-raw-hash', rawJson: { title: 'Original saved title' } } });
  for (let i = 11; i < 83; i++) await createSegment(i, 'published'); // 1,800 ordinary jobs
  const plan: RetainedEmployerPlan = { version: 1, createdAt: now.toISOString(), complete: true, boards: [proof] };
  const originalHeld = await prisma.atsIngestionSegment.findMany({ where: { id: { in: held.map(s => s.id) } }, orderBy: { id: 'asc' } });
  let result = await applyRetainedEmployerPlan(prisma, plan, retainedEmployerPlanHash(plan));
  assert.equal(result.registeredBoards, 1); assert.equal(result.releasedItems, 0, 'Full writer capacity cannot release work');
  assert.deepEqual(await prisma.atsIngestionSegment.findMany({ where: { id: { in: held.map(s => s.id) } }, orderBy: { id: 'asc' } }), originalHeld);
  await finish({ batchId: batch.id, segmentOrdinal: { gte: 11 } });
  result = await applyRetainedEmployerPlan(prisma, plan, retainedEmployerPlanHash(plan));
  assert.equal(result.releasedSegments, 8); assert.equal(result.releasedItems, 200);
  assert.equal((await applyRetainedEmployerPlan(prisma, plan, retainedEmployerPlanHash(plan))).releasedItems, 0, 'Replaying the same repair is idempotent');
  for (const before of originalHeld) {
    const after = await prisma.atsIngestionSegment.findUniqueOrThrow({ where: { id: before.id } });
    const index = held.findIndex(s => s.id === before.id);
    if (index >= 8) assert.deepEqual(after, before, 'Future, leased and advanced work stays byte-for-byte intact');
    else assert.deepEqual({ ...after, holdReason: before.holdReason, retryCode: before.retryCode,
      retryScope: before.retryScope, updatedAt: before.updatedAt }, before, 'Only due hold classification can change');
  }
  assert.deepEqual(await prisma.atsIngestionItem.findUnique({ where: { id: raw.id } }), raw);
  await prisma.companyNameRule.update({ where: { matchType_matchKey: { matchType: 'ats_board_employer', matchKey: `${proof.platform}:${proof.slug}` } },
    data: { standardName: 'Prior Explicit Employer', origin: 'operator' } });
  assert.equal((await applyRetainedEmployerPlan(prisma, plan, retainedEmployerPlanHash(plan))).conflictingBoards, 1);

  const posting = employerProofFixture(true);
  const postingSegment = await createSegment(83, 'published', { holdReason, retryCode: 'employer_unverified' });
  const wrongSegment = await createSegment(84, 'published', { holdReason, retryCode: 'employer_unverified' });
  await prisma.atsIngestionItem.create({ data: { batchId: batch.id, ledgerGeneration: 1, canonicalOrdinal: 83 * 25,
    rawHash: 'posting-raw', rawJson: posting.job as never } });
  await prisma.atsIngestionItem.create({ data: { batchId: batch.id, ledgerGeneration: 1, canonicalOrdinal: 84 * 25,
    rawHash: 'other-posting-raw', rawJson: { ...posting.job, title: 'Different Title' } } });
  posting.segments = [selection(postingSegment), selection(wrongSegment)];
  const postingPlan = { ...plan, boards: [posting] };
  assert.equal((await applyRetainedEmployerPlan(prisma, postingPlan, retainedEmployerPlanHash(postingPlan))).releasedSegments, 1);
  assert.equal((await prisma.atsIngestionSegment.findUniqueOrThrow({ where: { id: wrongSegment.id } })).holdReason, holdReason);
  assert.deepEqual(await verifiedAtsPostingEvidence(posting.platform, posting.slug, posting.job!), posting.evidence);
  assert.equal(await verifiedAtsPostingEvidence(posting.platform, posting.slug, { ...posting.job, title: 'Other Title' }), null);

  // Real publisher gate: both its initial and resumed refill leave public room.
  await finish({ batchId: batch.id });
  for (let i = 85; i < 165; i++) await createSegment(i, 'sealed');
  for (let i = 0; i < 10; i++) await publishReadyAtsV2Segments({ highWatermark: 2000, lowWatermark: 1000 });
  assert.equal(await atsV2PersistenceCapacityBacklog(), 1900);
  assert.equal((await publicCrawlCapacity(prisma)).healthy, true);
  assert.equal((await publishReadyAtsV2Segments({ highWatermark: 2000, lowWatermark: 1000 })).publishedItems, 0);
  const consumed = await prisma.atsIngestionSegment.findMany({ where: { status: 'published' }, take: 40 });
  await finish({ id: { in: consumed.map(s => s.id) } });
  assert.equal((await publishReadyAtsV2Segments({ highWatermark: 2000, lowWatermark: 1000 })).publishedItems, 100);
  assert.equal((await publicCrawlCapacity(prisma)).healthy, true);

  for (const minutes of [20, 10, 1]) await prisma.ingestionSourceRun.create({ data: { source: 'ATS-adp', status: 'deferred',
    error: 'Waiting for operator pause or ingestion capacity', createdAt: new Date(now.getTime() - minutes * 60000) } });
  await prisma.ingestionSourceRun.create({ data: { source: 'ATS-oracle', status: 'success', seenCount: 100, insertedCount: 2,
    createdAt: new Date(now.getTime() - 60000) } });
  await prisma.ingestionSourceRun.create({ data: { source: 'ATS-oracle Details', status: 'success', seenCount: 999, createdAt: now } });
  await prisma.atsIngestionItem.create({ data: { batchId: batch.id, ledgerGeneration: 1, canonicalOrdinal: 5000,
    rawHash: 'new-pending-employer', retryCode: 'employer_unverified', retryScope: 'posting', rawJson: { title: 'Saved pending posting' } } });
  // The query must remain correct in the production session timezone.
  const flow = await prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'America/Chicago'");
    return readAtsFlowSnapshot(tx);
  });
  assert.equal(flow.checkedLastHour, 100); assert.equal(flow.insertedLastHour, 2);
  assert.equal(flow.employerHeld, 1); assert.equal(flow.unsealedEmployerHeld, 1, 'New posting holds remain visible before handoff');
  assert.equal(flow.readyToProcess, 1000); assert.equal(flow.sources.find(s => s.source === 'ATS-adp')?.stalled, true);
  assert.equal(flow.sources.find(s => s.source === 'ATS-adp')?.lastRunAt, new Date(now.getTime() - 60000).toISOString());
  await prisma.pipelineState.update({ where: { id: 'global' }, data: { schedulePaused: true } });
  assert.equal((await readAtsFlowSnapshot(prisma, now)).sources.some(s => s.stalled), false);
  await prisma.pipelineState.update({ where: { id: 'global' }, data: { schedulePaused: false } });
  await prisma.ingestionSourceRun.create({ data: { source: 'ATS-adp', status: 'success', seenCount: 1, duplicateCount: 1, createdAt: now } });
  assert.equal((await readAtsFlowSnapshot(prisma, now)).sources.some(s => s.stalled), false, 'A duplicate check is actual progress');
  assert.deepEqual(await prisma.job.findUnique({ where: { id: job.id } }), job, 'All existing card fields and scores remain unchanged');
  // Exercise the actual importer, including its persisted completion receipt.
  // A verified first posting must advance even when its next neighbor is held.
  await finish({ batchId: batch.id });
  await prisma.providerCircuit.create({ data: { provider: 'ATS-oracle', state: 'open',
    openUntil: new Date(Date.now() + 3600_000) } }); // Keep fixture recovery offline.
  const mixedBatch = batch;
  const mixedItems = [];
  for (let ordinal = 0; ordinal < 3; ordinal++) {
    const input = { ...posting.job, id: String(1000 + ordinal), publicAtsPostingId: String(1000 + ordinal),
      url: String(posting.job!.url).replace('/1000/', `/${1000 + ordinal}/`),
      location: 'Minneapolis, MN', company: ordinal === 2 ? 'Verified Employer' : '' };
    const overlay = { [ATS_JOB_ENRICHMENT_KEY]: { version: 1, status: 'unavailable', platform: 'oracle',
      detailSource: 'ATS-oracle Details', attempted: true, completedAt: now.toISOString(), description: null,
      company: null, location: null, compensation: null } };
    mixedItems.push(await prisma.atsIngestionItem.create({ data: { batchId: mixedBatch.id, ledgerGeneration: 1,
      canonicalOrdinal: 6000 + ordinal, rawHash: atsLedgerHash(input), rawJson: input, enrichmentOverlay: overlay,
      enrichmentStatus: 'terminal', enrichmentVersion: 1, terminalAt: now } }));
  }
  const manifest = atsLedgerHash(mixedItems.map(item => ({ ordinal: item.canonicalOrdinal, rawHash: item.rawHash,
    overlayHash: atsLedgerHash(item.enrichmentOverlay), enrichmentVersion: item.enrichmentVersion, terminalAt: now.toISOString() })));
  const mixedSegment = await prisma.atsIngestionSegment.create({ data: { batchId: mixedBatch.id, ledgerGeneration: 1,
    segmentOrdinal: 240, segmentSize: 25, firstOrdinal: 6000, lastOrdinal: 6002, itemCount: 3, enrichmentVersion: 1,
    manifestHash: manifest, status: 'published', publishedAt: now, nextProcessAt: now } });
  const claim = await claimNextAtsV2Segment(); assert.ok(claim); assert.equal(claim.id, mixedSegment.id);
  await ingestJobs(undefined, undefined, undefined, undefined, 'pending_af', false, {
    useStandard: false, usePaidApis: false, useCareerforce: false, atsPlatform: 'oracle', prefetchedAtsBatch: claim,
  });
  const mixedAfter = await prisma.atsIngestionSegment.findUniqueOrThrow({ where: { id: mixedSegment.id } });
  assert.equal(mixedAfter.processingOffset, 1, 'The actual importer saves the verified prefix before a held neighbor');
  assert.equal(mixedAfter.retryCode, 'employer_unverified'); assert.equal(mixedAfter.status, 'published');
  assert.equal(mixedAfter.manifestHash, manifest); assert.ok(mixedAfter.nextProcessAt! > now);
  assert.deepEqual(await prisma.atsIngestionItem.findMany({ where: { id: { in: mixedItems.map(item => item.id) } }, orderBy: { canonicalOrdinal: 'asc' } }), mixedItems);
  assert.deepEqual(await prisma.job.findUnique({ where: { id: job.id } }), job);
  console.log('PASS: real publisher headroom and refill; bounded, idempotent employer repair; capacity, lease, retry-date, offset and identity guards; immutable source/manifests and score preservation; timezone-safe flow and pause-aware starvation detection.');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
