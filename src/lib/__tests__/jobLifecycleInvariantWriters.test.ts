import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();
const source = (relativePath: string) => readFileSync(path.join(root, relativePath), 'utf8');

test('the lifecycle assertion reuses current Aim identity and the exact operational partition', () => {
  const helper = source('src/lib/jobLifecycleInvariant.ts');
  assert.match(helper, /const versions = options\.versions \|\| currentScoringInputVersions\(\)/);
  assert.match(helper, /currentAimSuppressedJobIds\(client, jobIds, versions\)/);
  assert.equal((helper.match(/currentAimSuppressedJobIds\(client, jobIds, versions\)/g) || []).length, 1);
  assert.match(helper, /latestJobScoreEvents\(jobIds, client, versions\)/);
  assert.match(helper, /operationalPartitionScopeWhere\(currentSuppressionIds\)/);
  assert.match(helper, /operationalQueueWhere\(category, currentSuppressionIds\)/);
  assert.match(helper, /inspectOperationalPartition\(\[\.\.\.scopedIds\], categoryIds\)/);
  assert.match(helper, /latestUserLifecycleIntent\(job\.pipelineEvents\)/);
  assert.match(helper, /latest_user_lifecycle_intent_does_not_match_state/);
  assert.match(helper, /CLOSED_POSTING_REASON/);
});

