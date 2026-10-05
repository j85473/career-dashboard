/** A source still works when its recent clean checks find only known listings. */
export function hasCleanDuplicateOnlyActivity(input: {
  recentRuns: number;
  recentSeenCount: number;
  recentDuplicateCount: number;
  recentFailedRuns: number;
  recentRequestErrors: number;
  recentProcessingErrors: number;
  recentUnreconciledRuns: number;
}): boolean {
  return input.recentRuns > 0
    && input.recentSeenCount > 0
    && input.recentDuplicateCount === input.recentSeenCount
    && input.recentFailedRuns === 0
    && input.recentRequestErrors === 0
    && input.recentProcessingErrors === 0
    && input.recentUnreconciledRuns === 0;
}

/** Retired collection history remains visible without pretending it is live. */
export function sourceCollectionHandoff(input: {
  source: string;
  hasActiveTask: boolean;
  lastRunAt: string | null;
  replacementFirstRunAt: string | null;
}): { verdict: 'historical'; reason: string } | null {
  if (input.source !== 'ATS-gusto' || input.hasActiveTask || !input.lastRunAt || !input.replacementFirstRunAt) return null;
  const lastRun = Date.parse(input.lastRunAt);
  const replacementStart = Date.parse(input.replacementFirstRunAt);
  if (!Number.isFinite(lastRun) || !Number.isFinite(replacementStart) || lastRun >= replacementStart) return null;
  return {
    verdict: 'historical',
    reason: 'Previous Gusto collection history. Current browser collection and its errors are reported under Gusto.',
  };
}
