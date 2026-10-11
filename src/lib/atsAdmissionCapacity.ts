import { Prisma } from '@prisma/client';

/** Retained failed downloads still count toward volume, but reserve a listing
 * slot only while a worker is serving them. Successful due traversals reserve
 * a slot between quanta so concurrent admissions cannot overfill the allowance.
 */
export function atsListingAdmissionReservationSql(now: Date): Prisma.Sql {
  return Prisma.sql`batch."acquisitionPhase" = 'listing'
    AND ((batch."rawObservationCount" > 0 AND batch."lastError" IS NULL
      AND (batch."nextAcquireAt" IS NULL
        OR batch."nextAcquireAt" <= (${now}::timestamptz AT TIME ZONE 'UTC')))
      OR (batch."acquisitionClaimToken" IS NOT NULL
        AND batch."acquisitionLeaseExpiresAt" > (${now}::timestamptz AT TIME ZONE 'UTC')))`;
}

/** Processing always consumes capacity; published work does when its retry is
 * due. Explicit UTC conversion matches the timezone-less retry columns even
 * when PostgreSQL's session timezone is America/Chicago.
 */
export function atsRunnableSegmentSql(now: Date): Prisma.Sql {
  return Prisma.sql`segment.status = 'processing'
    OR (segment.status = 'published'
      AND (segment."nextProcessAt" IS NULL
        OR segment."nextProcessAt" <= (${now}::timestamptz AT TIME ZONE 'UTC')))`;
}

export function atsRunnableLegacyBatchSql(now: Date): Prisma.Sql {
  return Prisma.sql`batch."writerMode" = 'legacy'
    AND (batch.status = 'processing' OR (batch.status = 'queued'
      AND (batch."nextProcessAt" IS NULL
        OR batch."nextProcessAt" <= (${now}::timestamptz AT TIME ZONE 'UTC'))))`;
}
