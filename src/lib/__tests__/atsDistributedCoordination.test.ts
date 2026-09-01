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
  atsZeroJobFailureSelectionHash,
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
    admissionResumeAt: null,
    drainRequestedAt: null,
    cutoverReadyAt: null,
    distributedAuthorityActivatedAt: null,
    distributedWriterVersion: 0,
    remoteWorkersEnabled: false,
    globalSlotLimit: 4,
    localSlotReserve: 4,
  };
  // Release B: the Pi reserves no ATS acquisition lanes.
  assert.equal(ATS_PI_LOCAL_SLOT_RESERVE, 0);
  assert.equal(validateAtsCoordinationGate(dormant).valid, true);
  // A zero reserve with the Mac holding every lane is the Release B target.
  assert.equal(validateAtsCoordinationGate({
    ...dormant, localSlotReserve: 0, globalSlotLimit: 8,
  }).valid, true);
  // An intermediate reserve stays legal so the cutover can step down.
  assert.equal(validateAtsCoordinationGate({ ...dormant, localSlotReserve: 3 }).valid, true);
  // The bounds that still hold: no negative reserve, no reserve above the
  // global limit, no more than eight global lanes, never zero global lanes.
  assert.equal(validateAtsCoordinationGate({ ...dormant, localSlotReserve: -1 }).valid, false);
  assert.equal(validateAtsCoordinationGate({
    ...dormant, localSlotReserve: 5, globalSlotLimit: 4,
  }).valid, false);
  assert.equal(validateAtsCoordinationGate({ ...dormant, globalSlotLimit: 9 }).valid, false);
  assert.equal(validateAtsCoordinationGate({
    ...dormant, localSlotReserve: 0, globalSlotLimit: 0,
  }).valid, false);
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
    exceptions: {
      unresolvedFailures: 0,
      resolvedZeroJobFailures: 0,
      resolutionManifestHash: null,
      safetyBlockedSweeps: 0,
    },
    reconciliationErrors: 0,
    lastLegacyAttemptId: 'legacy-final',
    lastV2WorkReceiptId: 'work-final',
    lastV2SegmentId: 'segment-final',
  };
}

test('only the coverage line is waivable; the drain and lease interlock is not', () => {
  const snapshot = emptySnapshot();
  const short = { ...snapshot, confirmedContacts: 2681, dailyTarget: 6200 };
  assert.deepEqual(evaluateAtsCutoverSnapshot(short), ['daily coverage is 2681/6200']);
  // An operator may accept the shortfall.
  assert.deepEqual(evaluateAtsCutoverSnapshot(short, { acceptCoverageShortfall: true }), []);
  // The waiver must not suppress anything else: in-flight work, live leases,
  // and unpaused admissions are what stop two hosts writing the same board.
  const dirty = {
    ...short,
    admissionState: 'open',
    v2: { ...short.v2, activeBatches: 3, stagingItems: 17 },
    leases: { ...short.leases, activeBatchClaims: 1 },
  };
  const waived = evaluateAtsCutoverSnapshot(dirty, { acceptCoverageShortfall: true });
  assert.deepEqual(waived, [
    'new board admissions are not paused',
    'v2 active batches: 3',
    'v2 staging items: 17',
    'active batch claims: 1',
  ]);
  // The receipt keeps the observed shortfall, so a waiver stays auditable.
  const control = source('scripts/control_ats_cutover.ts');
  assert.match(control, /--accept-coverage-shortfall/);
  assert.match(control, /Coverage shortfall changed; reviewed/);
  const readiness = source('src/lib/atsCutoverReadiness.ts');
  assert.match(readiness, /acceptCoverageShortfallAt/);
});

test('cutover requires global zero and hashes the reviewed snapshot deterministically', () => {
  const snapshot = emptySnapshot();
  assert.deepEqual(evaluateAtsCutoverSnapshot(snapshot), []);
  assert.equal(atsCutoverSnapshotHash(snapshot), atsCutoverSnapshotHash({ ...snapshot }));
  const blocked = { ...snapshot, v2: { ...snapshot.v2, stagingItems: 1 } };
  assert.deepEqual(evaluateAtsCutoverSnapshot(blocked), ['v2 staging items: 1']);
});

