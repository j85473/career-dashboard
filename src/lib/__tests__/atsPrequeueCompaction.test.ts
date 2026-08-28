import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  ATS_PREQUEUE_COMPACTION_METADATA_KEY,
  atsBatchHasProcessingProvenance,
  atsListingSourceId,
  canCompactExactAtsObservation,
  planAtsPrequeueCompaction,
  readAtsPrequeueCompactionMarker,
  validateAtsPrequeueCompactionCheckpoint,
} from '../atsPrequeueCompaction';

const JOB_UPDATED_AT = '2026-08-28T14:00:00.000Z';

function observation(
  sourceId: string,
  jobStatus: string | null,
  jobId = `job-${sourceId}`,
  boardSlug: string | null = 'example',
) {
  return { sourceId, jobId, jobStatus, jobUpdatedAt: JOB_UPDATED_AT, boardSlug };
}

test('ATS listing identity exactly matches every downstream platform override', () => {
  assert.equal(atsListingSourceId('greenhouse', { id: 42 }), '42');
  assert.equal(
    atsListingSourceId('workday', { id: 'ignored', externalPath: '/job/Minneapolis/R-100' }),
    '/job/Minneapolis/R-100',
  );
  assert.equal(atsListingSourceId('workday', { id: 'fallback' }), 'fallback');
  assert.equal(atsListingSourceId('workable', { id: 'id', shortcode: 'short', code: 'code' }), 'id');
  assert.equal(atsListingSourceId('workable', { shortcode: 'short', code: 'code' }), 'short');
  assert.equal(atsListingSourceId('workable', { code: 'code' }), 'code');
  assert.equal(atsListingSourceId('rippling', { id: 'ignored', uuid: 'uuid-1' }), 'uuid-1');
  assert.equal(atsListingSourceId('rippling', { id: 'fallback' }), 'fallback');
  assert.equal(atsListingSourceId('lever', {}), null);
  assert.equal(atsListingSourceId('lever', { id: '   ' }), null);
});

test('only exact observations outside mutable rediscovery states are compactable', () => {
  assert.equal(canCompactExactAtsObservation('archived'), true);
  assert.equal(canCompactExactAtsObservation('dismissed'), true);
  assert.equal(canCompactExactAtsObservation('applied'), true);
  assert.equal(canCompactExactAtsObservation('cooldown'), true);
  assert.equal(canCompactExactAtsObservation('passed'), true);
  assert.equal(canCompactExactAtsObservation('pending_af'), false);
  assert.equal(canCompactExactAtsObservation('inbox'), false);
  assert.equal(canCompactExactAtsObservation(null), false);
});

test('prequeue compaction removes only safe exact duplicates and preserves payload order', () => {
  const missingIdentity = { title: 'Missing provider identity' };
  const jobs = [
    { id: 'archived', title: 'Archived duplicate' },
    { id: 'new', title: 'New posting' },
    { id: 'active', title: 'Active rediscovery candidate' },
    missingIdentity,
    { id: 'dismissed', title: 'Dismissed duplicate' },
  ];
  const plan = planAtsPrequeueCompaction({
    platform: 'greenhouse',
    boardSlug: 'example',
    jobs,
    observations: [
      observation('archived', 'archived'),
      observation('active', 'pending_af'),
      observation('dismissed', 'dismissed'),
    ],
  });

  assert.deepEqual(plan.jobs, [jobs[1], jobs[2], missingIdentity]);
  assert.deepEqual({
    fetchedJobCount: plan.marker.fetchedJobCount,
    queuedJobCount: plan.marker.queuedJobCount,
    prequeueExactDuplicateCount: plan.marker.prequeueExactDuplicateCount,
    retainedExactObservationCount: plan.marker.retainedExactObservationCount,
    missingIdentityCount: plan.marker.missingIdentityCount,
  }, {
    fetchedJobCount: 5,
    queuedJobCount: 3,
    prequeueExactDuplicateCount: 2,
    retainedExactObservationCount: 1,
    missingIdentityCount: 1,
  });
  assert.equal(
    plan.marker.fetchedJobCount,
    plan.marker.queuedJobCount + plan.marker.prequeueExactDuplicateCount,
  );
  assert.deepEqual(plan.marker.compactedItems, [
    {
      sourceId: 'archived',
      jobId: 'job-archived',
      jobStatus: 'archived',
      jobUpdatedAt: JOB_UPDATED_AT,
      originalItemIndex: 0,
    },
    {
      sourceId: 'dismissed',
      jobId: 'job-dismissed',
      jobStatus: 'dismissed',
      jobUpdatedAt: JOB_UPDATED_AT,
      originalItemIndex: 4,
    },
  ]);
});

