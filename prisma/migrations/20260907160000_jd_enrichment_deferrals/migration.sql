-- A JD recovery pass that never reached the provider, because the shared
-- request budget refused the reservation, is not a failed attempt. Count those
-- separately so a denied call stops terminalizing jobs as dead postings, while
-- still being bounded.
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "jdDeferrals" INTEGER NOT NULL DEFAULT 0;

-- A deferral has to cost elapsed time, not a lap of the queue: with the
-- needs_jd queue empty, a bare counter would burn its whole budget in minutes
-- and terminalize jobs during a shortage that was about to clear.
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "jdDeferredUntil" TIMESTAMP(3);
