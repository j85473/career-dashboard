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
import { deriveAtsAcquisitionState, formatAtsDistributedTelemetry } from '../atsDistributedTelemetry';

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
  const deployment = source('scripts/deployment/activate-m70.sh');
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
  // A paused pipeline must not end the worker process, and a clean exit must
  // not leave acquisition down: both together are what kept the Mac dead
  // through a Pi deployment until the next login.
  assert.match(installer, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.doesNotMatch(installer, /<key>SuccessfulExit<\/key>/);
  assert.match(remote, /ATS remote worker is paused/);
  assert.doesNotMatch(remote, /controller\.abort\(new Error\('The authoritative Pi pipeline requested stop/);
  assert.match(installer, /origin\/main/);
  // Every release stamps the worker release identity, and keeps the previous
  // one so a rollback restores the identity that matches the restored code.
  assert.match(deployment, /ATS_WORKER_RELEASE_ID=%s/);
  assert.match(deployment, /acquisition-release\.env\.previous/);
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

test('the operator ticker reports remote acquisition from durable rows', () => {
  const base = {
    remoteSlots: 8, piSlots: 0, globalSlotLimit: 8, localSlotReserve: 0,
    admissionState: 'open', boardsContactedLastHour: 2880,
    lastContactAt: new Date('2026-09-01T16:20:00.000Z'),
    rotationDay: 2,
    cohortTotal: 5_858, cohortSwept: 2_100, cohortReadyNow: 940,
    nextUnlockAt: new Date('2026-09-01T17:00:00.000Z'), unlockWithinHour: 83,
    dueBatches: 0,
    weekActiveBoards: 51_826, weekCoveredBoards: 48_127,
    observedAt: new Date('2026-09-01T16:20:30.000Z'),
  };
  const now = new Date('2026-09-01T16:20:30.000Z');
  const line = formatAtsDistributedTelemetry(base, now);
  // The status line names the lanes, not a machine.
  assert.match(line, /Lanes 8\/8/);
  assert.doesNotMatch(line, /\bMac\b|\bPi\b/);
  // Progress is one rotation reading, not three tier-sliced ones.
  assert.match(line, /Rotation Tuesday/);
  assert.match(line, /Boards 2100\/5858/);
  assert.match(line, /Week 48127\/51826/);
  // The rate the reader already computed has to survive into the line, or the
  // panel can only show position and never velocity.
  assert.match(line, /Rate 2880/);
  assert.match(line, /State working/);

  // Boards remain, but none can be claimed yet. That is waiting, not a stall,
  // and it is the reading that used to be indistinguishable from a hang.
  assert.equal(deriveAtsAcquisitionState({ ...base, cohortReadyNow: 0 }, now), 'waiting');
  // Lanes held, work available, and nothing landing for half an hour is a hang.
  assert.equal(
    deriveAtsAcquisitionState(
      { ...base, lastContactAt: new Date('2026-09-01T15:00:00.000Z') },
      now,
    ),
    'stuck',
  );
  // The same silence with nothing claimable and nothing overdue is only
  // waiting: the remaining boards are held behind their own timers.
  assert.equal(
    deriveAtsAcquisitionState(
      { ...base, cohortReadyNow: 0, lastContactAt: new Date('2026-09-01T15:00:00.000Z') },
      now,
    ),
    'waiting',
  );
  // Lanes wedged on their own open batches drive the claimable count to zero,
  // so the lapsed hold is what has to name it. Without this the worst hang
  // there is reports as patience.
  assert.equal(
    deriveAtsAcquisitionState(
      {
        ...base,
        cohortReadyNow: 0,
        dueBatches: 8,
        lastContactAt: new Date('2026-09-01T15:00:00.000Z'),
      },
      now,
    ),
    'stuck',
  );
  // A finished rotation must not read as a stall on its way to midnight.
  assert.equal(deriveAtsAcquisitionState({ ...base, cohortSwept: 5_858, cohortReadyNow: 0 }, now), 'done');
  // A dead worker must read as absent, not as its last cheerful message.
  assert.equal(deriveAtsAcquisitionState({ ...base, remoteSlots: 0 }, now), 'stopped');
  // Admissions paused has to outrank the symptom it causes.
  assert.equal(
    deriveAtsAcquisitionState({ ...base, admissionState: 'draining', cohortReadyNow: 0 }, now),
    'blocked',
  );

  // The poller must not fight the Pi's own child for the lane.
  const route = source('src/app/api/pipeline/run/route.ts');
  const telemetry = source('src/lib/atsDistributedTelemetry.ts');
  const ledger = source('src/lib/atsAcquisitionLedger.ts');
  const schema = source('prisma/schema.prisma');
  assert.match(route, /distributed\.localSlotReserve === 0/);
  assert.match(route, /ATS Remote Telemetry/);
  // Completion is the Pi-owned processed receipt, not the Mac's first contact.
  assert.match(telemetry, /sweep\."processedAt"/);
  // Progress must not be sliced by the tier that claimed the board. The tier is
  // stamped from the board's status at claim time and never revised, so a
  // parked board that answered and was restored to active still carries
  // 'cooldown' — counting by it subtracted 932 recovered boards from the
  // rotation they belong to and showed the day 12 points short.
  assert.doesNotMatch(telemetry, /selectionTier/);
  // A board still in recovery cannot sit in the denominator forever holding
  // the day short of complete, but a recovery board that was actually swept
  // today counts on both sides like any other.
  assert.match(telemetry, /board\.status = 'active'\s*\n\s*OR EXISTS \(/);
  // Comparisons against naive timestamp columns must not depend on the
  // session's time zone, or a Chicago session reads a five-hour-old row as due.
  assert.match(telemetry, /AT TIME ZONE 'UTC'\) AS now_utc/);
  assert.doesNotMatch(telemetry, /"nextCheckDate" <= CURRENT_TIMESTAMP/);
  // The receipt keeps its immutable admission bucket even after a successful
  // recovery returns the mutable board status to active. That record is still
  // worth having; it is simply not a measure of rotation progress.
  assert.match(ledger, /selectionTier,[\s\S]*?state: 'admitted'/);
  assert.match(schema, /selectionTier\s+String\s+@default\("unclassified"\)/);
});
