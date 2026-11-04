import { Prisma } from './prismaClient';

// Compatibility for older workers only. New work stores a retry code separately
// from this diagnostic; existing segments and retry dates need no rewrite.
export const ATS_EMPLOYER_VERIFICATION_HOLD_REASONS = [
  'oracle downloaded work awaits a verified employer',
  'ukg downloaded work awaits a verified employer',
  'zohorecruit downloaded work awaits a verified employer',
  'successfactors downloaded work awaits a verified employer',
  'successfactors downloaded work awaits a verified posting location',
];

export function atsEmployerRetryCapacityJobs(lowWatermark: number, highWatermark: number): number {
  return Math.max(0, Math.min(100, Math.floor(Math.min(lowWatermark, highWatermark - 1) / 4)));
}

function configuredWatermark(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (!value?.trim() || !/^[+-]?\d+$/.test(value.trim())) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
}

export const ATS_EMPLOYER_RETRY_CAPACITY_JOBS = atsEmployerRetryCapacityJobs(
  configuredWatermark(process.env.ATS_ACQUISITION_JOB_LOW_WATERMARK, 1_000, 0, 99_999),
  configuredWatermark(process.env.ATS_ACQUISITION_JOB_HIGH_WATERMARK, 2_000, 100, 100_000),
);
export const ATS_EMPLOYER_RETRY_INTERVAL_MS = 60_000;
export const ATS_EMPLOYER_RETRY_ORDINARY_TURNS = 4;

export const ATS_EMPLOYER_RETRY_CODES = ['employer_unverified', 'location_unverified'];

export function isAtsEmployerVerificationHold(reason: string | null, retryCode?: string | null): boolean {
  if (retryCode != null) return ATS_EMPLOYER_RETRY_CODES.includes(retryCode);
  return reason !== null && ATS_EMPLOYER_VERIFICATION_HOLD_REASONS.includes(reason);
}

export function atsEmployerVerificationHoldWhere(recovery = true): Prisma.AtsIngestionSegmentWhereInput {
  return recovery ? { OR: [
    { retryCode: { in: ATS_EMPLOYER_RETRY_CODES } },
    { retryCode: null, holdReason: { in: ATS_EMPLOYER_VERIFICATION_HOLD_REASONS } },
  ] } : { OR: [
    { retryCode: { not: null, notIn: ATS_EMPLOYER_RETRY_CODES } },
    { retryCode: null, OR: [{ holdReason: null }, { holdReason: { notIn: ATS_EMPLOYER_VERIFICATION_HOLD_REASONS } }] },
  ] };
}

export function atsEmployerVerificationHoldSql(): Prisma.Sql {
  return Prisma.sql`(COALESCE(segment."retryCode", '') IN (${Prisma.join(ATS_EMPLOYER_RETRY_CODES)})
    OR (segment."retryCode" IS NULL AND COALESCE(segment."holdReason", '') IN (${Prisma.join(ATS_EMPLOYER_VERIFICATION_HOLD_REASONS)})))`;
}

export type AtsEmployerRetryMode = 'prefer' | 'fallback' | 'exclude';

/** The pipeline owns one consumer pool. Recovery gets at most one claim per
 * minute, with four ordinary claims between retries whenever work is waiting.
 * Idle capacity can still retry without waiting for four nonexistent claims.
 * A restart starts a fresh allowance; durable segment retry dates still apply.
 */
export function createAtsEmployerRetryClaimer<T extends { employerVerificationRetry?: boolean }>(
  claim: (now: Date, mode: AtsEmployerRetryMode) => Promise<T | null>,
  clock: () => Date = () => new Date(),
): () => Promise<T | null> {
  let nextRetryAt = 0;
  let ordinaryClaims = ATS_EMPLOYER_RETRY_ORDINARY_TURNS;
  return async () => {
    const now = clock();
    const mode = now.getTime() < nextRetryAt ? 'exclude'
      : ordinaryClaims >= ATS_EMPLOYER_RETRY_ORDINARY_TURNS ? 'prefer' : 'fallback';
    const result = await claim(now, mode);
    if (result?.employerVerificationRetry) {
      nextRetryAt = clock().getTime() + ATS_EMPLOYER_RETRY_INTERVAL_MS;
      ordinaryClaims = 0;
    } else if (result) {
      ordinaryClaims = Math.min(ATS_EMPLOYER_RETRY_ORDINARY_TURNS, ordinaryClaims + 1);
    }
    return result;
  };
}
