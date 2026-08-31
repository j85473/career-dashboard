import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  planLegacyAtsBatchConversion,
  type LegacyBatchSnapshot,
} from '../atsLegacyConversion';
import {
  ATS_JOB_ENRICHMENT_KEY,
  ATS_JOB_ENRICHMENT_VERSION,
  type AtsJobEnrichmentMarker,
} from '../atsJobEnrichment';
import {
  ATS_PREQUEUE_COMPACTION_METADATA_KEY,
  planAtsPrequeueCompaction,
} from '../atsPrequeueCompaction';

type JsonObject = Record<string, unknown>;

function batch(overrides: Partial<LegacyBatchSnapshot> = {}): LegacyBatchSnapshot {
  const now = new Date('2026-08-31T12:00:00.000Z');
  return {
    id: 'batch-1',
    slug: 'acme',
    platform: 'smartrecruiters',
    status: 'partial',
    payload: [{ id: 'a', name: 'Channel Manager' }],
    metadata: {},
    cursor: {
      offset: 1,
      total: 3,
      listingComplete: false,
      enrichmentOffset: 0,
      enrichmentVersion: ATS_JOB_ENRICHMENT_VERSION,
    },
    jobCount: 1,
    processingOffset: 0,
    insertedCount: 0,
    duplicateCount: 0,
    filteredCount: 0,
    processingErrorCount: 0,
    leaseToken: null,
    leaseExpiresAt: null,
    startedAt: new Date('2026-08-31T11:00:00.000Z'),
    respondedAt: now,
    synchronizedAt: null,
    updatedAt: now,
    writerMode: 'legacy',
    conversionGeneration: 0,
    acquisitionClaimToken: null,
    acquisitionClaimFence: BigInt(0),
    acquisitionLeaseExpiresAt: null,
    attempts: [{ id: 'attempt-1', outcome: 'partial', contactedAt: now, respondedAt: now }],
    ...overrides,
  };
}

function enrichmentMarker(completedAt: string): AtsJobEnrichmentMarker {
  return {
    version: ATS_JOB_ENRICHMENT_VERSION,
    status: 'enriched',
    platform: 'smartrecruiters',
    detailSource: 'ATS-smartrecruiters Details',
    attempted: true,
    completedAt,
    description: 'Complete description',
    company: null,
    location: null,
    compensation: null,
  };
}

test('listing-incomplete legacy batches import the durable prefix and resume listing', () => {
  const plan = planLegacyAtsBatchConversion(batch());
  assert.equal(plan.acquisitionPhase, 'listing');
  assert.equal(plan.rawObservationCount, 1);
  assert.equal(plan.canonicalOccurrenceCount, 0);
  assert.equal(plan.compactedOccurrenceCount, 0);
  assert.equal(plan.terminalItemCount, 0);
  assert.equal(plan.cursor.offset, 1);
  assert.equal(plan.observations[0].providerSourceId, 'a');
  assert.match(plan.planHash, /^[a-f0-9]{64}$/);
});

test('compacted and enriched legacy batches reconstruct exact v2 observations and items', () => {
  const completedAt = '2026-08-31T12:00:00.000Z';
  const rawJobs: JsonObject[] = [
    { id: 'a', name: 'Old Posting' },
    { id: 'b', name: 'Channel Manager' },
    { id: 'c', name: 'Partner Manager' },
  ];
  const compaction = planAtsPrequeueCompaction({
    platform: 'smartrecruiters',
    boardSlug: 'acme',
    jobs: rawJobs,
    observations: [{
      sourceId: 'a',
      jobId: 'job-a',
      jobStatus: 'archived',
      jobUpdatedAt: completedAt,
      boardSlug: 'acme',
    }],
  });
  const retained = structuredClone(compaction.jobs);
  retained[0] = {
    ...retained[0],
    [ATS_JOB_ENRICHMENT_KEY]: enrichmentMarker(completedAt),
  };
  const marker = { ...compaction.marker, completedAt };
  const plan = planLegacyAtsBatchConversion(batch({
    payload: retained as unknown as LegacyBatchSnapshot['payload'],
    metadata: { [ATS_PREQUEUE_COMPACTION_METADATA_KEY]: marker },
    cursor: {
      offset: 3,
      total: 3,
      listingComplete: true,
      enrichmentOffset: 1,
      enrichmentVersion: ATS_JOB_ENRICHMENT_VERSION,
    },
    jobCount: 2,
  }));

  assert.equal(plan.acquisitionPhase, 'enrichment');
  assert.equal(plan.rawObservationCount, 3);
  assert.equal(plan.canonicalOccurrenceCount, 2);
  assert.equal(plan.compactedOccurrenceCount, 1);
  assert.equal(plan.terminalItemCount, 1);
  assert.equal(plan.observations[0].rawJson, null);
  assert.equal(plan.observations[0].compactedReceipt?.sourceId, 'a');
  assert.equal(plan.items[0].observationOrdinal, 1);
  assert.equal(plan.items[0].canonicalOrdinal, 0);
  assert.equal(plan.items[0].marker?.status, 'enriched');
  assert.equal(ATS_JOB_ENRICHMENT_KEY in plan.items[0].rawJson, false);
  assert.equal(plan.items[1].observationOrdinal, 2);
  assert.equal(plan.items[1].marker, null);
});

test('conversion preserves marker-only completions beyond a blocked prefix cursor', () => {
  const marked = {
    id: 'b',
    name: 'Channel Manager',
    [ATS_JOB_ENRICHMENT_KEY]: enrichmentMarker('2026-08-31T12:00:00.000Z'),
  };
  const plan = planLegacyAtsBatchConversion(batch({
    payload: [{ id: 'a', name: 'Partner Manager' }, marked],
    jobCount: 2,
    cursor: {
      offset: 2,
      total: 2,
      listingComplete: true,
      enrichmentOffset: 0,
      enrichmentVersion: ATS_JOB_ENRICHMENT_VERSION,
    },
    metadata: {
      [ATS_PREQUEUE_COMPACTION_METADATA_KEY]: {
        ...planAtsPrequeueCompaction({
          platform: 'smartrecruiters',
          boardSlug: 'acme',
          jobs: [{ id: 'a', name: 'Partner Manager' }, marked],
          observations: [],
        }).marker,
        completedAt: '2026-08-31T12:00:00.000Z',
      },
    },
  }));
  assert.equal(plan.cursor.enrichmentOffset, 0);
  assert.equal(plan.terminalItemCount, 1);
  assert.equal(plan.items[0].marker, null);
  assert.equal(plan.items[1].marker?.status, 'enriched');
});

test('conversion rejects a cursor ahead of the exact marker prefix', () => {
  assert.throws(() => planLegacyAtsBatchConversion(batch({
    cursor: {
      offset: 1,
      total: 1,
      listingComplete: true,
      enrichmentOffset: 1,
      enrichmentVersion: ATS_JOB_ENRICHMENT_VERSION,
    },
  })), /exact current-marker prefix/);
});

test('conversion rejects any consumer or synchronization provenance', () => {
  assert.throws(() => planLegacyAtsBatchConversion(batch({ processingOffset: 1 })), /processing provenance/);
  assert.throws(() => planLegacyAtsBatchConversion(batch({ synchronizedAt: new Date() })), /processing provenance/);
});

test('conversion claim casts the lease timestamp to the installed database function signature', () => {
  const source = fs.readFileSync('src/lib/atsLegacyConversion.ts', 'utf8');
  assert.match(source, /\$\{leaseExpiresAt\}::timestamp\(3\)/);
});
