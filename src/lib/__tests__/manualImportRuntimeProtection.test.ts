import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

function source(...parts: string[]): string {
  return readFileSync(path.join(process.cwd(), ...parts), 'utf8');
}

const batchJd = source('src', 'app', 'api', 'jobs', 'batch-jd-submit', 'route.ts');
const genericPatch = source('src', 'app', 'api', 'jobs', '[id]', 'route.ts');
const passRoute = source('src', 'app', 'api', 'jobs', '[id]', 'pass', 'route.ts');
const tailoringImport = source('src', 'app', 'api', 'tailoring', 'import', 'route.ts');
const duplicateStore = source('src', 'lib', 'appliedDuplicateStore.ts');
const cooldown = source('src', 'lib', 'cooldownRecovery.ts');
const expiry = source('src', 'lib', 'inboxEnteredAt.ts');
const verification = source('src', 'lib', 'verifyJobsAlive.ts');
const reaper = source('src', 'lib', 'reaper.ts');
const invalidation = source('src', 'lib', 'scoreInvalidation.ts');
const reconciliation = source('src', 'lib', 'scoringInputReconciliation.ts');
const ingestion = source('src', 'lib', 'jobIngestion.ts');
const aimFloorReconciliation = source('scripts', 'reconcile_aim_queue_floor.ts');
const localTriageBackfill = source('scripts', 'backfill_local_triage.ts');
const appliedDuplicateCleanup = source('scripts', 'dismiss_applied_duplicates.ts');
const legacyLabelFix = source('scripts', 'fix_job_labels.ts');
const cleanInbox = source('src', 'scripts', 'cleanInbox.ts');

test('every JD recovery dismissal and duplicate branch protects Manual Imports', () => {
  assert.match(batchJd, /const lifecycleProtected = automatedLifecycleIsProtected\(job\)/);
  assert.match(batchJd, /lifecycleProtected\s*\? manualImportInformationalScoringUpdate/);
  assert.match(batchJd, /duplicate && duplicate\.id !== job\.id && !lifecycleProtected/);
  assert.doesNotMatch(batchJd, /updateClaimedInputs\(job, buildClosedPostingUpdate\(\), \[\]\)/);
});

test('applied-duplicate and same-company cooldown automation exclude Manual Imports', () => {
  assert.match(duplicateStore, /AND: \[nonManualImportSourceWhere\(\)\]/);
  assert.match(genericPatch, /AND: \[nonManualImportSourceWhere\(\)\]/);
  assert.match(genericPatch, /!automatedLifecycleIsProtected\(updated\)/);
  assert.match(tailoringImport, /AND: \[nonManualImportSourceWhere\(\)\]/);
});

test('expiry, URL verification, reaping, and cooldown automation exclude Manual Imports', () => {
  assert.match(expiry, /j\.source IS DISTINCT FROM 'Manual Import'/);
  assert.match(expiry, /AND: \[nonManualImportSourceWhere\(\)\]/);
  assert.match(verification, /nonManualImportSourceWhere\(\)/);
  assert.match(reaper, /AND: \[nonManualImportSourceWhere\(\)\]/);
  assert.match(cooldown, /AND: \[nonManualImportSourceWhere\(\)\]/);
});

test('score invalidation and version reconciliation cannot requeue a Manual Import lifecycle', () => {
  assert.match(invalidation, /!automatedLifecycleIsProtected\(job\)/);
  assert.match(reconciliation, /!automatedLifecycleIsProtected\(job\)/);
  assert.match(invalidation, /status: true, tailoringStaged: true, source: true/);
  assert.match(reconciliation, /status: true, tailoringStaged: true, source: true/);
});

test('ingestion closure, prefilter, and initial lifecycle honor the Manual Import source policy', () => {
  assert.match(ingestion, /AND: \[nonManualImportSourceWhere\(\)\]/);
  assert.match(ingestion, /!lifecycleProtectedSource && !enrichedPostingClosed && !preFilterResult\.passes/);
  assert.match(ingestion, /lifecycleProtectedSource\s*\? MANUAL_IMPORT_INITIAL_LIFECYCLE\.status/);
  assert.match(ingestion, /tailoringStaged: MANUAL_IMPORT_INITIAL_LIFECYCLE\.tailoringStaged/);
});

test('explicit Joseph lifecycle routes retain authority over Manual Imports', () => {
  assert.match(genericPatch, /if \(status !== undefined\) \{/);
  assert.match(genericPatch, /data\.status = status/);
  assert.match(passRoute, /status: 'passed'/);
  assert.match(passRoute, /tailoringStaged: false/);
  assert.match(tailoringImport, /status: 'applied'/);
  assert.match(tailoringImport, /tailoringStaged: false/);
});

test('generic operator automation cannot bypass the Manual Import source guard', () => {
  for (const script of [
    aimFloorReconciliation,
    localTriageBackfill,
    appliedDuplicateCleanup,
    cleanInbox,
  ]) {
    assert.match(script, /nonManualImportSourceWhere/);
  }
  assert.match(aimFloorReconciliation, /AND: \[nonManualImportSourceWhere\(\)\]/);
  assert.match(localTriageBackfill, /AND: \[nonManualImportSourceWhere\(\)\]/);
  assert.match(appliedDuplicateCleanup, /AND: \[nonManualImportSourceWhere\(\)\]/);
  assert.match(legacyLabelFix, /source IS DISTINCT FROM \$\{MANUAL_IMPORT_SOURCE\}/);
});

test('no Prisma lifecycle guard uses the NULL-dropping direct not predicate', () => {
  const guardedSources = [
    batchJd,
    genericPatch,
    tailoringImport,
    duplicateStore,
    cooldown,
    expiry,
    verification,
    reaper,
    ingestion,
    aimFloorReconciliation,
    localTriageBackfill,
    appliedDuplicateCleanup,
    cleanInbox,
  ].join('\n');
  assert.doesNotMatch(guardedSources, /source:\s*\{\s*not:\s*MANUAL_IMPORT_SOURCE/);
});
