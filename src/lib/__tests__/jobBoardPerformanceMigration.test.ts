import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(
  'prisma/migrations/20260827210000_job_board_performance_indexes/migration.sql',
  'utf8',
);

test('board performance migration adds only the three live-plan-backed indexes', () => {
  assert.match(migration, /Job_tailoringStaged_idx/);
  assert.match(migration, /Job_status_updatedAt_idx/);
  assert.match(migration, /JobSourceObservation_jobId_idx/);
  assert.doesNotMatch(migration, /\b(?:DROP|DELETE|UPDATE|TRUNCATE)\b/i);
});
