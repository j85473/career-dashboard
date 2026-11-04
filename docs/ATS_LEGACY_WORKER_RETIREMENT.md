# Retiring the legacy API acquisition worker

The M70 already runs the v2 acquisition dispatcher. Retiring the older API loop
records that boundary durably, prevents an older binary from admitting legacy
work, and routes newly discovered API boards directly to v2. It does not stop
ADP, Gusto, or the other separately owned public HTTP/browser collectors. Their
board ownership can still say `legacy`; that label does not mean the old API
worker is acquiring them.

Installing `20261104210000_ats_legacy_worker_retirement` leaves retirement
inactive. No board, saved payload, retry date, job, score, operator pause, or
worker setting changes during the migration. Existing legacy payload readers
and the explicit conversion tool remain available for retained evidence.

## Release and retirement order

1. Deploy the reviewed release through **Deploy to M70**. This release includes
   additive migrations, so allow the existing workflow to take its required
   recovery point before changing the schema. Recheck backup capacity at release
   time; do not bypass the backup or quiescence checks.
2. Verify the active release, HTTP health, and acquisition worker leases. The
   retirement check requires a live v2 worker on that exact release and refuses
   mixed-release capacity leases.
3. Run the read-only retirement preview on M70:

   ```bash
   sudo -n -u career-dashboard bash -c '
     cd /opt/career-dashboard
     ATS_WORKER_RELEASE_ID="$(cat .release-id)" node scripts/with-env.mjs \
       node --import tsx scripts/retire_legacy_ats_worker.ts
   '
   ```

4. Once retirement is authorized and the preview reports `ready: true`, rerun
   the same command with `--apply <selectionHash>` appended. The application
   rechecks current state while holding the admission gate lock; the database
   also enforces the boundary against old binaries and direct SQL writers.
5. Run the preview again and verify the retirement timestamp and release.
   Verify subsequent API discoveries have v2 ownership, new sweeps produce v2
   receipts, and the separate public collectors retain their normal services.
   Check Oracle/UKG publication and persistence rates after the new one-posting
   handoffs begin; do not equate service health with throughput acceptance.

The check refuses unfinished legacy batches, unprocessed retained payloads,
running attempts, live legacy batch leases, and incomplete conversions. A held
retry remains unfinished even when its next attempt is in the future. Existing
explicitly excluded or abandoned work remains retained and excluded. Retirement
does not drain, close, convert, release, or discard anything to manufacture a
clean result. If blocked, finish or separately review conversion of that exact
work, then preview again. The existing v2 backlog does not need to empty.

## Interruption and rollback

Retirement has one atomic checkpoint. An interrupted operation either leaves
the gate unchanged or commits the retirement timestamp and release together.
Repeating a completed operation reports no change. A failed preview or stale
selection hash performs no writes.

After retirement, compatible workers do not start the old loop. An already
running loop exits at its next turn, and database guards reject new legacy
attempts, batches, or resumed claims. New API board inserts get v2 ownership
without changing their first-collection reservations, eligibility, or dates.
Existing boards retain their records and normal promotion rules.

An application rollback preserves retirement and the newer database. A release
with working v2 support can continue; a configuration with v2 disabled must
fail closed rather than resume legacy acquisition. Repair the v2 deployment or
configuration if necessary. Do not clear the retirement marker or restore an
older database over current jobs.

## Verification

Unit tests cover readiness, changed selections, startup behavior, and parity
between the database and application lists of separate collectors. The isolated
PostgreSQL fixture `tests/integration/atsLegacyRetirement.ts` verifies dormant
migration installation, held-work refusal, admission races, release mismatches,
idempotence, old-binary fences, new-board routing, public-collector continuity,
timezone handling, and preservation of scores and saved payloads. It runs only
against an empty schema-only copy on the fixture host, port, user, and database
encoded in its guard.
