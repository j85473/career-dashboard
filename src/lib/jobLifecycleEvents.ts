export type HumanLifecycleEvent = {
  eventType: 'user_promote' | 'user_reject';
  enteredInbox: boolean;
  priorStatus: string;
  nextStatus: string;
};

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
    };
  }
  if (['passed', 'dismissed'].includes(requestedStatus) && finalStatus === requestedStatus) {
    return {
      eventType: 'user_reject',
      enteredInbox: false,
      priorStatus,
      nextStatus: finalStatus,
    };
  }
  return null;
}
