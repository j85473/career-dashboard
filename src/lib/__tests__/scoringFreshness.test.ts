import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  latestUsablePromptVersions,
  nativeReplaySelectionHash,
  projectedNativeReplayBatchCount,
  recentDismissedRecoveryIds,
  staleActiveScoreIds,
} from '../scoringFreshness';

test('native replay receipts are stable across timestamps and bind cohort authority', () => {
  const components = {
    currentPromptVersion: 'standard-job-evaluator-v6.10.0',
    contextJobIds: ['context-1'],
    directlyEligibleStandardJobIds: ['job-1'],
    staleInboxRefreshJobIds: ['job-2'],
    dismissedRecoveryJobIds: [],
    projectedAllWaveStandardCandidateIds: ['job-1', 'job-2'],
  };
  const firstReceipt = {
    snapshotGeneratedAt: '2026-08-09T12:00:00.000Z',
    selectionHash: nativeReplaySelectionHash(components),
  };
  const laterReceipt = {
    snapshotGeneratedAt: '2026-08-09T13:00:00.000Z',
    selectionHash: nativeReplaySelectionHash(components),
  };

  assert.notEqual(firstReceipt.snapshotGeneratedAt, laterReceipt.snapshotGeneratedAt);
  assert.equal(firstReceipt.selectionHash, laterReceipt.selectionHash);
  assert.notEqual(
    firstReceipt.selectionHash,
    nativeReplaySelectionHash({ ...components, currentPromptVersion: 'standard-job-evaluator-v6.10.1' }),
  );
  assert.notEqual(
    firstReceipt.selectionHash,
    nativeReplaySelectionHash({
      ...components,
      projectedAllWaveStandardCandidateIds: ['job-1', 'job-2', 'job-3'],
    }),
  );
});

test('one request drains a 101-job cohort through two internal standard batches', () => {
  assert.equal(projectedNativeReplayBatchCount(101, 100), 2);
  const directImport = readFileSync('scripts/direct_import.ts', 'utf8');
  const next = readFileSync('scripts/native_scoring_next.ts', 'utf8');
  const runner = readFileSync('.agents/agents/native-scoring-runner-v6/agent.md', 'utf8');

  assert.match(directImport, /phase: 'standard_preparing'/);
  assert.match(next, /scripts\/prepare_native_scoring_phase\.ts/);
  assert.match(runner, /If `action` is `continue`, return to step 1/);
});

test('a stale newest score never falls back to an older apparently current event', () => {
  const versions = latestUsablePromptVersions([
    { jobId: 'stale', promptVersion: 'standard-job-evaluator-v6.7.1', staleAt: new Date('2026-08-09T12:00:00.000Z') },
    { jobId: 'stale', promptVersion: 'standard-job-evaluator-v6.10.0', staleAt: null },
    { jobId: 'usable', promptVersion: 'standard-job-evaluator-v6.10.0', staleAt: null },
  ]);

  assert.equal(versions.has('stale'), false);
  assert.equal(versions.get('usable'), 'standard-job-evaluator-v6.10.0');
});

test('only unreviewed active jobs with stale or missing scoring provenance are requeued', () => {
  const candidates = [
    { id: 'stale', passReason: null, tailoringStaged: false },
    { id: 'missing', passReason: null, tailoringStaged: false },
    { id: 'current', passReason: null, tailoringStaged: false },
    { id: 'promoted', passReason: 'Promoted by user: Manually promoted by user', tailoringStaged: false },
    { id: 'tailoring', passReason: null, tailoringStaged: true },
  ];
  const versions = new Map([
    ['stale', 'standard-job-evaluator-v6.1'],
    ['current', 'standard-job-evaluator-v6.3'],
    ['promoted', 'standard-job-evaluator-v6.1'],
    ['tailoring', 'standard-job-evaluator-v6.1'],
  ]);
  assert.deepEqual(
    staleActiveScoreIds(candidates, versions, 'standard-job-evaluator-v6.3'),
    ['stale', 'missing'],
  );
});