test('compacted identity receipt is retry-stable and binds the raw listing order', () => {
  const observations = [
    observation('one', 'archived'),
    observation('two', 'dismissed'),
  ];
  const forward = planAtsPrequeueCompaction({
    platform: 'lever',
    boardSlug: 'example',
    jobs: [{ id: 'one' }, { id: 'two' }],
    observations,
  });
  const reverse = planAtsPrequeueCompaction({
    platform: 'lever',
    boardSlug: 'example',
    jobs: [{ id: 'two' }, { id: 'one' }],
    observations,
  });
  const retry = planAtsPrequeueCompaction({
    platform: 'lever',
    boardSlug: 'example',
    jobs: [{ id: 'one' }, { id: 'two' }],
    observations,
  });
  assert.equal(forward.marker.compactedIdentityHash, retry.marker.compactedIdentityHash);
  assert.notEqual(forward.marker.compactedIdentityHash, reverse.marker.compactedIdentityHash);
  assert.match(forward.marker.compactedIdentityHash, /^[a-f0-9]{64}$/);
});

test('durable compaction metadata fails closed when payload accounting is malformed', () => {
  const completedAt = '2026-08-28T15:00:00.000Z';
  const planned = planAtsPrequeueCompaction({
    platform: 'greenhouse',
    boardSlug: 'example',
    jobs: [{ id: 'old' }, { id: 'new' }],
    observations: [observation('old', 'archived')],
  });
  const marker = { ...planned.marker, completedAt };
  assert.deepEqual(readAtsPrequeueCompactionMarker({
    [ATS_PREQUEUE_COMPACTION_METADATA_KEY]: marker,
  }), marker);
  assert.throws(() => readAtsPrequeueCompactionMarker({
    [ATS_PREQUEUE_COMPACTION_METADATA_KEY]: { ...marker, queuedJobCount: 2 },
  }), /metadata is invalid/);
  assert.doesNotThrow(() => validateAtsPrequeueCompactionCheckpoint({
    marker,
    platform: 'greenhouse',
    boardSlug: 'example',
    listingComplete: true,
    payloadJobCount: 1,
    storedJobCount: 1,
  }));
  assert.throws(() => validateAtsPrequeueCompactionCheckpoint({
    marker,
    platform: 'greenhouse',
    boardSlug: 'another-board',
    listingComplete: true,
    payloadJobCount: 1,
    storedJobCount: 1,
  }), /does not match its durable payload/);
  assert.throws(() => validateAtsPrequeueCompactionCheckpoint({
    marker,
    platform: 'greenhouse',
    boardSlug: 'example',
    listingComplete: true,
    payloadJobCount: 1,
    storedJobCount: 2,
  }), /does not match its durable payload/);
  assert.throws(() => readAtsPrequeueCompactionMarker({
    [ATS_PREQUEUE_COMPACTION_METADATA_KEY]: {
      ...marker,
      retainedExactObservationCount: marker.queuedJobCount + 1,
    },
  }), /metadata is invalid/);
});

