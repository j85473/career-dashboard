import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const source = readFileSync(
  path.join(process.cwd(), 'src', 'lib', 'jobStatusEntryOrder.ts'),
  'utf8',
);

test('lifecycle logs order by the latest entry into their current status', () => {
  assert.match(source, /FROM "JobStatusHistory" history/);
  assert.match(source, /history\.status = \$\{historyStatus\}/);
  assert.match(source, /SELECT MAX\(history\."createdAt"\)/);
  assert.match(source, /job\.status = 'dismissed' AND job\."aimFitScore" IS NULL/);
  assert.match(source, /job\.status = 'dismissed' AND job\."aimFitScore" IS NOT NULL/);
  assert.match(source, /client\.job\.count\(\{ where \}\)/);
  assert.match(source, /job\."updatedAt"/);
  assert.match(source, /direction === 'asc'/);
  assert.match(source, /job\.id ASC/);
  assert.doesNotMatch(source, /job\."createdAt"/);
});
