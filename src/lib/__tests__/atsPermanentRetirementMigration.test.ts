import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const migration = fs.readFileSync(
  path.join(
    process.cwd(),
    'prisma/migrations/20260917160000_reconcile_permanent_ats_retirements/migration.sql',
  ),
  'utf8',
);

test('permanent ATS retirement reconciliation is identity-wide and preserves stored jobs', () => {
  assert.match(migration, /lower\(slug\)/);
  assert.match(migration, /status <> 'excluded'/);
  assert.match(migration, /same board as .+ with different capitals/i);
  assert.doesNotMatch(migration, /UPDATE\s+"Job"/i);
  assert.doesNotMatch(migration, /DELETE\s+FROM/i);
});

test('permanent ATS retirement reconciliation refuses acquired batches before writing', () => {
  const guard = migration.indexOf('RAISE EXCEPTION');
  const firstLifecycleWrite = migration.indexOf('UPDATE "AtsAcquisitionWorkReceipt"');
  assert.ok(guard >= 0 && firstLifecycleWrite > guard);
  assert.match(migration, /"rawObservationCount" > 0/);
  assert.match(migration, /"canonicalOccurrenceCount" > 0/);
  assert.match(migration, /"publishedItemCount" > 0/);
  assert.match(migration, /SET status = 'excluded'/);
  assert.doesNotMatch(migration, /SET status = 'operator_abandoned'/);
});

test('permanent ATS retirement reconciliation closes only selected alias work', () => {
  assert.match(migration, /_PermanentAtsRetirementAliases/);
  assert.match(migration, /_PermanentAtsRetirementBatches/);
  assert.match(migration, /permanent_retirement_alias_reconciliation_v1/);
  assert.match(migration, /operator_permanent_retirement_alias/);
});
