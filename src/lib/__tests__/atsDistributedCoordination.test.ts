import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  atsBoardSizeTier,
  atsEffectiveCoverageTier,
  orderAtsCoverageCandidates,
} from '../atsAcquisition';
import {
  ATS_DISTRIBUTED_WORKER_VERSION,
  ATS_PI_LOCAL_SLOT_RESERVE,
  validateAtsCoordinationGate,
} from '../atsAcquisitionCoordination';
import {
  atsCutoverSnapshotHash,
  evaluateAtsCutoverSnapshot,
  type AtsCutoverSnapshot,
} from '../atsCutoverReadiness';

const source = (relativePath: string) => readFileSync(path.join(process.cwd(), relativePath), 'utf8');

test('size-aware coverage uses the approved thresholds without starving overdue large boards', () => {
  assert.deepEqual([0, 20, 21, 30, 31, 50, 51, 100, 101].map(atsBoardSizeTier), [0, 0, 1, 1, 2, 2, 3, 3, 4]);
  const now = new Date('2026-08-31T12:00:00.000Z');
  const large = {
    slug: 'large',
    platform: 'workday',
    jobsFound: 5_000,
    nextCheckDate: new Date('2026-08-27T11:59:59.000Z'),
    lastAttemptedAt: new Date('2026-08-27T00:00:00.000Z'),
  };
  const small = {
    slug: 'small',
    platform: 'greenhouse',
    jobsFound: 10,
    nextCheckDate: new Date('2026-08-31T11:00:00.000Z'),
    lastAttemptedAt: null,
  };
  assert.equal(atsEffectiveCoverageTier(large, now), 0);
  assert.deepEqual(orderAtsCoverageCandidates([small, large], now).map((row) => row.slug), ['large', 'small']);
});

test('distributed authority is opt-in and remote work requires its own durable gate', () => {
  const dormant = {
    admissionState: 'open',
    drainRequestedAt: null,
    cutoverReadyAt: null,
    distributedAuthorityActivatedAt: null,
    distributedWriterVersion: 0,
    remoteWorkersEnabled: false,
    globalSlotLimit: 4,
    localSlotReserve: 4,
  };
  assert.equal(ATS_PI_LOCAL_SLOT_RESERVE, 4);
  assert.equal(validateAtsCoordinationGate(dormant).valid, true);
  assert.equal(validateAtsCoordinationGate({ ...dormant, localSlotReserve: 3 }).valid, false);
  assert.equal(validateAtsCoordinationGate(dormant, { requireDistributed: true }).valid, false);
  assert.deepEqual(validateAtsCoordinationGate({
    ...dormant,
    cutoverReadyAt: new Date(),
    distributedAuthorityActivatedAt: new Date(),
    distributedWriterVersion: ATS_DISTRIBUTED_WORKER_VERSION,
    remoteWorkersEnabled: true,
    globalSlotLimit: 5,
  }, { requireDistributed: true, requireRemote: true }), { valid: true });
});

function emptySnapshot(): AtsCutoverSnapshot {
  return {
    admissionState: 'draining',
    publicationPaused: false,
    dailyTarget: 6_200,
    confirmedContacts: 6_200,
    legacy: { activeBatches: 0, listingJobs: 0, enrichmentJobs: 0, persistenceJobs: 0, runningAttempts: 0 },
    v2: { activeBatches: 0, stagingItems: 0, stagingBytes: 0, openSegments: 0, segmentBacklogJobs: 0 },
    leases: { unfinishedWorkReceipts: 0, activeBatchClaims: 0, activeItemClaims: 0, activeSegmentClaims: 0 },
    exceptions: { unresolvedFailures: 0, safetyBlockedSweeps: 0 },
    reconciliationErrors: 0,
    lastLegacyAttemptId: 'legacy-final',
    lastV2WorkReceiptId: 'work-final',
    lastV2SegmentId: 'segment-final',
  };
}

test('cutover requires global zero and hashes the reviewed snapshot deterministically', () => {
  const snapshot = emptySnapshot();
  assert.deepEqual(evaluateAtsCutoverSnapshot(snapshot), []);
  assert.equal(atsCutoverSnapshotHash(snapshot), atsCutoverSnapshotHash({ ...snapshot }));
  const blocked = { ...snapshot, v2: { ...snapshot.v2, stagingItems: 1 } };
  assert.deepEqual(evaluateAtsCutoverSnapshot(blocked), ['v2 staging items: 1']);
});

test('Release A is additive, continuation-only on the Mac, and admission-fenced in both writers', () => {
  const migration = source('prisma/migrations/20260831010000_ats_distributed_drain_control/migration.sql');
  const remote = source('scripts/workers/ats-remote-continuation.ts');
  const legacy = source('src/lib/atsAcquisition.ts');
  const ledger = source('src/lib/atsAcquisitionLedger.ts');
  const provider = source('src/lib/jobIngestion.ts');
  const coordination = source('src/lib/atsAcquisitionCoordination.ts');
  const cutoverControl = source('scripts/control_ats_cutover.ts');
  const installer = source('scripts/install-ats-remote-launchagent.mjs');
  const deployment = source('scripts/deploy.sh');
  assert.doesNotMatch(migration, /^\s*(?:DROP|DELETE|TRUNCATE)\b/im);
  assert.match(migration, /AtsAcquisitionWorkerSlot/);
  assert.match(migration, /guard_ats_cutover_receipt_immutable/);
  assert.match(migration, /"localSlotReserve" = 4/);
  assert.match(migration, /"releaseId" IS NOT NULL/);
  assert.match(coordination, /healthy Pi capacity leases/);
  assert.match(coordination, /exact 40-character deployed Git release ID/);
  assert.match(cutoverControl, /const ACTIVATE = process\.argv\.includes\('--activate'\)/);
  assert.match(cutoverControl, /healthy Pi slots and at least one Mac slot/);
  assert.match(installer, /<key>SuccessfulExit<\/key>[\s\S]+?<false\/>/);
  assert.match(installer, /origin\/main/);
  assert.match(deployment, /ATS_ACQUISITION_ROLLOUT_PROFILE.*ledger-v2-distributed/);
  assert.match(deployment, /ATS_WORKER_RELEASE_ID=%s/);
  assert.match(remote, /lanePolicy: 'continuation-only'/);
  assert.doesNotMatch(remote, /claimNextAtsV2Coverage|admitAtsV2Board/);
  assert.match(legacy, /SELECT gate\."admissionState"[\s\S]+?FOR SHARE/);
  assert.match(ledger, /gate\.admissionState !== 'open'/);
  assert.match(provider, /withProviderRequestLease\(`ATS-\$\{platform\}`/);
});
