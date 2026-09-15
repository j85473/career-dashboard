import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const source = readFileSync(
  path.join(process.cwd(), 'src', 'lib', 'scoringFailureOrder.ts'),
  'utf8',
);

test('failed queues order by durable failure evidence and never by ingestion time', () => {
  assert.match(source, /FROM "JobScoringStatusHistory" history/);
  assert.match(source, /history\."scoringStatus" = 'failed'/);
  assert.match(source, /FROM "AimScoringFailureReceipt" receipt/);
  assert.match(source, /receipt\."suppressionActive" = true/);
  assert.match(source, /receipt\."clearedAt" IS NULL/);
  assert.match(source, /job\."updatedAt"/);
  assert.match(source, /\) DESC,[\s\S]*job\.id ASC/);
  assert.doesNotMatch(source, /job\."createdAt"/);
});
