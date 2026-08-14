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
