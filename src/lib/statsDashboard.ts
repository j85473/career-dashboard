export type TrackingCoverage = 'untracked' | 'partial' | 'tracked';

export interface IngestionOutcomeCounts {
  seen: number;
  ingested: number;
  duplicates: number;
  filtered: number;
  processingErrors: number;
  providerErrors: number;
}

export function ingestionOutcomesReconcile(counts: IngestionOutcomeCounts): boolean {
  return counts.seen === counts.ingested
    + counts.duplicates
    + counts.filtered
    + counts.processingErrors;
}

/** Provider/request errors are outside the per-job seen denominator. */
export function ingestionAccountedOutcomes(counts: IngestionOutcomeCounts): number {
  return counts.ingested + counts.duplicates + counts.filtered + counts.processingErrors;
}

/**
 * A/E passes can be re-evaluations of jobs already in Inbox. Callers must pass
 * only A/E events whose immutable details.enteredInbox flag is true.
 */
export function enteredInboxCount(aePassAdmissions: number, userPromote: number): number {
  return aePassAdmissions + userPromote;
}

export function trackingCoverage(day: string, trackingSince: string | null): TrackingCoverage {
  if (!trackingSince) return 'untracked';
  const trackingDay = trackingSince.slice(0, 10);
  if (day < trackingDay) return 'untracked';
  if (day === trackingDay) return 'partial';
  return 'tracked';
}

export function safeRate(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 1_000) / 10;
}

export function numberFromDatabase(value: unknown): number {
  const parsed = typeof value === 'bigint' ? Number(value) : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
