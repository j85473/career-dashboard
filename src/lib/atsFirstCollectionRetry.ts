const DAY = 86_400_000;

export function missingCareerResponse(reason?: string | null): '404' | '410' | null {
  const status = reason?.match(/^(?:Career page|Feed) HTTP (404|410)$/)?.[1];
  return status === '404' || status === '410' ? status : null;
}

/** Retain unavailable discoveries, but spend validation capacity on fresher leads. */
export function firstCollectionRetryAt(reason: string | null | undefined, previousReason: string | null, finishedAt: Date): Date {
  const missing = missingCareerResponse(reason);
  const longerHold = reason === 'Vendor service address, not an employer career board' || missing === '410'
    || Boolean(missing && missingCareerResponse(previousReason));
  const days = longerHold ? 30 : missing ? 7 : 1;
  return new Date(finishedAt.getTime() + days * DAY);
}

/** Upgrade only legacy one-day retries. Never shorten a hold or invent a new attempt. */
export function legacyMissingCareerRetryAt(candidate: {
  lastError: string | null; lastValidationStartedAt: Date | null; nextValidationAt: Date;
}): Date | null {
  if (!missingCareerResponse(candidate.lastError) || !candidate.lastValidationStartedAt) return null;
  const elapsed = candidate.nextValidationAt.getTime() - candidate.lastValidationStartedAt.getTime();
  if (elapsed < DAY || elapsed > DAY + 3 * 60_000) return null;
  // The existing retry records completion + one day, preserving the exact completion clock.
  const finishedAt = new Date(candidate.nextValidationAt.getTime() - DAY);
  return firstCollectionRetryAt(candidate.lastError, null, finishedAt);
}
