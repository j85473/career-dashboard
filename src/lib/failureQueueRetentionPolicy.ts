import { USER_LIFECYCLE_INTENT_EVENT_TYPES } from './userLifecycleAuthority';

export const FAILURE_QUEUE_RETENTION_DAYS = 10;
export const FAILURE_QUEUE_RETENTION_MS = FAILURE_QUEUE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
export const FAILURE_QUEUE_EXPIRATION_EVENT_TYPE = 'failure_queue_expired';

export type FailureQueueRetentionCategory = 'jd_failed' | 'scoring_failed';

export type FailureQueueRetentionEntry = {
  id: string;
  category: FailureQueueRetentionCategory;
  failedAt: Date;
};

export type FailureQueueUserActivity = {
  jobId: string | null;
  occurredAt: Date;
};

export type LifecycleAuthorityEvent = {
  id: string;
  eventType: string;
  occurredAt: Date | string;
  details?: unknown;
};

export type AutomatedLifecycleDisposition = {
  eventId: string;
  expectedStatus: 'dismissed';
};

function detailsRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function timestamp(value: Date | string): number {
  const time = value instanceof Date ? value.valueOf() : new Date(value).valueOf();
  return Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY;
}

function latestEvent(events: readonly LifecycleAuthorityEvent[]): LifecycleAuthorityEvent | null {
  return [...events].sort((left, right) => timestamp(right.occurredAt) - timestamp(left.occurredAt)
    || right.id.localeCompare(left.id))[0] || null;
}

/**
 * A user lifecycle action at or after the current failure means the queue item
 * was not ignored. Activity before a later failure does not indefinitely
 * protect the new failure from the retention rule.
 */
export function expiredFailureQueueEntries(
  entries: readonly FailureQueueRetentionEntry[],
  userActivity: readonly FailureQueueUserActivity[],
  now: Date,
): FailureQueueRetentionEntry[] {
  const cutoff = now.valueOf() - FAILURE_QUEUE_RETENTION_MS;
  const latestUserActivity = new Map<string, number>();
  for (const event of userActivity) {
    if (!event.jobId) continue;
    const eventAt = event.occurredAt.valueOf();
    latestUserActivity.set(event.jobId, Math.max(latestUserActivity.get(event.jobId) ?? -Infinity, eventAt));
  }

  return entries.filter((entry) => (
    entry.failedAt.valueOf() <= cutoff
    && (latestUserActivity.get(entry.id) ?? -Infinity) < entry.failedAt.valueOf()
  ));
}

/**
 * Let the lifecycle invariant recognize this one explicit automated dismissal
 * without misclassifying it as a human rejection. A later user action always
 * retakes authority.
 */
export function failureQueueExpirationDisposition(
  events: readonly LifecycleAuthorityEvent[],
): AutomatedLifecycleDisposition | null {
  const latestUser = latestEvent(events.filter((event) => (
    (USER_LIFECYCLE_INTENT_EVENT_TYPES as readonly string[]).includes(event.eventType)
  )));
  const latestExpiration = latestEvent(events.filter((event) => {
    if (event.eventType !== FAILURE_QUEUE_EXPIRATION_EVENT_TYPE) return false;
    const details = detailsRecord(event.details);
    return details.actor === 'machine'
      && details.route === 'failure_queue_retention'
      && details.nextStatus === 'dismissed';
  }));
  if (!latestExpiration) return null;
  if (latestUser && timestamp(latestExpiration.occurredAt) <= timestamp(latestUser.occurredAt)) return null;
  return { eventId: latestExpiration.id, expectedStatus: 'dismissed' };
}

export function failureQueueExpirationReason(category: FailureQueueRetentionCategory): string {
  const queue = category === 'jd_failed' ? 'JD Failed' : 'Scoring Failed';
  return `Not interested — automatically dismissed after ${FAILURE_QUEUE_RETENTION_DAYS} days in ${queue}.`;
}