test('recent dismissal recovery is current-filtered, stale-only, priority-ranked, and bounded', () => {
  const cutoff = new Date('2026-07-12T00:00:00.000Z');
  const candidates = [
    { id: 'target-low', title: 'Customer Success Manager', aimFitScore: 45, reqFitScore: 65, localFilterPasses: true },
    { id: 'near-miss', title: 'Growth Director', aimFitScore: 70, reqFitScore: 80, localFilterPasses: true },
    { id: 'local-reject', title: 'Territory Manager - Texas', aimFitScore: 90, reqFitScore: 90, localFilterPasses: false },
    { id: 'current', title: 'Channel Manager', aimFitScore: 70, reqFitScore: 80, localFilterPasses: true },
    { id: 'old', title: 'Account Manager', aimFitScore: 80, reqFitScore: 80, localFilterPasses: true },
    { id: 'weak', title: 'Operations Coordinator', aimFitScore: 40, reqFitScore: 50, localFilterPasses: true },
    { id: 'stale-event', title: 'Channel Manager', aimFitScore: 90, reqFitScore: 90, localFilterPasses: true },
  ];
  const events = new Map([
    ['target-low', { promptVersion: 'standard-job-evaluator-v6.1', passed: false, createdAt: new Date('2026-08-01T00:00:00.000Z') }],
    ['near-miss', { promptVersion: 'standard-job-evaluator-v6.1', passed: false, createdAt: new Date('2026-08-01T00:00:00.000Z') }],
    ['local-reject', { promptVersion: 'standard-job-evaluator-v6.1', passed: false, createdAt: new Date('2026-08-01T00:00:00.000Z') }],
    ['current', { promptVersion: 'standard-job-evaluator-v6.3', passed: false, createdAt: new Date('2026-08-01T00:00:00.000Z') }],
    ['old', { promptVersion: 'standard-job-evaluator-v6.1', passed: false, createdAt: new Date('2026-06-01T00:00:00.000Z') }],
    ['weak', { promptVersion: 'standard-job-evaluator-v6.1', passed: false, createdAt: new Date('2026-08-01T00:00:00.000Z') }],
    ['stale-event', { promptVersion: 'standard-job-evaluator-v6.1', passed: false, createdAt: new Date('2026-08-01T00:00:00.000Z'), staleAt: new Date('2026-08-09T00:00:00.000Z') }],
  ]);

  assert.deepEqual(
    recentDismissedRecoveryIds(candidates, events, 'standard-job-evaluator-v6.3', cutoff, 2),
    ['target-low', 'near-miss'],
  );
  assert.deepEqual(
    recentDismissedRecoveryIds(candidates, events, 'standard-job-evaluator-v6.3', cutoff, 0),
    [],
  );
});

test('native dismissal recovery excludes immutable human decisions at selection and guarded update', () => {
  const preparation = readFileSync('scripts/prepare_native_scoring_phase.ts', 'utf8');
  const selection = preparation.slice(
    preparation.indexOf('const dismissedJobs'),
    preparation.indexOf('const recoveryIds'),
  );
  const guardedUpdate = preparation.slice(
    preparation.indexOf('const recoveredUpdate'),
    preparation.indexOf('return { staleInbox'),
  );
  const immutableDecisionGuard = /pipelineEvents: \{ none: \{ eventType: \{ in: \['user_promote', 'user_reject'\] \} \} \}/;

  assert.match(selection, immutableDecisionGuard);
  assert.match(guardedUpdate, immutableDecisionGuard);
  assert.match(guardedUpdate, /jdBatchId: null/);
  assert.match(guardedUpdate, /batchJobId: null/);
  assert.match(guardedUpdate, /recoveredUpdate\.count !== recoveryIds\.length/);
});

