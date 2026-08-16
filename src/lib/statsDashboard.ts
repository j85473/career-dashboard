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

/**
 * A rate small enough to round to 0.0% is still not zero, and rendering it as
 * "0%" reads as "nothing happened" when the truth is "a little happened out of
 * a very large denominator". Sub-0.05% rates keep three decimals.
 */
export function preciseRate(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  const rate = (numerator / denominator) * 100;
  if (rate === 0) return 0;
  if (rate < 0.05) return Math.round(rate * 1_000) / 1_000;
  return Math.round(rate * 10) / 10;
}

/**
 * Why a metric has no number behind it. Rendering these as 0 is what made the
 * dashboard untrustworthy: a broken emitter and a genuine zero looked
 * identical.
 */
export type MetricUnavailableReason =
  | 'not_instrumented'
  | 'no_matching_evaluations'
  | 'no_data_in_window'
  | 'not_captured';

export const METRIC_UNAVAILABLE_COPY: Record<MetricUnavailableReason, string> = {
  not_instrumented: 'not instrumented',
  no_matching_evaluations: 'no matching evaluations',
  no_data_in_window: 'no data in window',
  not_captured: 'not captured by current scoring',
};

export interface MetricValue {
  value: number | null;
  unavailable: MetricUnavailableReason | null;
}

export function known(value: number | null | undefined): MetricValue {
  return typeof value === 'number' && Number.isFinite(value)
    ? { value, unavailable: null }
    : { value: null, unavailable: 'no_data_in_window' };
}

export function unavailable(reason: MetricUnavailableReason): MetricValue {
  return { value: null, unavailable: reason };
}

/**
 * A stage that has never recorded a single event over the whole tracking
 * window is not reporting zero — nothing is writing it. Deriving this from the
 * data rather than a hardcoded list means the metric heals itself the moment an
 * emitter is added.
 */
export function stageMetric(windowCount: number, lifetimeCount: number): MetricValue {
  if (lifetimeCount === 0) return unavailable('not_instrumented');
  return known(windowCount);
}

export function numberFromDatabase(value: unknown): number {
  const parsed = typeof value === 'bigint' ? Number(value) : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export type TaskAvailabilityCategory = 'running' | 'runnableNow' | 'scheduled'
  | 'circuitCooldown' | 'budgetBlocked' | 'failedAwaitingRetry'
  | 'staleLease' | 'retired' | 'orchestration';

export function classifyTaskAvailability(input: {
  taskKind: string;
  lifecycleStatus: string;
  status: string;
  nextRunAt: Date;
  leaseToken?: string | null;
  leaseExpiresAt?: Date | null;
  circuit?: {
    state: string;
    openUntil?: Date | null;
    dailyLimit?: number | null;
    monthlyLimit?: number | null;
    dailyUsed: number;
    monthlyUsed: number;
    budgetDay?: string | null;
    budgetMonth?: string | null;
  } | null;
  now: Date;
}): TaskAvailabilityCategory {
  if (input.taskKind === 'orchestration') return 'orchestration';
  if (input.lifecycleStatus === 'retired') return 'retired';
  if (input.status === 'running' && (
    !input.leaseToken || !input.leaseExpiresAt || input.leaseExpiresAt <= input.now
  )) return 'staleLease';
  if (input.status === 'running') return 'running';
  const circuit = input.circuit;
  if (circuit?.state === 'open' && circuit.openUntil && circuit.openUntil > input.now) return 'circuitCooldown';
  const day = input.now.toISOString().slice(0, 10);
  const month = day.slice(0, 7);
  if (circuit?.dailyLimit != null && circuit.budgetDay === day && circuit.dailyUsed >= circuit.dailyLimit) return 'budgetBlocked';
  if (circuit?.monthlyLimit != null && circuit.budgetMonth === month && circuit.monthlyUsed >= circuit.monthlyLimit) return 'budgetBlocked';
  if (input.status === 'failed' && input.nextRunAt > input.now) return 'failedAwaitingRetry';
  if (input.nextRunAt <= input.now && (!input.leaseToken || input.leaseExpiresAt! <= input.now)) return 'runnableNow';
  return 'scheduled';
}

export function taskAvailabilityReconciles(counts: Record<TaskAvailabilityCategory, number>, activeSearchTasks: number): boolean {
  return counts.running + counts.runnableNow + counts.scheduled + counts.circuitCooldown
    + counts.budgetBlocked + counts.failedAwaitingRetry + counts.staleLease === activeSearchTasks;
}
