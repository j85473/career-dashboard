/** Run only on an empty schema-only copy in a disposable PostgreSQL server.
 * Applies the additive retry migration and exercises real ledger constraints.
 * DATABASE_URL=postgresql://ats_fixture@127.0.0.1:55479/career_ats_simplify_20261104
 * node --import tsx tests/integration/atsIndependentHandoff.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { prisma } from '../../src/lib/prisma';
import { ATS_JOB_ENRICHMENT_KEY, ATS_JOB_ENRICHMENT_VERSION, type AtsJobEnrichmentDependencies } from '../../src/lib/atsJobEnrichment';
import { AtsPlatformDeferredError } from '../../src/lib/atsProviderRequest';
import { admitAtsV2Board, commitAtsV2ListingPage, resolveNextAtsV2ObservationChunk, terminalizeAtsV2NoNetworkItems,
  enrichNextAtsV2DetailItem, sealReadyAtsV2Segments, publishReadyAtsV2Segments, claimNextAtsV2Segment,
  completeAtsV2SegmentProcessing, finishAtsV2Claim } from '../../src/lib/atsAcquisitionLedger';

const databaseUrl = new URL(process.env.DATABASE_URL!);
assert.equal(databaseUrl.hostname, '127.0.0.1');
assert.equal(databaseUrl.port, '55479');
assert.equal(databaseUrl.username, 'ats_fixture');
assert.equal(databaseUrl.pathname, '/career_ats_simplify_20261104');
assert.ok(!process.env.DATABASE_RUNTIME_HOST, 'Do not redirect this fixture connection');
const sql = new Client({ connectionString: databaseUrl.href });
const counters = { seen: 1, inserted: 0, duplicates: 0, filtered: 1, processingErrors: 0, providerErrors: 0 };

async function main() {
  await sql.connect();
  assert.equal(await prisma.atsCompany.count(), 0, 'Use an empty schema-only copy');
  assert.equal(await prisma.job.count(), 0, 'Never run against user data');
  const savedJob = await prisma.job.create({ data: { title: 'Saved scored job', company: 'Saved Employer',
    source: 'fixture', postedAt: new Date('2026-11-04T18:00:00Z'), status: 'inbox', aimFitScore: 88, reqFitScore: 74, description: 'Preserved description' } });
  await prisma.atsCompany.create({ data: { slug: 'retained', platform: 'greenhouse', acquisitionEngine: 'v2', checkDay: 3 } });
  const oldBatch = await prisma.atsIngestionBatch.create({ data: { slug: 'retained', platform: 'greenhouse',
    writerMode: 'v2', ledgerVersion: 2, activeLedgerGeneration: 1, segmentSize: 25 } });
  const retry = new Date(Date.now() + 86_400_000);
  await sql.query(`INSERT INTO "AtsIngestionItem" (id,"batchId","ledgerGeneration","canonicalOrdinal","rawHash","rawJson","nextDetailAt","updatedAt")
    VALUES ('old-item',$1,1,0,'old-hash','{"saved":"source"}',$2,CURRENT_TIMESTAMP)`, [oldBatch.id, retry]);
  await sql.query(`INSERT INTO "AtsIngestionSegment" (id,"batchId","ledgerGeneration","segmentOrdinal","segmentSize","firstOrdinal","lastOrdinal",
    "itemCount","manifestHash","enrichmentVersion",status,"publishedAt","nextProcessAt","holdReason","updatedAt")
    VALUES ('old-segment',$1,1,0,25,0,0,1,'saved-manifest',1,'published',CURRENT_TIMESTAMP,$2,
    'oracle downloaded work awaits a verified employer',CURRENT_TIMESTAMP)`, [oldBatch.id, retry]);
  const snapshot = async () => (await sql.query(`SELECT 'item' AS kind,to_jsonb(i)-'retryCode'-'retryScope' AS value FROM "AtsIngestionItem" i WHERE id='old-item'
    UNION ALL SELECT 'segment',to_jsonb(s)-'retryCode'-'retryScope' FROM "AtsIngestionSegment" s WHERE id='old-segment' ORDER BY kind`)).rows;
  const retained = await snapshot();
  await sql.query(readFileSync(new URL('../../prisma/migrations/20261104190000_ats_retry_classification/migration.sql', import.meta.url), 'utf8'));
  assert.deepEqual(await snapshot(), retained, 'migration preserves evidence, holds and exact retry dates');
  assert.deepEqual(await prisma.job.findUnique({ where: { id: savedJob.id } }), savedJob);
  await prisma.atsAcquisitionRuntimeGate.create({ data: { id: 'global', minimumWriterVersion: 3,
    compatibilityWriterVersion: 3, activatedLedgerVersion: 2, v2AuthorityActivatedAt: new Date() } });

  for (const platform of ['oracle', 'ukg'] as const) {
    const slug = platform === 'oracle' ? 'fixture.fa.us2.oraclecloud.com::CX'
      : 'recruiting2.ultipro.com::FIXTURE::6ca32cd1-ca64-4d8f-82e7-f65b3aaa0e9b';
    const postingId = (i: number) => platform === 'oracle' ? String(1000 + i) : `14ce5fe4-5d06-404d-8583-${String(i).padStart(12, '0')}`;
    const postingUrl = (i: number) => platform === 'oracle'
      ? `https://fixture.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX/job/${postingId(i)}/`
      : `https://recruiting2.ultipro.com/FIXTURE/JobBoard/6ca32cd1-ca64-4d8f-82e7-f65b3aaa0e9b/OpportunityDetail?opportunityId=${postingId(i)}`;
    await prisma.atsCompany.create({ data: { slug, platform, acquisitionEngine: 'v2', firstCollectionState: 'established',
      status: 'active', checkDay: 3, nextCheckDate: new Date(0) } });
    const claim = await admitAtsV2Board({ slug, platform });
    assert.ok(claim);
    assert.equal(claim.segmentSize, 1);
    const jobs = Array.from({ length: 61 }, (_, i) => ({ id: postingId(i), publicAtsPostingId: postingId(i),
      title: 'Account Manager', company: '', url: postingUrl(i) }));
    jobs.push({ ...jobs[60] }); // Repeated source observations retain distinct durable ordinals; card deduplication remains downstream.
    await commitAtsV2ListingPage({ claim, requestedOffset: 0, requestedLimit: jobs.length,
      providerTotal: jobs.length, jobs, requestedAt: new Date(), respondedAt: new Date(), httpStatus: 200, listingComplete: false });
    await resolveNextAtsV2ObservationChunk({ claim, allowListingPrefix: true });
    await terminalizeAtsV2NoNetworkItems({ claim, allowListingPrefix: true });
    assert.equal(await prisma.atsIngestionItem.count({ where: { batchId: claim.batchId } }), jobs.length);
    let recovered = false;
    const dependencies: Partial<AtsJobEnrichmentDependencies> = {
      fetchPlatformResponse: async (_provider, _signal, request, options) => {
        const response = await request(); await options?.onResponse?.(response); return response;
      },
      reserveProviderBudgetForSource: async () => ({ allowed: true }),
      createDeferredError: (provider, retryAt) => new AtsPlatformDeferredError(provider, retryAt),
      recordProviderSuccess: async () => {}, recordProviderFailure: async () => assert.fail('One missing employer is not a provider failure'),
      verifiedBoardEmployer: async () => '',
      safeExternalFetch: async target => {
        const url = new URL(String(target));
        const id = platform === 'oracle' ? /Id="([0-9]+)"/.exec(url.searchParams.get('finder') || '')?.[1]
          : url.searchParams.get('opportunityId');
        if (platform === 'oracle' && !id) return new Response('{}');
        const company = id !== postingId(0) || recovered ? 'Verified Employer' : '';
        if (platform === 'oracle') return Response.json({ items: [{ Id: id, Title: 'Account Manager',
          LegalEmployer: company, ExternalDescriptionStr: '<p>Manage customer accounts.</p>' }] });
        return new Response(`<script>new US.Opportunity.CandidateOpportunityDetail(${JSON.stringify({
          Id: id, Title: 'Account Manager', Description: company ? '<p>Join Verified Employer, a growing team.</p>' : '<p>Manage customer accounts.</p>',
        })});</script>` + (company ? `<script>var params=${JSON.stringify({ opportunityTitle: 'Account Manager',
          jobBoardName: company + ' Opportunities' })}; var alias="OpportunityDetail.Index.PageTitle";</script>` : ''));
      },
    };
    const request = () => enrichNextAtsV2DetailItem({ claim, allowListingPrefix: true, requestTimeoutMs: 1000 }, dependencies);
    assert.equal(await request(), 'deferred');
    const pending = await prisma.atsIngestionItem.findFirstOrThrow({ where: { batchId: claim.batchId, canonicalOrdinal: 0 } });
    assert.equal(pending.retryCode, 'employer_unverified');
    assert.equal(pending.retryScope, 'posting');
    assert.ok(pending.nextDetailAt!.getTime() > Date.now());
    for (let i = 1; i < jobs.length; i++) assert.equal(await request(), 'terminal');
    assert.equal(await request(), 'none', 'future-held item is not retried early');
    const start = performance.now();
    assert.deepEqual(await sealReadyAtsV2Segments({ claim, allowListingPrefix: true }), { sealedSegments: 61, sealedItems: 61, complete: false });
    const sealed = await prisma.atsIngestionSegment.findMany({ where: { batchId: claim.batchId }, orderBy: { firstOrdinal: 'asc' } });
    assert.equal(sealed[0].firstOrdinal, 1);
    assert.equal((await publishReadyAtsV2Segments({ batchId: claim.batchId, highWatermark: 1000, lowWatermark: 500, maxSegments: 3 })).publishedItems, 61);
    console.log(`${platform}: sealed and published 61 independent postings in ${Math.round(performance.now() - start)}ms`);
    assert.equal((await publishReadyAtsV2Segments({ batchId: claim.batchId, highWatermark: 1000, lowWatermark: 500 })).publishedItems, 0);
    assert.equal((await prisma.atsIngestionBatch.findUniqueOrThrow({ where: { id: claim.batchId } })).publishedItemCount, 61);
    assert.deepEqual(await prisma.atsIngestionItem.findUnique({ where: { id: pending.id } }), pending);
    const competing = (await Promise.all([claimNextAtsV2Segment(), claimNextAtsV2Segment()])).filter(c => c !== null);
    assert.ok(competing.length > 0);
    assert.equal(new Set(competing.map(c => c.id)).size, competing.length);
    const expired = competing[0];
    await prisma.atsIngestionSegment.update({ where: { id: expired.id }, data: { leaseExpiresAt: new Date(0) } });
    const reclaimed = await claimNextAtsV2Segment();
    assert.ok(reclaimed); assert.equal(reclaimed.id, expired.id); assert.notEqual(reclaimed.leaseToken, expired.leaseToken);
    assert.equal(await completeAtsV2SegmentProcessing({ segmentId: expired.id, leaseToken: expired.leaseToken, counters }), false);
    const consume = async (handoff: NonNullable<typeof reclaimed>) => {
      assert.equal(handoff.jobs.length, 1);
      assert.equal((handoff.jobs[0][ATS_JOB_ENRICHMENT_KEY] as { version: number }).version, ATS_JOB_ENRICHMENT_VERSION);
      assert.equal(await completeAtsV2SegmentProcessing({ segmentId: handoff.id, leaseToken: handoff.leaseToken, counters }), true);
    };
    await consume(reclaimed);
    for (const handoff of competing.slice(1)) await consume(handoff);
    for (let handoff = await claimNextAtsV2Segment(); handoff; handoff = await claimNextAtsV2Segment()) await consume(handoff);
    assert.equal((await prisma.atsIngestionBatch.findUniqueOrThrow({ where: { id: claim.batchId } })).processedAt, null);
    assert.deepEqual(await prisma.atsIngestionItem.findUnique({ where: { id: pending.id } }), pending);

    // Advance only this fixture's retry clock, then exercise ordinary recovery.
    recovered = true;
    await prisma.atsIngestionItem.update({ where: { id: pending.id }, data: { nextDetailAt: new Date(0) } });
    assert.equal(await request(), 'terminal');
    const resolved = await prisma.atsIngestionItem.findUniqueOrThrow({ where: { id: pending.id } });
    assert.deepEqual(resolved.rawJson, pending.rawJson); assert.equal(resolved.rawHash, pending.rawHash);
    assert.equal(resolved.retryCode, null); assert.equal(resolved.retryScope, null);
    await commitAtsV2ListingPage({ claim, requestedOffset: jobs.length, requestedLimit: 1,
      providerTotal: jobs.length, jobs: [], requestedAt: new Date(), respondedAt: new Date(), httpStatus: 200, listingComplete: true });
    await resolveNextAtsV2ObservationChunk({ claim });
    assert.deepEqual(await sealReadyAtsV2Segments({ claim }), { sealedSegments: 1, sealedItems: 1, complete: true });
    assert.equal(await finishAtsV2Claim({ claim, yieldReason: 'segments_sealed' }), true);
    await publishReadyAtsV2Segments({ batchId: claim.batchId, highWatermark: 1000, lowWatermark: 500 });
    const last = await claimNextAtsV2Segment(); assert.ok(last); assert.deepEqual(last.canonicalOrdinals, [0]);
    await consume(last);
    assert.equal(await claimNextAtsV2Segment(), null);
    const final = await prisma.atsIngestionBatch.findUniqueOrThrow({ where: { id: claim.batchId } });
    assert.equal(final.status, 'processed'); assert.ok(final.processedAt);
    assert.equal(final.canonicalOccurrenceCount, 62); assert.equal(final.compactedOccurrenceCount, 0);
    const manifests = await prisma.atsIngestionSegment.findMany({ where: { batchId: claim.batchId } });
    for (const original of sealed) assert.equal(manifests.find(m => m.id === original.id)?.manifestHash, original.manifestHash);
  }
  assert.deepEqual(await snapshot(), retained);
  assert.deepEqual(await prisma.job.findUnique({ where: { id: savedJob.id } }), savedJob);
  console.log('PASS: migration preservation, mixed readiness, duplicate observations, bounded publication, concurrent claims, expired lease recovery, stale-writer rejection, late employer recovery, immutable manifests, completion and score preservation');
}

main().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); await sql.end(); });
