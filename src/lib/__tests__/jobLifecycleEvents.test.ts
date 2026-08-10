import assert from 'node:assert/strict';
import test from 'node:test';

import { humanLifecycleEvent } from '../jobLifecycleEvents';

test('non-inbox to inbox is one explicit human promotion', () => {
  assert.deepEqual(humanLifecycleEvent('dismissed', 'inbox', 'inbox'), {
    eventType: 'user_promote',
    enteredInbox: true,
    priorStatus: 'dismissed',
    nextStatus: 'inbox',
  });
  assert.equal(humanLifecycleEvent('inbox', 'inbox', 'inbox'), null);
});

test('company cooldown diversion is not counted as entered inbox', () => {
  assert.equal(humanLifecycleEvent('bookmarked', 'inbox', 'cooldown'), null);
});

test('human pass and dismiss decisions emit rejection events only on transitions', () => {
  assert.equal(humanLifecycleEvent('passed', 'passed', 'passed'), null);
  assert.deepEqual(humanLifecycleEvent('inbox', 'passed', 'passed'), {
    eventType: 'user_reject',
    enteredInbox: false,
    priorStatus: 'inbox',
    nextStatus: 'passed',
  });
  assert.deepEqual(humanLifecycleEvent('pending_af', 'dismissed', 'dismissed')?.eventType, 'user_reject');
});