test('zero-job failure selection is deterministic and changes with source eligibility', () => {
  const updatedAt = new Date('2026-08-31T17:00:00.000Z');
  const rows = [
    { id: 'batch-b', updatedAt, eligible: true },
    { id: 'batch-a', updatedAt, eligible: false },
  ];
  assert.equal(
    atsZeroJobFailureSelectionHash(rows),
    atsZeroJobFailureSelectionHash([...rows].reverse()),
  );
  assert.notEqual(
    atsZeroJobFailureSelectionHash(rows),
    atsZeroJobFailureSelectionHash(rows.map((row) => (
      row.id === 'batch-a' ? { ...row, eligible: true } : row
    ))),
  );
});

test('zero-job failure resolutions are append-only and cannot hide source work', () => {
  const migration = source(
    'prisma/migrations/20260831190000_ats_zero_job_failure_resolutions/migration.sql',
  );
  const readiness = source('src/lib/atsCutoverReadiness.ts');
  const control = source('scripts/control_ats_cutover.ts');
  assert.doesNotMatch(migration, /^\s*(?:DROP|DELETE|TRUNCATE)\b/im);
  assert.match(migration, /guard_ats_zero_job_failure_resolution_immutable/);
  assert.match(migration, /validate_ats_zero_job_failure_resolution_insert/);
  assert.match(migration, /source_batch\.payload IS DISTINCT FROM '\[\]'::jsonb/);
  assert.match(migration, /source_batch\."jobCount" <> 0/);
  assert.match(migration, /source_batch\."leaseToken" IS NOT NULL/);
  assert.match(migration, /source_batch\."acquisitionClaimToken" IS NOT NULL/);
  assert.match(migration, /AtsIngestionPage/);
  assert.match(migration, /AtsIngestionItem/);
  assert.match(migration, /AtsAcquisitionWorkReceipt/);
  assert.match(readiness, /AtsZeroJobFailureResolution/);
  assert.match(readiness, /resolutionManifestHash/);
  assert.match(readiness, /exceptionCount: readiness\.snapshot\.exceptions\.resolvedZeroJobFailures/);
  assert.match(control, /--resolve-zero-job-failures/);
  assert.match(control, /--expected-selection-hash/);
});

test('Release B moves every ATS lane to the Mac and stays admission-fenced in both writers', () => {
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
  // Release A pinned the reserve at four; Release B replaces that one CHECK
  // with a bound so the Pi can reach zero. The replacement is the authority.
  const releaseB = source('prisma/migrations/20260901120000_ats_release_b_pi_zero_reserve/migration.sql');
  assert.match(migration, /"localSlotReserve" = 4/);
  assert.match(releaseB, /DROP CONSTRAINT "AtsAcquisitionRuntimeGate_slot_limit_check"/);
  assert.match(releaseB, /"localSlotReserve" >= 0/);
  assert.match(releaseB, /"globalSlotLimit" BETWEEN "localSlotReserve" AND 8/);
  // Release B must not remove a column or rewrite recorded acquisition work.
  assert.doesNotMatch(releaseB, /^\s*(?:DROP\s+(?:TABLE|COLUMN)|DELETE|TRUNCATE|UPDATE)\b/im);
  assert.match(migration, /"releaseId" IS NOT NULL/);
  assert.match(coordination, /healthy Pi capacity leases/);
  assert.match(coordination, /exact 40-character deployed Git release ID/);
  assert.match(cutoverControl, /const ACTIVATE = process\.argv\.includes\('--activate'\)/);
  assert.match(cutoverControl, /healthy Pi slots and at least one Mac slot/);
  assert.match(installer, /<key>SuccessfulExit<\/key>[\s\S]+?<false\/>/);
  assert.match(installer, /origin\/main/);
  assert.match(deployment, /ATS_ACQUISITION_ROLLOUT_PROFILE.*ledger-v2-distributed/);
  assert.match(deployment, /ATS_WORKER_RELEASE_ID=%s/);
  // The Mac now plans both lanes with the same balanced planner the Pi used,
  // and continuation-only survives only as an explicit cutover override.
  assert.match(remote, /atsV2RuntimeLanePlan/);
  assert.match(remote, /ATS_REMOTE_WORKER_CONTINUATION_ONLY/);
  assert.match(remote, /CONTINUATION_ONLY \? 'continuation-only' : 'balanced'/);
  // A zero Pi reserve leaves no Pi lease to coordinate with, so the remote
  // guard must be conditional rather than unconditional.
  assert.match(coordination, /remote && gate\.localSlotReserve > 0/);
  assert.match(legacy, /SELECT gate\."admissionState"[\s\S]+?FOR SHARE/);
  assert.match(ledger, /gate\.admissionState !== 'open'/);
  assert.match(provider, /withProviderRequestLease\(`ATS-\$\{platform\}`/);
});
