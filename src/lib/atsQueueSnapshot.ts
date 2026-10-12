/** JSON-safe operator telemetry. Counts use distinct stages, never a combined
 * total of boards, candidates, segments and jobs. */
export type AtsQueueHold = {
  stage: 'Validation' | 'Size review' | 'First collection' | 'Acquisition' | 'Persistence' | 'Provider' | 'Common Crawl';
  provider: string;
  reason: string;
  count: number;
  unit: 'candidates' | 'boards' | 'batches' | 'segments' | 'providers' | 'checkpoints';
  items: number;
  retryAt: string | null;
  lastRetryAt: string | null;
  example: string | null;
};
export type AtsQueueSnapshot = {
  observedAt: string;
  mode: string;
  admissionNote: string;
  validationDue: number;
  validationHeld: number;
  sizeReview: number;
  ready: number;
  awaitingHandoff: number;
  collecting: number;
  persistenceDue: number;
  persistenceHeld: number;
  holds: AtsQueueHold[];
};

export function atsRetryLabel(retryAt: string | null, observedAt: string, review = false): string {
  if (review) return 'Review required · no automatic retry';
  if (!retryAt) return 'No retry time recorded';
  const time = new Date(retryAt);
  if (!Number.isFinite(time.valueOf())) return 'Retry time unavailable';
  if (time.valueOf() <= new Date(observedAt).valueOf()) return 'Eligible now';
  return `${time.toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} Central`;
}
