import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  expiredFailureQueueEntries,
  failureQueueExpirationDisposition,
  failureQueueExpirationReason,
  FAILURE_QUEUE_RETENTION_MS,
} from '../failureQueueRetentionPolicy';

const now = new Date('2026-09-17T18:00:00.000Z');

test('failed queues expire only after a full ten days without later user activity', () => {
  const exactlyTenDaysOld = new Date(now.valueOf() - FAILURE_QUEUE_RETENTION_MS);
  const entries = [
    { id: 'jd-old', category: 'jd_failed' as const, failedAt: exactlyTenDaysOld },
    { id: 'scoring-new', category: 'scoring_failed' as const, failedAt: new Date(exactlyTenDaysOld.valueOf() + 1) },
    { id: 'touched-after-failure', category: 'scoring_failed' as const, failedAt: exactlyTenDaysOld },
    { id: 'touched-before-failure', category: 'jd_failed' as const, failedAt: exactlyTenDaysOld },
  ];
  const userActivity = [
    { jobId: 'touched-after-failure', occurredAt: new Date(exactlyTenDaysOld.valueOf() + 1) },
    { jobId: 'touched-before-failure', occurredAt: new Date(exactlyTenDaysOld.valueOf() - 1) },
  ];

  assert.deepEqual(
    expiredFailureQueueEntries(entries, userActivity, now).map((entry) => entry.id),
    ['jd-old', 'touched-before-failure'],
  );
});

test('the retention receipt is automated authority only until a later user action', () => {
  const expiration = {
    id: 'expiration',
    eventType: 'failure_queue_expired',
    occurredAt: '2026-09-17T18:00:00.000Z',
    details: { actor: 'machine', route: 'failure_queue_retention', nextStatus: 'dismissed' },
  };
  const olderUserAction = {
    id: 'older-user', eventType: 'user_promote', occurredAt: '2026-09-16T18:00:00.000Z', details: {},
  };
  const newerUserAction = {
    id: 'newer-user', eventType: 'user_promote', occurredAt: '2026-09-18T18:00:00.000Z', details: {},
  };

  assert.deepEqual(failureQueueExpirationDisposition([olderUserAction, expiration]), {
    eventId: 'expiration', expectedStatus: 'dismissed',
  });
  assert.equal(failureQueueExpirationDisposition([olderUserAction, expiration, newerUserAction]), null);
});

test('automatic dismissal is visible, audited, score-preserving, and runs in maintenance', () => {
  const retention = readFileSync(path.join(process.cwd(), 'src/lib/failureQueueRetention.ts'), 'utf8');
  const pipeline = readFileSync(path.join(process.cwd(), 'src/app/api/pipeline/run/route.ts'), 'utf8');
  const log = readFileSync(path.join(process.cwd(), 'src/components/ScoringLogTab.tsx'), 'utf8');

  assert.match(retention, /status: 'dismissed'/);
  assert.match(retention, /eventType: FAILURE_QUEUE_EXPIRATION_EVENT_TYPE/);
  assert.match(retention, /assertJobLifecycleInvariants\(tx, jobIds\)/);
  assert.doesNotMatch(retention, /aimFitScore:\s*null|reqFitScore:\s*null|scoreEvents\.(?:delete|update)/);
  assert.match(pipeline, /await dismissExpiredFailureQueueJobs\(\)/);
  assert.match(log, /automatically dismissed after 10 days/g);
  assert.match(failureQueueExpirationReason('jd_failed'), /Not interested.*10 days.*JD Failed/);
});
