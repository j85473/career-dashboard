# Stop spending 7½ minutes backing up for a migration that isn't running

## The measurement

First instrumented deploy (2026-08-19), inside `Run Deployment Script` (747s):

```
441s  db-backup                 <- 59%
169s  next-build
 95s  remote-npm-ci             (full npm ci; the reuse path had no marker yet)
 17s  quiescence-wait-normal
 14s  prisma-generate
 12s  activate-release
  9s  prisma-migrate-deploy     <- because there is usually nothing to migrate
  2s  rsync
  2s  pipeline-stop-request
```

Runner steps total 77s. The backup alone is over half the deploy.

## Why this is the wrong shape

`scripts/deploy.sh` (~line 455) runs
`scripts/deployment/backup-postgres.mjs` unconditionally, before
`prisma migrate deploy`. Its stated purpose is a **pre-migration** safety net —
the failure messages all read "Backup: $DB_BACKUP_PATH" next to migration
advice. But `prisma migrate deploy` finishes in 9s because dev and prod share
one database, so migrations are almost always already applied and the deploy
has nothing to run. A code-only deploy cannot corrupt data, and we are paying
441s to insure against it.

## Task 1 — only back up when a migration will actually run

Before the backup phase, determine whether there is a pending migration.
`prisma migrate status` is the obvious source; `check-expand-only.mjs` already
reads `prisma/migrations`, so compare that against the `_prisma_migrations`
table if status output is awkward to parse reliably.

- **Pending migration → back up exactly as today.** Do not weaken this path.
- **No pending migration → skip the dump**, and say so explicitly in the log
  ("no pending migrations; skipping the pre-migration backup"). Silence would
  read as a backup having happened.
- **Cannot determine → back up.** Fail closed. An ambiguous status must never
  skip the dump.
- Record a `db-backup-skipped` phase so the timing table still accounts for it.

## Task 2 — do not lose routine backups as a side effect

Today every deploy produces a dump, so deploys are doubling as Joseph's routine
backup. Gating on migrations removes that, and `DB_BACKUP_RETENTION=7` would
then hold seven backups of unpredictable age.

Add a scheduled daily `pg_dump` on the Pi, independent of deploys, writing to
the same `$DB_BACKUP_DIR` with the same retention. There is already crontab
installation machinery: `scripts/deployment/install-crontab-remote.sh`. Reuse
it rather than inventing a second scheduling mechanism, and make sure the two
do not collide on filenames.

## Task 3 — make the dump itself cheaper (do this after 1 and 2)

`backup-postgres.mjs` uses `pg_dump --format=custom`, whose default compression
is gzip level 6 — CPU-bound, on a Pi that is also running Homebridge and a NAS
bridge, against a `Job` table of ~378,000 rows with long `description` text.

Measure before changing (`ls -lh` the existing dumps, and time a manual run),
then consider:

- `--compress=1` — far less CPU for a modestly larger file.
- Directory format with `--jobs=N` for a parallel dump, if the Pi has the cores
  free. Note this changes the on-disk shape, so restore instructions and the
  retention/pruning glob both have to change with it.

Do not change the format without also updating the pruning logic in
`deploy.sh` (~line 462, globbing `career-dashboard-*.dump`) and any restore
documentation.

## What is now lower priority

Shipping a prebuilt Next.js artifact from an `ubuntu-24.04-arm` runner targets
`next-build` (169s) plus `remote-npm-ci` (95s). Still worth doing eventually,
but it is second — and `remote-npm-ci` should already drop on the next deploy,
because the lockfile-hash reuse path now has a marker to match against. Check
the next run's number before assuming that work is needed at all.

It also still blocks on the Node mismatch: the Pi runs **Node v20.20.2**, CI
runs **Node 22**.

## Constraints

- `scripts/deploy.sh` and `.github/workflows/deploy.yml` are read by
  `deploymentCron.test.ts`, `rapidApiKeySync.test.ts` and
  `ingestionControl.test.ts` — source-text contract tests that match literal
  strings.
- Gates: `npm test` (baseline **603 pass, 0 fail**), `npm run build`, and
  `bash -n scripts/deploy.sh`.
- `git commit -am` does not stage new files. Use `git add -A`.
- **Do not `git push`**, run `ssh`, or run `scripts/deploy.sh`. Joseph pushes.
- Prod is a Raspberry Pi sharing this database with dev; it also runs Homebridge
  and a NAS bridge. SSH user is `j85473`, not `pi`.

## Definition of done

- Backup runs only when a migration is pending, fails closed on doubt, and logs
  the skip explicitly.
- A scheduled daily backup exists independent of deploys.
- `npm test` ≥603 green, `npm run build` green, `bash -n` clean.
- Commit local, not pushed, with a note on the expected new timing table.
