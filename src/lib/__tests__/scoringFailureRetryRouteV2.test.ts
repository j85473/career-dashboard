import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const route = readFileSync(path.join(
  process.cwd(), 'src/app/api/scoring/failures/[id]/retry/route.ts',
), 'utf8');
const helper = readFileSync(path.join(process.cwd(), 'src/lib/aimScoringFailure.ts'), 'utf8');

test('reason-bound one-job retry is always available and transactionally locked', () => {
  assert.match(route, /Object\.keys\(body\)[\s\S]*key !== 'reason'/);
  assert.doesNotMatch(route, /EXPORT_ENABLED|export is disabled|scoringRuntimeConfig/);
  assert.match(helper, /SELECT \* FROM "AimScoringFailureReceipt"[\s\S]*FOR UPDATE/);
  assert.match(helper, /SELECT id FROM "Job"[\s\S]*FOR UPDATE/);
  assert.match(helper, /status = 'leased'[\s\S]*FOR UPDATE/);
  assert.match(helper, /batchInput\.items\.length !== 1/);
  assert.match(helper, /manualRetryOfFailureReceiptId = lockedReceipt\.id/);
  assert.doesNotMatch(helper, /suppressionActive:\s*false[\s\S]*createScoringBatchInTransaction/);
});
