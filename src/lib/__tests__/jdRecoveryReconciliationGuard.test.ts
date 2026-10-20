import assert from 'node:assert/strict';
import test from 'node:test';
import { eligibleJdRepairWhere, parseJdRepairArguments } from '../../../scripts/reconcile_jd_recovery_false_rejections';

test('JD repair defaults to a dry run and holds unresolved extraction failures', () => {
  assert.deepEqual(parseJdRepairArguments([]), { apply: false, retryUnresolved: false, selectionHash: null, ids: [] });
  assert.throws(() => parseJdRepairArguments(['--apply']), /selection-hash/);
  assert.throws(() => parseJdRepairArguments(['--apply', '--selection-hash', 'bad']), /invalid argument/);
  const hash = 'a'.repeat(64);
  const parsed = parseJdRepairArguments(['--apply', '--selection-hash', hash, '--retry-unresolved']);
  assert.equal(parsed.apply, true);
  assert.equal(parsed.retryUnresolved, true);
  assert.equal(parsed.selectionHash, hash);
});

test('JD repair cannot select scored, batched, staged, or human-owned work', () => {
  assert.equal(eligibleJdRepairWhere.scoringStatus, 'failed');
  assert.equal(eligibleJdRepairWhere.tailoringStaged, false);
  for (const key of ['fitScore', 'aimFitScore', 'reqFitScore', 'batchJobId', 'jdBatchId', 'afBatchId'] as const) {
    assert.equal(eligibleJdRepairWhere[key], null);
  }
  assert.deepEqual(eligibleJdRepairWhere.scoreEvents, { none: {} });
  assert(eligibleJdRepairWhere.pipelineEvents?.none, 'User decisions and completed repairs must be excluded at write time');
});
