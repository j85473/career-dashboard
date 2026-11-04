import { Prisma } from './prismaClient';
import { ATS_EMPLOYER_RETRY_CAPACITY_JOBS, atsEmployerVerificationHoldSql } from './atsEmployerRetry';

// Prisma 7's pg adapter removes the offset from Date parameters. Bind an ISO
// string when SQL needs an instant so Chicago sessions cannot add five hours.

/** Retained failed downloads still count toward volume, but reserve a listing
 * slot only while a worker is serving them. Successful due traversals reserve
 * a slot between quanta so concurrent admissions cannot overfill the allowance.
 */
export function atsListingAdmissionReservationSql(now: Date | Prisma.Sql): Prisma.Sql {
  const nowUtc = now instanceof Date ? Prisma.sql`(${now.toISOString()}::timestamptz AT TIME ZONE 'UTC')` : now;
  return Prisma.sql`batch."acquisitionPhase" = 'listing'
    AND ((batch."rawObservationCount" > 0 AND batch."lastError" IS NULL
      AND (batch."nextAcquireAt" IS NULL
        OR batch."nextAcquireAt" <= ${nowUtc}))
      OR (batch."acquisitionClaimToken" IS NOT NULL
        AND batch."acquisitionLeaseExpiresAt" > ${nowUtc}))`;
}

/** Processing always consumes capacity; published work does when its retry is
 * due. Explicit UTC conversion matches the timezone-less retry columns even
 * when PostgreSQL's session timezone is America/Chicago.
 */
export function atsRunnableSegmentSql(now: Date): Prisma.Sql {
  return Prisma.sql`segment.status = 'processing'
    OR (segment.status = 'published'
      AND (segment."nextProcessAt" IS NULL
        OR segment."nextProcessAt" <= (${now.toISOString()}::timestamptz AT TIME ZONE 'UTC')))`;
}

/** Every in-flight segment and ordinary due item consumes its full allowance.
 * Known employer-evidence retries share a bounded reservation, even when many
 * hourly holds expire together. All items remain runnable and visible in the
 * total backlog; this changes only the capacity reserved for recovery work.
 */
export function atsSegmentPersistenceCapacitySql(now: Date): Prisma.Sql {
  const recovery = Prisma.sql`(segment.status = 'published' AND ${atsEmployerVerificationHoldSql()})`;
  return Prisma.sql`SELECT
    COALESCE(SUM(GREATEST(segment."itemCount" - segment."processingOffset", 0))
      FILTER (WHERE NOT ${recovery}), 0)
    + LEAST(COALESCE(SUM(GREATEST(segment."itemCount" - segment."processingOffset", 0))
      FILTER (WHERE ${recovery}), 0), ${ATS_EMPLOYER_RETRY_CAPACITY_JOBS}) AS remaining
    FROM "AtsIngestionSegment" segment WHERE ${atsRunnableSegmentSql(now)}`;
}

export function atsRunnableLegacyBatchSql(now: Date): Prisma.Sql {
  return Prisma.sql`batch."writerMode" = 'legacy'
    AND (batch.status = 'processing' OR (batch.status = 'queued'
      AND (batch."nextProcessAt" IS NULL
        OR batch."nextProcessAt" <= (${now.toISOString()}::timestamptz AT TIME ZONE 'UTC'))))`;
}
