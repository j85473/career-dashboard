import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldAutoRequestNativeScoring } from '../nativeScoringAutoRequest';

const now = new Date('2026-08-09T18:00:00.000Z');

test('automatic A/E request uses queue threshold or oldest-job SLA', () => {
  assert.deepEqual(shouldAutoRequestNativeScoring({ eligibleCount: 3, now }), { create: true, reason: 'queue_threshold' });
  assert.deepEqual(shouldAutoRequestNativeScoring({
    eligibleCount: 1,
    oldestEligibleAt: new Date(now.getTime() - 15 * 60 * 1000),
    now,
  }), { create: true, reason: 'oldest_wait_sla' });
  assert.equal(shouldAutoRequestNativeScoring({
    eligibleCount: 1,
    oldestEligibleAt: new Date(now.getTime() - 14 * 60 * 1000),
    now,
  }).create, false);
});

test('automatic A/E request is single-flight and does not auto-retry hard failures', () => {
  assert.deepEqual(shouldAutoRequestNativeScoring({ eligibleCount: 20, activeRequestStatus: 'running', now }), {
    create: false,
    reason: 'single_flight_request_active',
  });
  assert.deepEqual(shouldAutoRequestNativeScoring({ eligibleCount: 20, activeRequestStatus: 'failed', now }), {
    create: false,
    reason: 'active_failed_request_requires_action',
  });
});