test('board-scoped provider IDs fail open across tenants and on ambiguous provenance', () => {
  const jobs = [{ id: '42', title: 'Board B posting' }];
  const crossBoard = planAtsPrequeueCompaction({
    platform: 'bamboohr',
    boardSlug: 'board-b',
    jobs,
    observations: [observation('42', 'archived', 'job-board-a', 'board-a')],
  });
  const ambiguous = planAtsPrequeueCompaction({
    platform: 'bamboohr',
    boardSlug: 'board-b',
    jobs,
    observations: [observation('42', 'archived', 'job-legacy', null)],
  });
  const sameBoard = planAtsPrequeueCompaction({
    platform: 'bamboohr',
    boardSlug: 'board-b',
    jobs,
    observations: [observation('42', 'archived', 'job-board-b', 'board-b')],
  });

  assert.deepEqual(crossBoard.jobs, jobs);
  assert.equal(crossBoard.marker.prequeueExactDuplicateCount, 0);
  assert.deepEqual(ambiguous.jobs, jobs);
  assert.equal(ambiguous.marker.prequeueExactDuplicateCount, 0);
  assert.deepEqual(sameBoard.jobs, []);
  assert.equal(sameBoard.marker.prequeueExactDuplicateCount, 1);
});

test('any prior consumer provenance forces compaction to retain the durable payload', () => {
  const zeroProgress = {
    synchronizedAt: null,
    processingOffset: 0,
    insertedCount: 0,
    duplicateCount: 0,
    filteredCount: 0,
    processingErrorCount: 0,
  };
  assert.equal(atsBatchHasProcessingProvenance(zeroProgress), false);
  assert.equal(atsBatchHasProcessingProvenance({
    ...zeroProgress,
    synchronizedAt: '2026-08-28T15:00:00.000Z',
  }), true, 'synchronization alone proves a consumer may have committed an item receipt');
  assert.equal(atsBatchHasProcessingProvenance({
    ...zeroProgress,
    processingOffset: 1,
  }), true);
});

test('acquisition and downstream share identity while legacy processing progress bypasses removal', () => {
  const acquisition = readFileSync(path.join(process.cwd(), 'src/lib/atsAcquisition.ts'), 'utf8');
  const ingestion = readFileSync(path.join(process.cwd(), 'src/lib/jobIngestion.ts'), 'utf8');
  assert.match(acquisition, /jobs\.map\(\(job\) => atsListingSourceId\(platform, job\)\)/);
  assert.match(ingestion, /const sourceId = atsListingSourceId\(board\.platform, job\);/);
  assert.match(
    acquisition,
    /const batchHasProcessingProgress = atsBatchHasProcessingProvenance\(batch\);[\s\S]*?const observations = batchHasProcessingProgress\s*\? \[\]\s*:\s*await observedAtsSourceStates\(transaction/,
  );
  assert.match(acquisition, /jobCount: fetchedJobCount,[\s\S]*?status: processingCompleteAtSynchronization/);
  assert.match(
    acquisition,
    /status: processingCompleteAtSynchronization \? 'processed' : 'queued'/,
  );
  assert.match(acquisition, /jobsFound: fetchedJobCount/);
  assert.match(acquisition, /jobCount: jobs\.length/);
  assert.match(acquisition, /WHERE observation\."source" = \$\{`ATS-\$\{platform\}`\}[\s\S]*?Prisma\.join\(chunk\)[\s\S]*?FOR SHARE OF job/);
  assert.match(acquisition, /ingestionMode: 'ats_prequeue_compaction'/);
  assert.match(acquisition, /boardSlug: board\.slug/);
  assert.match(acquisition, /boardSlugFromJobUrl\(row\.observationUrl, platform\)/);
  assert.match(acquisition, /ATS_PREQUEUE_COMPACTION_TRANSACTION_OPTIONS/);
  assert.match(acquisition, /withProviderTransactionRetry\(\(\) =>[\s\S]*?durableAtsCompactionCheckpoint/);
  assert.match(acquisition, /where: \{ id: `ats-prequeue:\$\{batch\.id\}` \}[\s\S]*?update: \{\}/);
  const compactionBlock = acquisition.slice(
    acquisition.indexOf('if (!compactionMarker) {'),
    acquisition.indexOf('const enrichmentLimit = planAtsEnrichmentChunk('),
  );
  assert.doesNotMatch(compactionBlock, /(?:transaction|prisma)\.job\.(?:create|update|delete)/);
});
