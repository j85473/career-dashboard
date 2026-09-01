import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeAtsOperatorBacklogRow } from '../atsBacklogTelemetry';

test('operator backlog combines legacy and v2 without collapsing lifecycle stages', () => {
  const observedAt = new Date('2026-08-31T19:30:00.000Z');
  assert.deepEqual(normalizeAtsOperatorBacklogRow({
    observedAt,
    admissionState: 'draining',
    publicationPaused: true,
    legacyPersistenceJobs: BigInt(7),
    v2PersistenceJobs: '881',
    legacyEnrichmentJobs: BigInt(37_995),
    v2EnrichmentJobs: 921,
    legacyListingJobs: BigInt(32_960),
    v2ListingJobs: '1000',
    compactionJobs: BigInt(412),
    publicationJobs: BigInt(653),
    terminalUnsealedJobs: BigInt(153),
    sealedUnpublishedJobs: BigInt(500),
    publishedUnpersistedJobs: BigInt(881),
  }), {
    observedAt,
    admissionState: 'draining',
    publicationPaused: true,
    legacyPersistenceJobs: 7,
    v2PersistenceJobs: 881,
    persistenceJobs: 888,
    enrichmentJobs: 38_916,
    listingJobs: 33_960,
    compactionJobs: 412,
    publicationJobs: 653,
    terminalUnsealedJobs: 153,
    sealedUnpublishedJobs: 500,
    publishedUnpersistedJobs: 881,
  });
});

test('operator backlog rejects an unknown admission state instead of mislabeling it', () => {
  assert.throws(() => normalizeAtsOperatorBacklogRow({
    observedAt: new Date('2026-08-31T19:30:00.000Z'),
    admissionState: 'paused-by-guess',
    publicationPaused: false,
    legacyPersistenceJobs: 0,
    v2PersistenceJobs: 0,
    legacyEnrichmentJobs: 0,
    v2EnrichmentJobs: 0,
    legacyListingJobs: 0,
    v2ListingJobs: 0,
    compactionJobs: 0,
    publicationJobs: 0,
    terminalUnsealedJobs: 0,
    sealedUnpublishedJobs: 0,
    publishedUnpersistedJobs: 0,
  }), /Unknown ATS admission state/);
});
