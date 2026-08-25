import assert from 'node:assert/strict';
import test from 'node:test';

import {
  finalUserLifecycleIntentMatchesState,
  latestUserLifecycleIntent,
} from '../userLifecycleAuthority';

test('a later rescore supersedes an older final lifecycle decision', () => {
  const intent = latestUserLifecycleIntent([
    {
      id: 'reject', eventType: 'user_reject', occurredAt: '2026-08-23T12:00:00Z',
      details: { nextStatus: 'dismissed' },
    },
    { id: 'rescore', eventType: 'user_rescore', occurredAt: '2026-08-23T12:01:00Z' },
  ]);
  assert.equal(intent.kind, 'rescore');
  assert.equal(intent.eventId, 'rescore');
});

test('a later final lifecycle action supersedes rescore and must match persisted state', () => {
  const intent = latestUserLifecycleIntent([
    { id: 'rescore', eventType: 'user_rescore', occurredAt: '2026-08-23T12:00:00Z' },
    {
      id: 'reject', eventType: 'user_reject', occurredAt: '2026-08-23T12:01:00Z',
      details: { nextStatus: 'dismissed' },
    },
  ]);
  assert.equal(intent.kind, 'final');
  assert.equal(finalUserLifecycleIntentMatchesState(intent, {
    status: 'dismissed', tailoringStaged: false,
  }), true);
  assert.equal(finalUserLifecycleIntentMatchesState(intent, {
    status: 'inbox', tailoringStaged: false,
  }), false);
});

test('a final event without a verifiable target state fails closed', () => {
  const intent = latestUserLifecycleIntent([
    { id: 'legacy-reject', eventType: 'user_reject', occurredAt: '2026-08-23T12:00:00Z' },
  ]);
  assert.equal(intent.kind, 'final');
  assert.equal(finalUserLifecycleIntentMatchesState(intent, {
    status: 'dismissed', tailoringStaged: false,
  }), false);
});

test('tailoring lifecycle intent verifies both recorded status and staged state', () => {
  const intent = latestUserLifecycleIntent([{
    id: 'tailoring', eventType: 'user_lifecycle', occurredAt: '2026-08-23T12:00:00Z',
    details: { status: 'inbox', nextTailoringStaged: true },
  }]);
  assert.equal(finalUserLifecycleIntentMatchesState(intent, {
    status: 'inbox', tailoringStaged: true,
  }), true);
  assert.equal(finalUserLifecycleIntentMatchesState(intent, {
    status: 'inbox', tailoringStaged: false,
  }), false);
});
