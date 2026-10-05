import assert from 'node:assert/strict';
import test from 'node:test';
import { firstCollectionCatchupQuery } from '../../src/lib/atsFirstCollectionCatchup';

const runId = 'd3877f93-5a31-41c7-82ba-fd0d38353464';

test('catch-up requires an explicit valid audit identity and binds it as data', () => {
  for (const invalid of ['', 'all', "'; UPDATE x SET y=1; --"]) {
    assert.throws(() => firstCollectionCatchupQuery(invalid, true), /valid --run-id/);
  }
  const query = firstCollectionCatchupQuery(runId, false);
  assert.ok(query.values.includes(runId));
  assert.ok(!query.values.includes('gusto'));
  assert.doesNotMatch(query.text, /UPDATE|DELETE/);
});

test('preview and atomic release share every eligibility guard and preserve rotation and retry state', () => {
  const preview = firstCollectionCatchupQuery(runId, false);
  const apply = firstCollectionCatchupQuery(runId, true);
  assert.ok(apply.text.includes(preview.text.trim()));
  assert.deepEqual(apply.values, preview.values);
  for (const receipt of ['AtsBoardCheckAttempt', 'AtsIngestionBatch', 'AtsEndpointSweepReceipt']) {
    assert.match(preview.text, new RegExp(`NOT EXISTS \\(SELECT 1 FROM "${receipt}"`));
  }
  for (const timestamp of ['lastCheckedAt', 'lastAttemptedAt', 'lastRespondedAt', 'lastSynchronizedAt', 'lastProcessedAt']) {
    assert.ok(preview.text.includes(`board."${timestamp}" IS NULL`));
  }
  assert.match(preview.text, /candidate\.status = 'active'/);
  assert.match(preview.text, /board\."failCount" = 0 AND board\."retryCount" = 0/);
  assert.match(preview.text, /INTERVAL '23 hours 59 minutes' AND INTERVAL '24 hours 1 minute'/);
  assert.match(preview.text, /SELECT DISTINCT slug, platform FROM "AtsEndpointDailyContactReceipt"/);
  assert.match(preview.text, /NOT EXISTS \(SELECT 1 FROM contacts contact/);
  assert.match(preview.text, /WHERE status = 'excluded'/);
  assert.match(apply.text, /FOR UPDATE OF board SKIP LOCKED/);
  assert.match(apply.text, /SET "nextCheckDate" = \(CURRENT_TIMESTAMP AT TIME ZONE 'UTC'\)\s+FROM eligible/);
  assert.doesNotMatch(apply.text, /"Job"|SET\s+(?:status|"checkDay"|"failCount"|"retryCount"|"acquisitionEngine")/);
});