test('highest-risk machine lifecycle writers assert before their transaction commits', () => {
  const scoringImport = source('src/lib/scoringImport.ts');
  const invalidation = source('src/lib/scoreInvalidation.ts');
  const reconciliation = source('src/lib/scoringInputReconciliation.ts');
  const localScoring = source('src/lib/jobScoring.ts');

  assert.ok(scoringImport.indexOf('await assertJobLifecycleInvariants(tx, batch.items.map')
    < scoringImport.indexOf("data: { status: 'completed'"));
  assert.ok(invalidation.indexOf('await assertJobLifecycleInvariants(client, [input.jobId])')
    < invalidation.indexOf('invalidatedEventIds: nonstaleScoreEvents'));
  const reconciliationAssertionIndex = reconciliation.indexOf('await assertJobLifecycleInvariants(tx, appliedIds)');
  const reconciliationTransactionEndIndex = reconciliation.indexOf('isolationLevel: Prisma.TransactionIsolationLevel.Serializable');
  assert.ok(reconciliationAssertionIndex >= 0, 'scoring input reconciliation must assert the IDs actually applied');
  assert.ok(reconciliationTransactionEndIndex >= 0, 'scoring input reconciliation must remain serializable');
  assert.ok(reconciliationAssertionIndex < reconciliationTransactionEndIndex);
  assert.match(localScoring, /async function updateLocalJobWithInvariant/);
  assert.match(localScoring, /if \(error instanceof JobLifecycleInvariantError\) \{/);
  assert.match(localScoring, /Local scoring lifecycle invariant:/);
  assert.match(localScoring, /const invariantVersions = currentScoringInputVersions\(\)/);
  assert.ok((localScoring.match(/await assertJobLifecycleInvariants\(tx, \[currentJob\.id\], \{ versions: invariantVersions \}\)/g) || []).length >= 2);
});

test('atomic user routes record authority before asserting all affected rows', () => {
  for (const relativePath of [
    'src/app/api/jobs/[id]/route.ts',
    'src/app/api/jobs/[id]/pass/route.ts',
    'src/app/api/jobs/[id]/promote/route.ts',
    'src/app/api/tailoring/import/route.ts',
  ]) {
    const route = source(relativePath);
    assert.match(route, /prisma\.\$transaction\(async \(tx\) =>/);
    assert.match(route, /recordJobPipelineEvent\(/);
    assert.match(route, /await assertJobLifecycleInvariants\(tx, affectedJobIds\)|await assertJobLifecycleInvariants\(tx, \[updated\.id(?:, \.\.\.suppressedDuplicateIds)?\]\)/);
    assert.ok(route.lastIndexOf('recordJobPipelineEvent(') < route.lastIndexOf('assertJobLifecycleInvariants('));
  }
});

test('company cooldown writers share the Inbox-CAS helper and assert returned rows', () => {
  const helper = source('src/lib/companyCooldown.ts');
  const recovery = source('src/lib/cooldownRecovery.ts');
  assert.match(helper, /for \(const candidate of candidates\)/);
  assert.match(helper, /id: candidate\.id,[\s\S]*?status: 'inbox'/);
  assert.match(helper, /if \(cooled\.count === 1\) cooledIds\.push\(candidate\.id\)/);
  assert.match(recovery, /where: \{ id: job\.id, status: 'cooldown' \}/);
  assert.match(recovery, /queueLocalScoring[\s\S]*?scoringStatus: 'queued'/);
  assert.match(recovery, /await assertJobLifecycleInvariants\(tx, \[job\.id\]\)/);

  for (const relativePath of [
    'src/app/api/jobs/[id]/route.ts',
    'src/app/api/tailoring/import/route.ts',
  ]) {
    const route = source(relativePath);
    assert.match(route, /affectedJobIds\.push\(\.\.\.await parkSameCompanyInboxJobs\(\{/);
    assert.doesNotMatch(route, /affectedJobIds\.push\(\.\.\.cooldownIds\)/);
  }
});

test('legacy Cooldown cleanup requeues only a reviewed scoreless cohort through local scoring', () => {
  const cleanup = source('scripts/requeue_cooldown_release_local_scoring.ts');
  assert.match(cleanup, /operationalQueueWhere\('aim_fit', currentSuppressionIds\)/);
  assert.match(cleanup, /scoreEvents:[\s\S]*?AUTHORITATIVE_SCORE_EVENT_TYPES/);
  assert.match(cleanup, /scoringBatchItems: \{ none: \{ status: 'leased' \} \}/);
  assert.match(cleanup, /USER_LIFECYCLE_INTENT_EVENT_TYPES/);
  assert.match(cleanup, /--apply --selection-hash <reviewed-dry-run-hash>/);
  assert.match(cleanup, /updatedAt: candidate\.updatedAt,[\s\S]*?scoringStatus: 'scored'/);
  assert.match(cleanup, /data: \{[\s\S]*?scoringStatus: 'queued'/);
  assert.match(cleanup, /await assertJobLifecycleInvariants\(tx, \[candidate\.id\]\)/);
  assert.match(cleanup, /No Aim or Experience score event is deleted, invalidated, or rewritten/);
});

test('Cooldown cleanup quarantine retry is exact, guarded, and score preserving', () => {
  const retry = source('scripts/retry_cooldown_cleanup_quarantines.ts');
  assert.match(retry, /legacy_local_fallback_requires_recognized_machine_reason/);
  assert.match(retry, /stage: 'cooldown_cleanup'/);
  assert.match(retry, /scoreEvents: \{ none: \{ evaluationType: \{ in: \[\.\.\.AUTHORITATIVE_SCORE_EVENT_TYPES\] \} \} \}/);
  assert.match(retry, /USER_LIFECYCLE_INTENT_EVENT_TYPES/);
  assert.match(retry, /scoringBatchItems: \{ none: \{ status: 'leased' \} \}/);
  assert.match(retry, /--apply --selection-hash <reviewed-dry-run-hash>/);
  assert.match(retry, /updatedAt: candidate\.updatedAt,[\s\S]*?scoringStatus: 'failed'/);
  assert.match(retry, /data: \{[\s\S]*?scoringStatus: 'queued'/);
  assert.match(retry, /await assertJobLifecycleInvariants\(tx, \[candidate\.id\]\)/);
  assert.match(retry, /No Aim or Experience score event is deleted, invalidated, or rewritten/);
});

test('derived duplicate suppression records immutable user authority before route assertions', () => {
  const store = source('src/lib/appliedDuplicateStore.ts');
  assert.match(store, /eventType: 'user_lifecycle'/);
  assert.match(store, /identityParts: \['applied_duplicate_suppression', decision\.id, plan\.jobId\]/);
  assert.match(store, /originDecisionJobId: decision\.id/);
  assert.match(store, /nextStatus: 'dismissed'/);
  assert.ok(store.indexOf('await recordJobPipelineEvent({') < store.indexOf('suppressedIds.push(plan.jobId)'));
});
