/** Retry decisions are data. Diagnostic wording is never scheduling authority. */
export const ATS_RETRY_CODES = [
  'employer_unverified', 'location_unverified', 'posting_mismatch', 'posting_unavailable',
  'provider_rate_limit', 'provider_unavailable', 'network_failure', 'operation_interrupted', 'internal_error',
] as const;
export type AtsRetryCode = typeof ATS_RETRY_CODES[number];
export type AtsRetryScope = 'posting' | 'board' | 'provider';
export type AtsRetryReason = { code: AtsRetryCode; scope: AtsRetryScope };

export function withAtsRetryReason<T extends Error>(error: T, retryReason: AtsRetryReason): T & { retryReason: AtsRetryReason } {
  return Object.assign(error, { retryReason });
}

export function readAtsRetryReason(error: unknown): AtsRetryReason | null {
  if (!error || typeof error !== 'object' || !('retryReason' in error)) return null;
  const reason = error.retryReason;
  if (!reason || typeof reason !== 'object' || !('code' in reason) || !('scope' in reason)) return null;
  return ATS_RETRY_CODES.includes(reason.code as AtsRetryCode) && ['posting', 'board', 'provider'].includes(String(reason.scope))
    ? { code: reason.code as AtsRetryCode, scope: reason.scope as AtsRetryScope } : null;
}

export function atsRetryColumns(reason: AtsRetryReason | null) {
  return { retryCode: reason?.code || null, retryScope: reason?.scope || null };
}
