export const FINAL_USER_LIFECYCLE_EVENT_TYPES = [
  'user_promote', 'user_reject', 'user_lifecycle',
] as const;
export const USER_LIFECYCLE_INTENT_EVENT_TYPES = [
  ...FINAL_USER_LIFECYCLE_EVENT_TYPES, 'user_rescore',
] as const;

export type UserLifecycleIntentEvent = {
  id: string;
  eventType: string;
  occurredAt: Date | string;
  details?: unknown;
};

export type LatestUserLifecycleIntent = {
  kind: 'none' | 'rescore' | 'final';
  eventId: string | null;
  expectedStatus: string | null;
  expectedTailoringStaged: boolean | null;
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

export function latestUserLifecycleIntent(
  events: readonly UserLifecycleIntentEvent[],
): LatestUserLifecycleIntent {
  const [latest] = [...events]
    .filter((event) => (USER_LIFECYCLE_INTENT_EVENT_TYPES as readonly string[]).includes(event.eventType))
    .sort((left, right) => timestamp(right.occurredAt) - timestamp(left.occurredAt)
      || right.id.localeCompare(left.id));
  if (!latest) {
    return { kind: 'none', eventId: null, expectedStatus: null, expectedTailoringStaged: null };
  }
  if (latest.eventType === 'user_rescore') {
    return { kind: 'rescore', eventId: latest.id, expectedStatus: null, expectedTailoringStaged: null };
  }
  const details = detailsRecord(latest.details);
  const expectedStatus = typeof details.nextStatus === 'string'
    ? details.nextStatus
    : typeof details.status === 'string'
      ? details.status
    : latest.eventType === 'user_promote' ? 'inbox' : null;
  return {
    kind: 'final',
    eventId: latest.id,
    expectedStatus,
    expectedTailoringStaged: typeof details.nextTailoringStaged === 'boolean'
      ? details.nextTailoringStaged
      : null,
  };
}

export function finalUserLifecycleIntentMatchesState(
  intent: LatestUserLifecycleIntent,
  state: { status: string; tailoringStaged: boolean },
): boolean {
  return userLifecycleIntentDrift(intent, state) === 'matches';
}

/**
 * Lifecycle exits that automation is allowed to take *after* a user decision.
 * The fifteen-day Inbox review window and company cooldown both move a job the
 * user promoted, and neither writes a user event — so a promoted job that later
 * expires is a policy working as designed, not a corrupted row.
 */
export const AUTOMATED_SUPERSEDING_STATUSES = ['expired', 'cooldown', 'archived'] as const;

export type UserLifecycleIntentDrift = 'matches' | 'unknown' | 'superseded' | 'contradicted';

/**
 * How a job's current state relates to the user's last explicit decision.
 *
 * `unknown` covers legacy events that never recorded a target state; they still
 * prove the user acted, so callers protect the job without treating the missing
 * detail as evidence of corruption.
 */
export function userLifecycleIntentDrift(
  intent: LatestUserLifecycleIntent,
  state: { status: string; tailoringStaged: boolean },
): UserLifecycleIntentDrift {
  if (intent.kind !== 'final') return 'unknown';
  if (intent.expectedStatus === null && intent.expectedTailoringStaged === null) return 'unknown';
  const statusMatches = intent.expectedStatus === null || intent.expectedStatus === state.status;
  const tailoringMatches = intent.expectedTailoringStaged === null
    || intent.expectedTailoringStaged === state.tailoringStaged;
  if (statusMatches && tailoringMatches) return 'matches';
  return (AUTOMATED_SUPERSEDING_STATUSES as readonly string[]).includes(state.status)
    ? 'superseded'
    : 'contradicted';
}
