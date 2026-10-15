# Prisma 7 upgrade rehearsal

This branch upgrades the Dashboard's database client and CLI to Prisma 7.10.0.
It follows the separate routine dependency update commit `a5709ad`. It does not
activate a production release or change the scoring/lifecycle rules.

## Application changes

- Generate the client into `src/generated/prisma` using the supported CommonJS
  module format, retaining the existing Next.js/tsx and maintenance-script setup.
- Import database types and clients through `src/lib/prismaClient.ts`. That
  boundary supplies the PostgreSQL adapter to app, worker, and maintenance clients.
- Retain the five-connection data pool, two-connection control pool, ten/five
  second queue deadlines, and independent five-second connect deadlines. Worker
  URLs with explicit pool settings retain those settings at the adapter boundary.
- Move schema location, migration paths, environment loading, and the database
  URL into `prisma.config.ts`. Explicit service/command environment wins over
  dotenv files. Generation uses an unreachable fallback when no URL is supplied.
- Keep all model definitions and recorded SQL migrations unchanged. Installed
  PostgreSQL extensions remain in the database; Prisma 7 no longer declares them
  in the datasource block. Empty test databases explicitly provision their needed
  extensions before creating tables.
- Preserve transaction retry behavior when raw SQL reports a serialization
  failure or deadlock through Prisma 7's driver-adapter error metadata.
- Classify database connection/pool failures as internal persistence errors so
  they cannot be counted against an external provider's circuit.
- Pin the PostgreSQL adapter alongside CLI/client versions. Scoped overrides
  patch the CLI's vulnerable DeepmergeTS and MySQL2 dependencies while preserving
  the existing local braces security fix.

Existing scores remain authoritative. No score clearing, invalidation,
reconciliation, requeue, or rescore is part of this upgrade.

## Private database copy

The October 15 rehearsal uses a separate PostgreSQL 17 instance on the M70,
bound only to loopback port **55433**. Its private cluster storage is
`/var/lib/postgresql/career-prisma7-physical-20261015`, outside production
database and backup directories. The Mac reaches the copy over a separate SSH
forward. It has no pipeline worker or scheduler attached.

Its copied transaction log uses the separate private directory
`/mnt/nvme/career-prisma7-wal-20261015/pg_wal`, reached through the cluster's
`pg_wal` symlink. This keeps transaction-log I/O separate from data-file I/O.
The rehearsal uses a 4 GB shared cache within an 8 GB service
memory ceiling; production's cache and service limits remain unchanged.

The copy contains approximately 120 GB of data files plus its transaction log,
including the older rehearsal database.
It is copied with PostgreSQL 17's physical backup protocol and WAL streaming.
`wal_sender_timeout=0` applies only to the backup connections: production's global
one-minute setting stays unchanged. CPU, memory, and transfer rate are bounded.
Abandoned partial restores were removed. Joseph authorized clearing old SSD
backups to make room for the rehearsal: the two older predeployment snapshots
from October 12 at 21:15 UTC and October 14 at 15:36 UTC were removed, reclaiming
53,986,996,008 bytes (50.3 GiB).
The latest nightly dump and file archive pass their SHA-256 manifest, and the
newest predeployment dump has a readable archive catalog. All three nightly sets
on both backup destinations and the newest predeployment snapshot are retained.

The final backup is streamed directly from production's NVMe storage to the
cleared OS SSD. Before recovery, `pg_verifybackup` checks the manifest, every file
checksum, and required WAL. Full saved-Job value fingerprints and old/new client
comparisons are separate acceptance checks after recovery. Production's locale,
time zone, and formatting settings are retained in the rehearsal configuration.

The full copied database is renamed `career_prisma7` and uses a distinct
`career_prisma7` login. Its password is kept only in private files, including the
ignored, mode-0600 `.env.prisma7` file in the upgrade worktree. Do not copy the
production `.env` files into this worktree.

Start the private forward if needed:

```sh
ssh -N -o ExitOnForwardFailure=yes \
  -L 127.0.0.1:55433:127.0.0.1:55433 m70
```

Run commands through the rehearsal wrapper, which checks the loopback address,
port, database name, and role before launching a Prisma CLI/client command:

```sh
node scripts/prisma7-rehearsal.mjs npx --no-install prisma migrate status
node scripts/prisma7-rehearsal.mjs npx --no-install prisma migrate deploy
node scripts/prisma7-rehearsal.mjs node --import tsx tests/integration/prisma7Rehearsal.ts
```

Set `PRISMA7_REHEARSAL_REPORT` to a private output file to retain the complete
preservation report. The integration harness hashes every saved column in jobs,
score events, and job status history using SHA-256, then compares
order-independent XOR/sum aggregates for all four digest lanes, together with row
and score counts. A parallel sequential scan
avoids random UUID heap reads. It removes only its own uniquely named board and
batch fixtures.

