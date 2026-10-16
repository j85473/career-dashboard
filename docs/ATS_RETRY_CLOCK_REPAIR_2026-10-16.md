# ATS retry clock and idle enrichment repair

## Production failure

On October 16, the publication gate counted 5,656 Oracle/UKG items as runnable
even though all were waiting for future employer-verification retries. That
exceeded the 2,000-item allowance and blocked 44,683 sealed items from entering
processing. Staged volume also prevented new-board admission.

A read-only production reproduction at 16:04 UTC showed a JavaScript Date
parameter arriving as `2026-10-16 16:04:17.962`, without its UTC offset.
Casting that parameter to `timestamptz` in the Chicago database session yielded
21:04 UTC. Prisma 7's PostgreSQL adapter formats Date parameters without an
offset; the explicit cast therefore interpreted a UTC clock as local time.

Separately, 48 SuccessFactors batches repeatedly took empty enrichment turns
while their details were retry-held or the provider circuit was open. A recent
half-hour window contained 1,427 enrichment turns without item progress or
detail requests.

## Changed behavior

- Bind ISO strings containing the UTC offset wherever acquisition capacity,
  first-collection accounting, or queue telemetry casts a supplied clock to
  `timestamptz`. Preserve the database's Chicago session and existing stored
  timestamps.
- After an empty enrichment turn, wait for the earliest pending detail retry
  and any applicable provider cooldown, retaining the existing one-minute
  minimum. Productive turns remain immediately eligible. Local classification
  and completed details do not inherit a network cooldown.
- Retain every payload, retry-held item, segment, receipt, and existing score.
  The normal publisher recomputes capacity and resumes without an operator
  reset, forced rescore, or database migration.

## Validation

The admission-capacity integration fixture can now run through the actual
Prisma adapter on the isolated production copy using the existing rehearsal
wrapper. Previously it rendered Date parameters into ISO SQL literals before
sending SQL to PostgreSQL, which bypassed the failing serialization boundary.

All ten parameter-bound fixtures pass in UTC and America/Chicago sessions.
They cover retained failed downloads, live listing reservations, due versus
held persistence, legacy holds, and retry eligibility at the due boundary.
Unit tests cover cooldown expiry, the earliest detail retry, immediate local
classification, and sealing without pending details. The complete unit suite,
production build, and scoped lint are release gates. Deployment additionally
requires live publication/persistence progress and unchanged score/application
fingerprints.
