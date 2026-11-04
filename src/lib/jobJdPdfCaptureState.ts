export type JobJdPdfCapture = {
  attemptId: string;
  status: 'queued' | 'capturing' | 'ready' | 'failed';
  sourceUrl: string | null;
  requestedAt: string;
  error?: string;
  attachmentId?: string;
};

export function effectiveJdCaptureUrl(job: {
  userCanonicalUrl?: string | null; canonicalUrl?: string | null; url?: string | null;
}): string | null {
  return job.userCanonicalUrl?.trim() || job.canonicalUrl?.trim() || job.url?.trim() || null;
}

export function readJdPdfCapture(value: unknown, now = Date.now()): JobJdPdfCapture | null {
  if (!value || typeof value !== 'object') return null;
  const capture = value as JobJdPdfCapture;
  if (typeof capture.attemptId !== 'string' || typeof capture.requestedAt !== 'string'
    || !Number.isFinite(Date.parse(capture.requestedAt))
    || !['queued', 'capturing', 'ready', 'failed'].includes(capture.status)
    || (capture.sourceUrl !== null && typeof capture.sourceUrl !== 'string')) return null;
  if (['queued', 'capturing'].includes(capture.status) && now - Date.parse(capture.requestedAt) > 120_000) {
    return { ...capture, status: 'failed', error: 'PDF capture was interrupted. Try again.' };
  }
  return capture;
}
