import assert from 'node:assert/strict';
import test from 'node:test';

import {
  advancedJobStatusWhere,
  hasOnlyValidAdvancedJobSearchStatuses,
  isAdvancedJobSearchField,
  jobMatchesAdvancedStatuses,
  parseAdvancedJobSearchStatuses,
} from '../advancedJobSearch';

test('advanced search accepts only the supported field choices', () => {
  assert.equal(isAdvancedJobSearchField('title'), true);
  assert.equal(isAdvancedJobSearchField('description'), true);
  assert.equal(isAdvancedJobSearchField('source'), false);
  assert.equal(isAdvancedJobSearchField(null), false);
});

test('advanced status filters are validated, deduplicated, and kept in request order', () => {
  assert.equal(hasOnlyValidAdvancedJobSearchStatuses('inbox,applied,cooldown'), true);
  assert.equal(hasOnlyValidAdvancedJobSearchStatuses('inbox,not-a-status'), false);
  assert.deepEqual(parseAdvancedJobSearchStatuses('dismissed,cooldown,dismissed'), ['dismissed', 'cooldown']);
});

test('Inbox excludes tailoring while Dismissed includes both scored and local rejects', () => {
  assert.deepEqual(advancedJobStatusWhere(['inbox', 'dismissed']), {
    OR: [
      { status: 'inbox', tailoringStaged: false },
      { status: 'dismissed' },
    ],
  });
  assert.equal(jobMatchesAdvancedStatuses({ status: 'inbox', tailoringStaged: true }, ['inbox']), false);
  assert.equal(jobMatchesAdvancedStatuses({ status: 'dismissed' }, ['dismissed']), true);
});

test('multiple status filters are an inclusive OR and no filters means every lifecycle', () => {
  assert.equal(jobMatchesAdvancedStatuses({ status: 'cooldown' }, ['dismissed', 'cooldown']), true);
  assert.equal(jobMatchesAdvancedStatuses({ status: 'applied' }, ['dismissed', 'cooldown']), false);
  assert.equal(jobMatchesAdvancedStatuses({ status: 'pending_af' }, []), true);
});
