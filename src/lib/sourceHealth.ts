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
