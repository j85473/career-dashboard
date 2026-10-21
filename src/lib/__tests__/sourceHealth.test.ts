import assert from 'node:assert/strict';
import test from 'node:test';

import { collectionHealth, hasCleanDuplicateOnlyActivity, sourceCollectionHandoff } from '../sourceHealth';

const bamboohr = {
  recentRuns: 1187,
  recentSeenCount: 6419,
  recentDuplicateCount: 6419,
  recentFailedRuns: 0,
  recentRequestErrors: 0,
  recentProcessingErrors: 0,
  recentUnreconciledRuns: 0,
};

test('clean duplicate and filtered listings are healthy without a newly inserted job', () => {
  for (const [runs, seen, duplicates, filtered] of [[10647, 4617, 4544, 73], [34, 156, 108, 48], [1, 1, 0, 1]]) {
    const health = collectionHealth({ ...bamboohr, recentRuns: runs, recentSeenCount: seen,
      recentInsertedCount: 0, recentDuplicateCount: duplicates, recentFilteredCount: filtered });
    assert.equal(health.verdict, 'healthy');
    assert.match(health.reason, /filtered; no recorded errors/);
  }
});

test('no recent checks is unmeasured, while checked empty feeds are explicitly silent', () => {
  const empty = { ...bamboohr, recentSeenCount: 0, recentInsertedCount: 0, recentDuplicateCount: 0, recentFilteredCount: 0 };
  assert.match(collectionHealth({ ...empty, recentRuns: 0 }).reason, /health is unmeasured/);
  assert.match(collectionHealth({ ...empty, recentRuns: 2 }).reason, /returned no listings/);
  assert.equal(collectionHealth({ ...empty, recentRuns: 0 }).verdict, 'silent');
});

test('partial-run request errors and accounting failures cannot be hidden by clean or older output', () => {
  const current = { ...bamboohr, recentInsertedCount: 0, recentFilteredCount: 0 };
  assert.equal(collectionHealth({ ...current, recentRequestErrors: 1 }).verdict, 'degraded');
  assert.equal(collectionHealth({ ...current, recentProcessingErrors: 1 }).verdict, 'degraded');
  assert.equal(collectionHealth({ ...current, recentUnreconciledRuns: 1 }).verdict, 'degraded');
  assert.equal(collectionHealth({ ...current, recentSeenCount: 0, recentRequestErrors: 1 }).verdict, 'failing');
  assert.equal(collectionHealth({ ...current, recentFailedRuns: current.recentRuns }).verdict, 'failing');
  assert.equal(collectionHealth({ ...current, recentDuplicateCount: 6418 }).verdict, 'degraded');
  assert.equal(collectionHealth({ ...current, recentSeenCount: 6420, recentInsertedCount: 1, recentRequestErrors: 1 }).verdict, 'degraded');
});

test('clean duplicate-only checks show a source is responding even without new jobs', () => {
  assert.equal(hasCleanDuplicateOnlyActivity(bamboohr), true);
});

test('Gusto history is historical only after a proven retired-to-browser handoff', () => {
  const previous = { source: 'ATS-gusto', hasActiveTask: false, lastRunAt: '2026-10-01T02:37:02Z', replacementFirstRunAt: '2026-10-01T02:58:22Z' };
  assert.equal(sourceCollectionHandoff(previous)?.verdict, 'historical');
  for (const changes of [
    { source: 'Gusto' }, { source: 'ATS-workday' }, { hasActiveTask: true },
    { lastRunAt: null }, { replacementFirstRunAt: null },
    { lastRunAt: '2026-10-05T19:00:00Z' }, { lastRunAt: 'invalid' },
  ]) assert.equal(sourceCollectionHandoff({ ...previous, ...changes }), null);
});

test('silence, failed requests, and unreconciled counts cannot look healthy', () => {
  for (const changes of [
    { recentRuns: 0 },
    { recentSeenCount: 0, recentDuplicateCount: 0 },
    { recentDuplicateCount: 6418 },
    { recentFailedRuns: 1 },
    { recentRequestErrors: 1 },
    { recentProcessingErrors: 1 },
    { recentUnreconciledRuns: 1 },
  ]) {
    assert.equal(hasCleanDuplicateOnlyActivity({ ...bamboohr, ...changes }), false);
  }
});
