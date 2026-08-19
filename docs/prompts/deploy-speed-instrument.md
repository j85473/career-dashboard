# Make the Pi deploy fast — measure first, then cut the duplicated work

## The measurement we already have

One full deploy, per step, from `gh run view --json jobs`:

```
  1s  Set up job              20s  Install Dependencies
  1s  Checkout Code            1s  Generate Prisma Client
  5s  Setup Node.js           19s  Run Tests
  8s  Connect to Tailscale    20s  Build Next.js App
  1s  Add Pi to known_hosts
747s  Run Deployment Script      <- 91% of the total
```

Total ~824s. Everything on the GitHub runner is 77s. **The runner already builds
the app in 20 seconds and then throws the result away**, because
`scripts/deploy.sh` rsyncs source to the Pi and rebuilds there:

```bash
cd "$STAGE_DIR"
npm ci                                              # line ~347
node scripts/with-env.mjs "$PRISMA_BIN" generate    # line ~355
node scripts/with-env.mjs npm run build             # line ~356
```

## Task 1 — instrument, because we do not know the split

We know the Pi phase is 747s. We do **not** know how it divides between rsync,
`npm ci`, `prisma generate`, `npm run build`, the migration, the backup, and the
service restart. Those have completely different fixes, so do not optimise
before measuring.

Add elapsed-time reporting to `scripts/deploy.sh`:

- A helper that records a phase name and its duration (`SECONDS` is enough; do
  not add a dependency).
- Wrap each distinct phase: rsync, remote `npm ci`, `prisma generate`,
  `npm run build`, `prisma migrate deploy`, the DB backup, service stop/start,
  and the health/quiescence gates.
- Print a summary table at the very end, sorted longest first, so it lands in
  the Actions log.
- Keep it out of the way of the existing `set -Eeuo pipefail` behaviour and do
  not change any control flow. This task adds *only* observability.

## Task 2 — the one safe win, do it in the same pass

`npm ci` deletes `node_modules` and reinstalls from scratch every deploy, on the
slowest machine in the chain, for a lockfile that usually has not changed.

Make the Pi reuse the previous release's `node_modules` when
`package-lock.json` is byte-identical to the previous release's, and fall back
to a full `npm ci` otherwise. Requirements:

- The comparison must be on the **lockfile hash**, not a timestamp.
- Never reuse across a Node major-version change — record the Node version
  alongside the hash and invalidate on mismatch.
- Fall back to `npm ci` on any doubt. A stale `node_modules` that half-works is
  far worse than a slow deploy; this is a fail-closed decision.
- The existing check that `node_modules/.bin/prisma` is executable after install
  must still run and still fail the deploy if missing.

## What NOT to do yet

Do not attempt to ship a prebuilt Next.js artifact in this pass. That is the
real prize — it removes both `npm ci` and `npm run build` from the Pi entirely —
and the repo is public, so GitHub's free `ubuntu-24.04-arm` runners are
available and the x86-vs-arm64 blocker is gone.

It is still pass 2, deliberately, for two reasons:

1. **We do not know that `npm ci` + `npm run build` are actually the bulk of the
   747s.** If the time is really going to the DB backup, the migration, or the
   quiescence gates, the whole prebuilt-artifact plan targets the wrong thing.
   Task 1 answers that.
2. **The Node version mismatch, now measured.** The Pi runs Debian 13 (trixie),
   aarch64, glibc 2.41, **Node v20.20.2**. CI runs **Node 22**. glibc is fine —
   `ubuntu-24.04-arm` is 2.39, older than the Pi's 2.41, so its binaries load —
   but anything ABI-bound built under Node 22 will not load under Node 20.
   The versions have to be reconciled first, and note the deeper problem: CI
   currently tests and builds on a runtime prod does not run.

   SSH is `j85473@100.80.154.113` (or `192.168.1.208` on the LAN), not `pi@`.
   The Pi also runs Homebridge and a NAS bridge, so build work there competes
   with unrelated services — another reason to move it off the box.

## Constraints

- `.github/workflows/deploy.yml` is read by `deploymentCron.test.ts` and
  `rapidApiKeySync.test.ts`. `scripts/deploy.sh` may be read by others — check:
  `grep -rln "deploy.sh\|deploy.yml" src/lib/__tests__ tests/`
- Gates: `npm test` (baseline **603 pass, 0 fail**) **and** `npm run build`.
- `git commit -am` does not stage new files. Use `git add -A`.
- **Do not `git push`.** Pushing is what triggers the deploy, and Joseph wants
  to watch the first instrumented run. Leave the commit local and say so.
- Do not run `ssh`, `scripts/deploy.sh`, or any `--apply` script.

## Definition of done

- `deploy.sh` prints a per-phase timing table at the end of a run.
- Lockfile-hash-based `node_modules` reuse, failing closed to `npm ci`.
- `npm test` ≥603 green, `npm run build` green.
- Commit made locally, **not pushed**, with a note on what to look for in the
  first instrumented deploy's timing table.