test('audit, requeue, and lease surfaces share the complete native replay protection guards', () => {
  const preparation = readFileSync('scripts/prepare_native_scoring_phase.ts', 'utf8');
  const audit = readFileSync('scripts/audit_scoring_calibration.ts', 'utf8');
  const segment = (source: string, start: string, end: string): string => {
    const startIndex = source.indexOf(start);
    const endIndex = source.indexOf(end, startIndex + start.length);
    assert.notEqual(startIndex, -1, `Missing segment start: ${start}`);
    assert.notEqual(endIndex, -1, `Missing segment end: ${end}`);
    return source.slice(startIndex, endIndex);
  };
  const assertProtectionGuards = (source: string, label: string): void => {
    assert.match(source, /scoringStatus: 'scored'/, `${label}: scoring state`);
    assert.match(source, /jdBatchId: null/, `${label}: JD lease`);
    assert.match(source, /batchJobId: null/, `${label}: local lease`);
    assert.match(source, /afBatchId: null/, `${label}: native lease`);
    assert.match(source, /tailoringStaged: false/, `${label}: tailoring lifecycle`);
    assert.match(source, /fitCategory:[^\n]*promoted/, `${label}: promotion category`);
    assert.match(source, /passReason:[\s\S]*promoted/i, `${label}: promotion reason`);
    assert.match(source, /pipelineEvents:[\s\S]*user_promote[\s\S]*user_reject/, `${label}: human events`);
  };

  const preparationSegments = [
    ['stale Inbox selection', 'const candidates = await tx.job.findMany', 'const events ='],
    ['stale Inbox guarded update', 'const staleUpdate =', 'if (staleUpdate.count'],
    ['dismissed recovery selection', 'const dismissedJobs =', 'const recoveryIds ='],
    ['dismissed recovery guarded update', 'const recoveredUpdate =', 'if (recoveredUpdate.count'],
    ['standard availability predicate', 'const availableStandardJob:', 'const candidateOrder ='],
    ['standard guarded lease', 'if (candidates.length > 0)', 'return fetchScoringJobs'],
  ] as const;
  for (const [label, start, end] of preparationSegments) {
    assertProtectionGuards(segment(preparation, start, end), label);
  }

  assertProtectionGuards(
    segment(
      audit,
      "prisma.job.findMany({\n      where: {\n        status: 'inbox'",
      "prisma.contextProfile.findUnique",
    ),
    'audit stale Inbox selection',
  );
  assertProtectionGuards(
    segment(audit, 'const dismissedCandidates =', 'const recoveryInput ='),
    'audit dismissed recovery selection',
  );
  assertProtectionGuards(
    segment(
      audit,
      "prisma.job.findMany({\n      where: {\n        scoringStatus: 'scored'",
      "prisma.job.findMany({\n      where: {\n        scoringStatus: 'queued'",
    ),
    'audit standard availability',
  );
});

test('scoring audit exposes exact local and native replay cohorts without mutating them', () => {
  const audit = readFileSync('scripts/audit_scoring_calibration.ts', 'utf8');

  assert.match(audit, /localReplayPreflight:[\s\S]*jobIds: queuedLocalJobIds/);
  assert.match(audit, /immutableHumanDecisionJobIds: queuedLocalHumanDecisionJobIds/);
  assert.match(audit, /nativeReplayPreflight:[\s\S]*point_in_time_all_wave_backlog_not_request_binding/);
  assert.match(audit, /contextBatchSize: NATIVE_SCORING_CHUNK_SIZE/);
  assert.match(audit, /standardBatchSize: NATIVE_SCORING_STANDARD_BATCH_SIZE/);
  assert.match(audit, /projectedStandardBatchCount/);
  assert.match(audit, /directlyEligibleStandardJobIds/);
  assert.match(audit, /staleInboxRefreshJobIds: staleIds/);
  assert.match(audit, /dismissedRecoveryJobIds: recoveryIds/);
  assert.match(audit, /projectedAllWaveStandardCandidateIds/);
  assert.match(audit, /nativeReplaySelectionHash/);
  assert.doesNotMatch(
    audit,
    /prisma(?:\.[A-Za-z]\w*)?\.(?:create|update|updateMany|delete|deleteMany|upsert)\s*\(/,
  );
});
