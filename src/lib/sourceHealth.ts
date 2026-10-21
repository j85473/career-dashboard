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

/** Current collection evidence, independent of how long ago a new job landed. */
export function collectionHealth(input: {
  recentRuns: number;
  recentSeenCount: number;
  recentInsertedCount: number;
  recentDuplicateCount: number;
  recentFilteredCount: number;
  recentFailedRuns: number;
  recentRequestErrors: number;
  recentProcessingErrors: number;
  recentUnreconciledRuns: number;
}): { verdict: 'healthy' | 'failing' | 'degraded' | 'silent'; reason: string } {
  const n = (value: number) => value.toLocaleString();
  const errors = input.recentRequestErrors + input.recentProcessingErrors;
  if (errors || input.recentFailedRuns || input.recentUnreconciledRuns) {
    const details = [
      input.recentRequestErrors ? `${n(input.recentRequestErrors)} request errors` : '',
      input.recentProcessingErrors ? `${n(input.recentProcessingErrors)} processing errors` : '',
      input.recentFailedRuns ? `${n(input.recentFailedRuns)} failed runs` : '',
      input.recentUnreconciledRuns ? `${n(input.recentUnreconciledRuns)} unreconciled runs` : '',
    ].filter(Boolean).join(' · ');
    return {
      verdict: input.recentSeenCount === 0 || input.recentFailedRuns >= Math.max(1, input.recentRuns) ? 'failing' : 'degraded',
      reason: `Last 24h: ${details}; ${n(input.recentSeenCount)} listings checked, ${n(input.recentInsertedCount)} new jobs.`,
    };
  }
  if (!input.recentRuns) return { verdict: 'silent', reason: 'No collection checks recorded in the last 24h; current provider health is unmeasured.' };
  if (!input.recentSeenCount) return { verdict: 'silent', reason: `${n(input.recentRuns)} checks in the last 24h returned no listings, with no recorded request errors.` };
  if (input.recentSeenCount !== input.recentInsertedCount + input.recentDuplicateCount + input.recentFilteredCount) {
    return { verdict: 'degraded', reason: 'Recent listing outcomes do not reconcile; collection health needs review.' };
  }
  return { verdict: 'healthy', reason: `${n(input.recentSeenCount)} listings checked in the last 24h: ${n(input.recentInsertedCount)} new, ${n(input.recentDuplicateCount)} already stored, ${n(input.recentFilteredCount)} filtered; no recorded errors.` };
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
