export type HumanLifecycleEvent = {
  eventType: 'user_promote' | 'user_reject' | 'user_lifecycle' | 'user_rescore';
  enteredInbox: boolean;
  priorStatus: string;
  nextStatus: string;
  protected: boolean;
  actor: 'user';
};

export const PROTECTED_USER_STATUSES = [
  'inbox', 'passed', 'dismissed', 'bookmarked', 'applied', 'interviewing', 'expired', 'archived', 'cooldown',
] as const;

/**
 * Converts a requested human lifecycle mutation into its immutable metric
 * event. The final persisted status controls the result so a requested Inbox
 * restore that is diverted to company Cooldown is not counted as admission.
 */
export function humanLifecycleEvent(
  priorStatus: string,
  requestedStatus: unknown,
  finalStatus: string,
): HumanLifecycleEvent | null {
  if (typeof requestedStatus !== 'string' || priorStatus === finalStatus) return null;
  if (requestedStatus === 'inbox' && finalStatus === 'inbox') {
    return {
      eventType: 'user_promote',
      enteredInbox: true,
      priorStatus,
      nextStatus: finalStatus,
      protected: true,
      actor: 'user',
    };
  }
  if (['passed', 'dismissed'].includes(requestedStatus) && finalStatus === requestedStatus) {
    return {
      eventType: 'user_reject',
      enteredInbox: false,
      priorStatus,
      nextStatus: finalStatus,
      protected: true,
      actor: 'user',
    };
  }
  if ((PROTECTED_USER_STATUSES as readonly string[]).includes(finalStatus)) {
    return {
      eventType: 'user_lifecycle', enteredInbox: false, priorStatus, nextStatus: finalStatus, protected: true, actor: 'user',
    };
  }
  if (finalStatus === 'pending_af') {
    return {
      eventType: 'user_rescore', enteredInbox: false, priorStatus, nextStatus: finalStatus, protected: false, actor: 'user',
    };
  }
  return null;
}