If the private instance is stopped, restart it on the M70 with its retained
configuration before opening the SSH forward:

```sh
sudo systemd-run --unit=career-dashboard-prisma7-copydb-20261015 \
  --uid=postgres --property=Nice=15 --property=CPUQuota=200% \
  --property=MemoryMax=8G /usr/lib/postgresql/17/bin/postgres \
  -D /var/lib/postgresql/career-prisma7-physical-20261015 \
  -c config_file=/media/nas/career-dashboard-prisma7-20261015/physical-postgresql.conf
```

## Validation and limits

Routine update validation: 2,182 tests passed, 10 skipped, production build passed,
lint passed with three pre-existing warnings, browser wrappers launched and read
local HTML through installed Chrome, and npm audit reported zero vulnerabilities.
The licensed CloakBrowser binary and live provider collection were not exercised.

Prisma branch validation: 2,187 unit tests passed, 10 skipped, production build
passed, lint passed with the same three pre-existing warnings, schema validation
passed, and npm audit reported zero vulnerabilities. A separate clean Linux
install, Prisma generation, and Next production build also passed on the M70's
Node 24.20.0 runtime, in a private test directory. Database checks include
scoped dependency resolution/audit, real PostgreSQL scoring imports (including
concurrent identical/divergent imports and rollback), scheduler migration and
provider budget reservation tests, and ten ATS SQL fixtures in UTC and Chicago time.

Full production-copy acceptance passed on October 15, 2026:

- All 2,830 backup files and the required WAL passed `pg_verifybackup` before
  isolated recovery. The copy retains the source's PostgreSQL 17.11, `en_GB.UTF-8`
  locale, collation version 2.39, Chicago time zone, and ISO/MDY date format.
- Prisma 7 recognizes all 50 recorded migrations. Migration status is up to
  date and `migrate deploy` reports no pending migrations. No model definition
  or recorded migration SQL was changed.
- Prisma 5.22 and 7.10 return identical values for 3,400 sampled record reads,
  including full jobs, scores, histories, acquisition items, and receipts.
  Session time zone and date format also match.
- Unique-key errors, 20 concurrent atomic updates, BigInt increments above
  JavaScript integer precision, JSON/dates, rollback, Serializable conflicts,
  bounded queue timeouts, and independent control access all pass. A real pool
  timeout is recognized as a database failure, preserving provider-circuit rules.
- Every saved column in **3,222,596 jobs**, **58,541 score events**, and
  **4,634,178 job status-history records** has an unchanged fingerprint after
  the test writes. Score counts remain **15,360 Aim**, **10,161 Experience**, and
  **225,850 legacy**. Status history includes pipeline and application transitions.
- The separate Linux production app passes health/schema/migration checks and
  returns Inbox and Applied jobs. Chrome renders 48 job cards and existing scores
  with no page errors, failed API responses, or password inputs.

The sanitized counts, fingerprints, client comparisons, and runtime results are
recorded in [the validation evidence](validation/2026-10-15-prisma7-rehearsal.json).
Redundant NAS copy attempts and the duplicate staging dump were removed after
acceptance. The private app and database are stopped; the verified database and
its configuration are retained for another rehearsal. The temporary Linux app
build is removed. Restart the private database and SSH forward using the commands
above before running the wrapper again.

Replaying the recorded migration chain into an empty database currently fails at
`20260808190000_pipeline_lock_shared`: it alters `PipelineState`, which an older
baseline never creates. This predates the Prisma upgrade. Do not edit an applied
migration or use a reset to conceal the gap. A clean-install baseline repair is
separate work. The existing-database upgrade passed against the copied
production history. The historical scoring verifier now requires separately
provisioned empty `career_dashboard_scoring_v2_verify` and
`career_dashboard_scoring_v2_upgrade_verify` fixture databases and never resets
existing contents.

The initial rehearsal ended before either branch was pushed or deployed.
Production Node.js remains on the 24 LTS line. TypeScript, ESLint, and dotenv
major upgrades remain separate work.

## Combined-release Stats acceptance

The first combined release passed health but automatically rolled back when its
cold Stats warm-up exceeded the five-second default transaction limit. No schema
migration was pending, and recovery restored the previous app and workers.
The full-history Stats queries now use an explicit read-only transaction with
the same 90-second budget as the basic snapshot, retaining one connection and
the existing query order.

After rebuilding the combined app, the complete copied database's cold Stats
request passed in **34,800 ms**, followed by an identical cached response in
**10 ms**. The response covered all **3,222,596 jobs**. This check is repeatable
after starting a fresh private app on port 3107:

```sh
node scripts/prisma7-rehearsal.mjs node --import tsx tests/integration/prisma7StatsSnapshot.ts
```

The combined candidate again passed 2,219 unit tests with 10 skipped and zero
failures, the production build, and focused lint. Deployment completion remains
separate from rehearsal; verify the workflow and active M70 release.
