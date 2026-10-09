export const ATS_ZERO_PROGRESS_PROCESSING_BACKOFF_MS = 60_000;

/** Keep a provider/employer hold even when an interrupted turn committed a prefix. */
export function nextAtsProcessingContinuationAt(input: {
  now: Date;
  interrupted?: boolean;
  cursorAdvanced: boolean;
  retryAt?: Date | null;
}): Date {
  const ordinaryRetry = input.now.getTime() + (
    input.interrupted && !input.cursorAdvanced
      ? ATS_ZERO_PROGRESS_PROCESSING_BACKOFF_MS
      : 0
  );
  const deferredRetry = input.interrupted ? input.retryAt?.getTime() : undefined;
  return new Date(Math.max(ordinaryRetry,
    deferredRetry != null && Number.isFinite(deferredRetry) ? deferredRetry : 0));
}
