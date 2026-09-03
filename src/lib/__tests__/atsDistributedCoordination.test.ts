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
import { formatAtsDistributedTelemetry } from '../atsDistributedTelemetry';

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
    admissionState: 'open', contactsToday: 2880, dailyTarget: 6200,
    activeBatches: 271, boardsContactedLastHour: 2880,
    itemsEnrichedLastHour: 16905,
    lastContactAt: new Date('2026-09-01T16:20:00.000Z'),
    todayBoardsCompleted: 2_100, todayBoardsTotal: 5_858,
    backlogBoardsCompleted: 312, backlogBoardsTotal: 1_400,
    cooldownBoardsCompleted: 91, cooldownBoardsTotal: 8_691,
    observedAt: new Date('2026-09-01T16:20:30.000Z'),
  };
  const now = new Date('2026-09-01T16:20:30.000Z');
  const line = formatAtsDistributedTelemetry(base, now);
  // The status line names the lanes, not a machine.
  assert.match(line, /Workers 8\/8 lanes/);
  assert.doesNotMatch(line, /\bMac\b|\bPi\b/);
  assert.match(line, /Today complete 2,100\/5,858/);
  assert.match(line, /Backlog complete 312\/1,400/);
  assert.match(line, /Cooldown complete 91\/8,691/);
  // A dead worker must read as absent, not as its last cheerful message.
  assert.match(
    formatAtsDistributedTelemetry({ ...base, remoteSlots: 0 }, now),
    /Worker stopped/,
  );
  // A live lease with no recent board is a stall, and must say so.
  assert.match(
    formatAtsDistributedTelemetry(
      { ...base, lastContactAt: new Date('2026-09-01T15:00:00.000Z') },
      now,
    ),
    /Last board 81m ago/,
  );
  // Admissions paused has to be visible, or a held gate looks like a stall.
  assert.match(
    formatAtsDistributedTelemetry({ ...base, admissionState: 'draining' }, now),
    /Admissions paused/,
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
  assert.match(telemetry, /sweep\."selectionTier" = 'cooldown'/);
  // The immutable admission bucket survives a successful recovery returning
  // the mutable board status to active.
  assert.match(ledger, /selectionTier,[\s\S]*?state: 'admitted'/);
  assert.match(schema, /selectionTier\s+String\s+@default\("unclassified"\)/);
});
