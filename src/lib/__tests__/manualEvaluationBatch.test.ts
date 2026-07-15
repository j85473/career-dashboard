import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseContextProfileVersion,
  parseVersionedEntries,
  versionsMatch,
} from '../manualEvaluationBatch';

const timestamp = '2026-07-15T17:45:00.000Z';

test('offline batch parser requires an optimistic version for every submitted ID', () => {
  const parsed = parseVersionedEntries({
    jobScores: [{ id: 'job-1', submittedUpdatedAt: timestamp }],
  }, 'jobScores');

  assert.deepEqual(parsed.ids, ['job-1']);
  assert.equal(parsed.versions.get('job-1'), timestamp);
  assert.throws(() => parseVersionedEntries({ jobScores: [{ id: 'job-1' }] }, 'jobScores'), /submittedUpdatedAt/);
});

test('offline context feedback requires versioned objects rather than bare IDs', () => {
  assert.throws(() => parseVersionedEntries({
    processedContextJobs: ['feedback-1'],
  }, 'processedContextJobs'), /non-empty id/);
});

test('context profile version is required and accepts explicit null for an absent profile', () => {
  assert.equal(parseContextProfileVersion({ submittedContextProfileUpdatedAt: timestamp }), timestamp);
  assert.equal(parseContextProfileVersion({ submittedContextProfileUpdatedAt: null }), null);
  assert.throws(() => parseContextProfileVersion({}), /required/);
});

test('version comparison rejects missing, added, or modified records', () => {
  const submitted = parseVersionedEntries({
    processedContextJobs: [{ id: 'feedback-1', submittedUpdatedAt: timestamp }],
  }, 'processedContextJobs');

  assert.equal(versionsMatch([{ id: 'feedback-1', updatedAt: new Date(timestamp) }], submitted), true);
  assert.equal(versionsMatch([{ id: 'feedback-1', updatedAt: new Date('2026-07-15T17:46:00.000Z') }], submitted), false);
  assert.equal(versionsMatch([], submitted), false);
});
