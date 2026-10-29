# Career Dashboard on the M70

Migration record from September 2, 2026; operating layout checked against the repository on September 29, 2026. **Production runs on the M70.** The final archive restored successfully and every saved column across all 50 tables matched at migration. The Pi Dashboard is stopped and its public tables are write-fenced. Do not restart the old Dashboard against its retained database. Migration measurements and verification counts below are historical snapshots, not current production-health claims.

## Ownership and access

- At migration, the selected production host was the Lenovo M70 running Ubuntu Server 24.04.4 LTS with an i5-10400, 16 GB RAM, and a 480 GB SSD. Check the host for later hardware or OS changes.
- Dashboard: <http://100.107.116.123:3000>, available to devices connected to Joseph's Tailscale network. There is no Dashboard login screen.
- Administration from the Mac: `ssh m70`. The account is `j85473`; passwordless sudo is explicitly authorized. The application runs as the separate `career-dashboard` account, which cannot use sudo.
- PostgreSQL 17 listens only on `127.0.0.1:5432` on the M70. The production database is `career_db`; the service login is `career_admin`. Credentials are in the restricted `/etc/career-dashboard/runtime.env` file, never in Git.
- The Mac's managed SSH tunnel exposes that database only at `127.0.0.1:55432` on the Mac. Its LaunchAgent is `com.josephlamb.career-dashboard-db-tunnel`. The tunnel is for Mac tools; the M70's services connect locally and do not depend on it.
- Interactive Claude, Codex, and manual scoring remain on the Mac. The Pi continues hosting Homebridge, file sharing and the walking application. Its walking-map database remains authoritative there; the M70 contains only the walking-map snapshot included in the whole-database archive.

## Unattended operation

| Responsibility | M70 service | Behavior |
| --- | --- | --- |
| Dashboard and API | `career-dashboard.service` | Starts at boot; restarts after failure; binds the Tailscale address on port 3000. |
| Stats snapshot refresh | `career-dashboard-stats-warm.timer` | Calls the web process every minute, including overnight, so the first visitor can use its retained Stats snapshot. A stale request starts one shared background rebuild; the ten-minute serving ceiling remains enforced. |
| ATS cohort workload balance | `career-dashboard-rotation-balance.timer` | Refreshes workload reservations daily at 00:10 Chicago time and reviews at most 100 completed-board moves weekly. New validated boards still collect immediately. See the [balancing rules](ATS_COHORT_WORKLOAD_BALANCING.md). |
| ATS acquisition | `career-dashboard-acquisition.service` | Runs the existing portable acquisition child with the existing eight-slot ceiling; waits through an operator pause. The historical logical lane name still says `mac-continuation`; it does not identify the physical host. |
| Scheduled pipeline, publication and persistence | `career-dashboard-scheduler.timer` | Invokes the existing scheduled pipeline every minute with its existing database coordination and a filesystem lock. |
| Repair watchdog | `career-dashboard-watchdog.timer` | Runs the existing repair checks every 15 minutes. Preserves the cap of three repairs per action per six hours and the ledger across releases. A critical finding remains a failed service result, not a successful health check. |
| Database and file backups | `career-dashboard-backup.timer` | Runs daily at 03:15 America/Chicago and catches a missed run after startup. Copies completed backups to the dedicated SSD attached to the M70. |
| Common Crawl board discovery | `career-dashboard-discovery.timer` | Looks for candidate ATS boards weekly. Discovery does not itself activate every candidate. |
| Stored and API canonical URL recovery | `career-dashboard-canonical-api.timer` | Ten minutes after each completed pass, checks up to 250 unresolved jobs against stored ATS postings, then checks up to 25 through supported employer APIs. Separate rotating cursors keep API misses from consuming the stored-match budget. Requires no browser license. Existing cards receive link-only repairs. |
| Protected aggregator canonical URL recovery | `career-dashboard-canonical-resolver.timer` | Each hour, discovers official employer boards for eight unresolved Himalayas employers and rechecks eight protected Himalayas pages. Both bounded sets rotate. The licensed browser remains separate from stored and API matching. Existing cards receive link-only repairs. |
| Gusto ATS crawling | `career-dashboard-gusto.timer` | Runs the licensed browser outside ATS API acquisition, one minute after each completed pass. Its task and progress appear in ATS Crawling alongside the other public-board collectors. |
| Public employer ATS boards | `career-dashboard-public-boards.timer` | Resumes bounded board turns about fifteen seconds after completion. Shares the licensed browser lock with Gusto and canonical recovery. Saves each board page and posting offset independently; respects operator pauses and ingestion capacity. |
| Public employer ATS HTTP collection | `career-dashboard-public-http.timer` | Collects ADP plus supported Paylocity/iCIMS sweeps with the same source identities, task leases and board checkpoints. Runs independently of the licensed browser lock; unsupported Paylocity/iCIMS reads retain their exact saved position for licensed fallback. Its first installation inherits an enabled public-board lane; subsequent releases preserve a stopped timer. |
| Board pruning review | `career-dashboard-board-pruning.timer` | Runs Mondays at 07:00 America/Chicago. Its liveness arm rechecks demoted boards and can automatically promote live boards or retire confirmed dead ones under sweep guards. Geography, unproductive-board, and low-yield arms report candidates and require the printed `--apply --selection-hash` command. Review the saved report or `journalctl -u career-dashboard-board-pruning.service -n 200`. |

The web service and unattended services require `/etc/career-dashboard/production-enabled`. Repairs additionally require `/etc/career-dashboard/watchdog-repair-enabled`. The watchdog's repair ledger is `/var/lib/career-dashboard/data/runtime/ats-watchdog-repairs.json`.

The board-pruning service does **not** require `watchdog-repair-enabled`. Its liveness arm has separate guards for its authorized weekly writes; the other arms remain approval-gated.

Deployment installs unit files and enables the Stats refresh timer in normal mode, after warming Stats and proving the next request is a cache hit. The separate API canonical resolver is enabled on its first normal deployment; later deployments preserve its prior running state. Maintenance deployment leaves it stopped, and rollback removes the new timer when returning to a release without it. Other new timers still require explicit enablement. If `systemctl is-enabled career-dashboard-board-pruning.timer` reports that this timer is disabled, enable it with:

```
sudo systemctl enable --now career-dashboard-board-pruning.timer
```

The October 7 workload-balancing release also initializes reservations and
enables the cohort balancing timer in normal mode. Maintenance-mode activation
leaves it stopped, and rollback restores its previous ownership. Under staging
pressure, the [continuation capacity rule](ATS_CONTINUATION_CAPACITY_BALANCING.md)
limits new listing claims to one across the shared worker pool while drain work
exists; it does not increase that pool's eight-slot ceiling.

The old Mac acquisition and repair-watchdog LaunchAgents are unloaded, disabled and archived outside `~/Library/LaunchAgents`. The retired native scoring watcher stays retired. The separate, previously paused Codex ATS cutover automation remains paused; its obsolete Pi/Mac instructions must not be resumed blindly.

### Reconciling the four-day API rotation

Healthy API boards use a four-day calendar rotation in America/Chicago. Browser
collection and failed-board recovery keep their separate schedules. Installing
the cadence code does not rewrite existing board dates. To reconcile retained
ordinary weekly dates, run `scripts/transition_ats_api_rotation.ts --preview
<plan.json>` under the production runtime environment, review the saved plan,
then use `--apply <plan.json>` when that schedule change is authorized. Previews
expire after five minutes and application rechecks their selection hash.

The transition derives the next four-day opening from each board's last
successful synchronization. An opening that has already arrived stays due so
the dispatcher can catch up; deriving it from the preview time would skip
today's opening. Only an exact, proven ordinary weekly date can move earlier.
Failure/retry counters, custom dates, operator holds, first collections,
unfinished batches and live leases prevent a move. Conditional updates recheck
these guards under the admission lock. The command changes only eligible board
dates; retained work, receipts, jobs, scores, browser schedules and provider
circuits remain authoritative. Verify new collection receipts and completed
boards after application, rather than treating a running worker as progress.

The operator's pre-existing pipeline pause is preserved through migration and deployment. At the final source freeze it was scheduled to expire **September 2 at 8:55:14 PM America/Chicago** (`2026-09-03T01:55:14.112Z`). A running acquisition process can correctly hold zero leases while that pause is in force. The watchdog can report `no_live_workers` during that pause; this is not proof of failed service startup or justification to clear the pause.

## Releases and persistent files

The GitHub workflow is **Deploy to M70**. Pushes to `main`, and manual workflow dispatches, now target the M70. The existing CI key and RapidAPI secret names are retained; the destination, pinned host key and restricted configuration path have changed.

A release waits for work that a *process* is doing — the pipeline, the acquisition lanes and their leases, in-flight batches. It deliberately does not wait for a manual scoring batch. Those leases are held by Joseph working through an export on his Desktop, and waiting on them meant a release waiting on a person: on September 3 a deploy sat in the quiescence loop with five leased batches and every other counter at zero, looked hung, and was cancelled mid-flight. A release swap does not touch a batch — the rows and the export both survive, and an item whose lease lapses becomes leasable again. The cost accepted is that an import landing inside the swap window fails and must be retried.

Cancelling the GitHub workflow does **not** stop a deployment. GitHub only runs the client half; the activation script keeps running on the M70 through any required backup, migration, swap and health check, and restores the services itself. Cancelling removes the ability to watch it, and a cancellation that arrives between the migration and the release swap would leave the schema ahead of the running code with no automatic recovery. If a deploy looks stuck, read the quiescence counters in the workflow log rather than cancelling.

The deployment entrypoint is `scripts/deployment/deploy-m70.sh`. The root-owned activation process builds with deliberately unusable database credentials, quiesces existing work, preserves operator pause intent, waits for runtime leases to drain, asks Prisma whether the release has a pending migration, takes a fresh predeployment backup when a migration is pending or that check is uncertain, applies migrations, swaps the active release and proves HTTP health before restoring previously running background services. A confirmed code-only release logs that it skipped the predeployment backup; the independent nightly backup remains unchanged. It does not reset acquisition evidence or invalidate existing scores.

Activation always enters the selected release directory before checking its build marker. Retrying an already-built release therefore loads that release's production configuration for the discovery-audit precheck, just as a fresh build does. A failed or uncertain precheck still aborts before live services are stopped; a completed build does not bypass recovery checks.

For an unusually risky code-only release, set the GitHub Actions variable `M70_FORCE_PREDEPLOY_BACKUP=1` before pushing and remove it after that workflow starts. A manual workflow dispatch also exposes a `force_predeploy_backup` checkbox. The direct entrypoint accepts `FORCE_PREDEPLOY_BACKUP=1`. Invalid force values stop before any files are transferred, and every migration-status failure takes the conservative backup path rather than skipping it.

The legacy GitHub variable `PI_ACTIVATION_MODE=maintenance` remains supported: it leaves acquisition, scheduler and repair timers stopped after deployment. With the variable absent, normal deployment restores the previously active background services. The entire Pi deployment path has been deleted: the old deploy script, its release-activation helper, the crontab installer, the storage audit and the service-URL resolver, along with the migration-admin workflow and the stored Pi sudo password. The deployment safety tests now assert against the M70 scripts they actually guard, in `tests/unit/m70Deployment.test.ts` — that a release is built from one clean commit against unusable database credentials, that quiescence is proven and every required recovery point is taken before the schema is touched, that uncertain migration status fails closed to a backup, that a failed release restores the previous code and never an old database, that background services return only after the new release answers and stay stopped in maintenance mode, and that user data and credentials live outside the code being swapped.

Application releases are under `/opt/career-dashboard-releases/<commit>`, selected by the `/opt/career-dashboard` symlink. Runtime state is shared under `/var/lib/career-dashboard/data/runtime`. Discovery checkpoints and display logs also persist across release swaps. The current acquisition release file overrides the old source revision in the runtime environment for all background and web services. Checked-in scoring policies and canonical documents remain release-owned. Do not treat any policy or evidence version change as permission to invalidate existing scores.

The web unit supervises Next.js directly rather than through npm. The first production reboot exposed a three-minute shutdown delay with the npm wrapper. Direct supervision subsequently passed a production restart in 1.14 seconds, with health returning and no forced termination. The unit allows a 30-second graceful drain and treats Next's documented signal exit codes as successful shutdowns.

The acquisition unit also supervises its Node process directly. Forwarding signals through the environment wrapper while systemd signaled the whole process group delivered SIGTERM twice, killing the child before its capacity cleanup completed. Runtime configuration comes from the unit's environment files. Deployment additionally releases expired capacity reservations with an atomic expiry predicate; live reservations, fencing counters, work receipts and checkpoints remain intact, and the full quiescence gate still applies.

## Backups and recovery

### Deduplicated recovery points (October 28, 2026)

The installed repository mode replaces repeated full-file copies with two
independent encrypted restic v2 repositories: one at
`/var/lib/career-dashboard/backups/repository`, the other at
`/mnt/backup/m70/repository`. Each recovery point still contains a **complete
native PostgreSQL custom archive** and the runtime/configuration archive.
Unchanged chunks are shared between snapshots within each repository. Restoring
a point does not require replaying earlier backups, and the SSD repository can
restore independently of the application-disk repository.

The database is streamed with PostgreSQL compression disabled so restic can
deduplicate the content before compressing and encrypting it. No database
tables, job history, scores, acquisition evidence, or manual scoring batches
are excluded. The source database remains online and is never modified by the
backup. PostgreSQL supplies its normal consistent snapshot.

For every point the coordinator:

1. Saves both streams in the application-disk repository and computes their
   SHA-256 digests as the source streams are read.
2. Reads both streams back, compares the digests, fully decodes the database
   with `pg_restore` without connecting to a database, checks the protected
   job/score/artifact tables, and validates the configuration archive.
3. Copies the new chunks to the independently initialized SSD repository,
   then repeats the full readback, checksum and decode checks from the SSD.
4. Atomically publishes matching recovery receipts on **both** disks. An
   incomplete or one-disk receipt cannot authorize retention or claim freshness.
5. Retains the three newest complete points across legacy file sets and new
   repository points. Before retiring an older point it verifies repository
   data and any surviving legacy archives. Retention journals make a partially
   completed cleanup resumable. Unknown or unmatched historical archives stay
   protected. Restic pruning preserves chunks shared by retained snapshots.

Standalone predeployment archives continue their separate three-readable-copy
retention policy; archives less than one hour old and unreadable files are
protected. The replacement also preserves the former 30-day cleanup of files
named `cron-*.log`, without touching other runtime history.

Failed copies, failed restores and interrupted source dumps preserve the last
good points. Interrupted receipt publication is reverified before completion.
Abandoned snapshots belonging to this engine are eligible for cleanup only
after 24 hours and only with three complete recovery points available; a
receipt on either disk protects an interrupted publication. Live repository
locks are never forcibly removed. Pruning repacks at most 1 GiB per pass.

Capacity checks use the largest actual repository addition from the three
latest points, with 25% growth allowance, an 8 GiB minimum allocation, and a
separate 5 GiB emergency floor. The first seed is charged while it remains in
that recent window. Every writing phase stops before spending the emergency
floor. A schema migration still reserves the full standalone predeployment
archive **in addition to** the repository nightly budget. Deduplication reduces
the storage multiplier; it does not make physical storage infinite. Future
high churn or database growth can still require additional capacity, and a
capacity failure must preserve the existing recovery points.

The nightly timer stays at 03:15 America/Chicago. A persistent systemd drop-in
selects `/usr/local/sbin/career-m70-repository-backup`; its engine is installed
outside the release tree. Both survive an application rollback. The service
allows three hours for full verification and at most two starts in eight
hours, so long timeouts cannot turn into a continuous retry loop. Automatic reboot maintenance checks
the new recovery format and its 24-hour freshness before proceeding.

The repository key is `/etc/career-dashboard/backup-repository.key`, owned by
root with mode 0600. A private copy must be exported and checksum-verified on
the Mac **before** bootstrap can retire any legacy point. The Mac copy is
`~/.config/career-dashboard/recovery/backup-repository.key`. Keep this key with
the recovery instructions: the encrypted data cannot be restored without it.
The key is not printed in logs, committed, or included inside its own encrypted
configuration archive. Losing a key or repository fails closed; the engine
does not silently initialize a replacement over existing recovery receipts.

To inspect the current points and reserve:

```sh
sudo python3 /usr/local/lib/career-dashboard/m70-repository-backup.py status
```

Matching receipts under `recovery-points/m70-<timestamp>.json` identify each
disk's database and file snapshot IDs and source checksums. To restore, choose
the desired disk and receipt, recover its key if necessary, and stream the
database snapshot into a **new, empty recovery database**:

```sh
set -o pipefail
sudo restic --repo /mnt/backup/m70/repository \
  --password-file /etc/career-dashboard/backup-repository.key \
  dump DATABASE_SNAPSHOT_ID database.dump \
  | pg_restore --no-owner --no-privileges --dbname NEW_EMPTY_RECOVERY_DATABASE
```

Export `files.tar.gz` using the receipt's file snapshot ID and validate it with
`tar -tzf` before restoring its contents in an isolated recovery directory.
Never restore over the live production database as a deployment rollback.
The per-run progress record is
`/var/lib/career-dashboard/ops/backup-progress.json`; completed receipts and
the backup service journal are the completion authority.

Repository mode requires the Ubuntu-packaged `restic` command. Initial setup
uses `m70-repository-backup.py prepare`, exports/verifies the recovery key, and
runs `bootstrap` through `scripts/with-env.mjs` as root. Only after independent
verification and paired receipt publication does bootstrap create
`/etc/career-dashboard/backup-repository-enabled`. Install the persistent
dispatcher with `install-m70-repository-backup.sh`. Subsequent releases update
that installed engine whenever the enable marker exists.

### Legacy file sets and standalone deployment archives

The following describes the legacy format during migration. Repository mode
keeps its three-point recovery coverage while older file sets rotate out.

Daily backups contain a PostgreSQL custom archive, an archive of application data and restricted runtime configuration, and a SHA-256 manifest. Retain the three newest completed nightly sets on the application disk and the dedicated SSD mounted at `/mnt/backup`. There is no minimum retention age: an older set is eligible for removal once three newer verified recovery points exist. Keep the three newest readable predeployment database snapshots separately; protect snapshots less than one hour old and unreadable archives from automatic cleanup. The SSD is attached to the same M70, so this protects against bad releases and database mistakes but not loss of the machine. The old September 2–3 copies on the 3.6 TB Time Machine NAS are historical; the nightly job no longer writes there. Do not put new configuration archives on that shared drive as an emergency space workaround.

The backup job checks free space on both disks before creating a dump. Before deleting an older nightly set, it verifies the checksums of the three retained SSD sets. It removes each matching application-disk duplicate before its SSD copy, then trims excess predeployment snapshots. It repeats retention after publishing the new verified SSD copy, returning both destinations to three completed nightly sets. Within one run, unchanged archives reuse their completed checksum check; any change to a manifest or its archive identities, sizes, or modification times requires a fresh check. Incomplete sets never displace a completed recovery point. Unmatched local archives remain protected. Capacity estimates include one database dump and one file archive per disk, using the largest retained files (including predeployment dumps), plus 25% growth room and 5 GiB of reserve. It writes each new SSD set to a private staging directory, verifies its checksum, then publishes the manifest last. If capacity is insufficient, the backup service fails visibly without filling the application disk; the Dashboard and pipeline should continue serving work. Investigate the failed backup rather than restarting it repeatedly.

The frozen migration archive is retained separately on both hosts. Its SHA-256 is `33e89af93ccff1b131758aa2a597d0ccb50d580d6ad46ca86a870010633fb0bf`; it contains 4,685,523,363 bytes. Its source snapshot has **810,511 jobs and 586 Applied jobs**. All existing score fields, job status/history, acquisition receipts, saved pages and migration records matched before activation. The [complete row-comparison record](migrations/m70s/final-row-comparison-2026-09-02.json) covers all 50 tables and every archived column.

The Pi's public tables belong to a non-login archive owner. Its former application role can read those tables but cannot update them. The walking-map table retains its original role's write access. The old Dashboard systemd unit is disabled and guarded by an absent Pi-production marker; its managed pipeline cron is removed.

**Once the M70 accepts new writes, the Pi database is stale.** Never restart the Pi Dashboard as an automatic fallback. Recovery onto the Pi requires stopping target writers, copying or reconciling the newer M70 state, preserving any newer walking-map data, validating it and establishing one writable Dashboard authority again. A release rollback changes application routing; it does not restore an old database over newer user actions.

### Release cleanup and capacity protection

Deployment and the nightly backup run `scripts/deployment/m70-storage.py`.
Cleanup retains the three newest completed releases, plus every release
referenced by the active/rollback routing, acquisition configuration, running
processes, or the deployment in progress. Failed activations do not displace
completed rollback versions. Unfinished directories are eligible only after
24 hours. Cleanup only considers real directories with 40-character commit
names; it never follows their runtime/configuration symlinks into shared state.
The deployment lock serializes cleanup with activation. A nightly pass defers
release cleanup while a deployment owns that lock.

Deployments also hold the backup lock, waiting up to 45 minutes for an existing
backup to finish before building or switching releases. Before building, they
require the next full nightly backup reserve plus 5 GiB of build headroom. The
reserve uses the largest retained database/file archives, 25% growth allowance,
and another 5 GiB. Both backup destinations must have capacity. The reserve is
checked again after building; before a required migration snapshot, two full
reserves must fit on the application disk. Capacity failures stop the release
and preserve its database; they never delete recovery points below policy or
change existing job scores.

Preview release cleanup with:

```sh
sudo python3 /opt/career-dashboard/scripts/deployment/m70-storage.py cleanup
```

Add `--apply` to remove the listed obsolete releases. Normal deployment and
nightly execution already apply this policy automatically. Never pass
`--deploy-lock-held` manually: that option is for the activation process which
already owns the lock.

Before creating a large test database, budget its **entire** expected allocation
in addition to the nightly reserve; for example, a 128 GiB copy requires:

```sh
sudo python3 /opt/career-dashboard/scripts/deployment/m70-storage.py check-capacity --extra-bytes 137438953472
```

Run this while holding the deployment and backup locks for the copy operation,
so a simultaneous allocation cannot spend the same capacity. Remove a stopped
test copy after its acceptance checks; retaining one requires an explicit
storage allocation. Test databases are never deleted automatically. The Prisma
7 copy and its separate WAL were removed on October 17, 2026 after acceptance;
the recorded validation evidence remains in the repository.

These guards bound release growth and reject allocations that consume backup
headroom. Database growth can still exhaust finite physical capacity: an actual
reserve failure requires storage expansion or a separately approved retention
change, rather than repeated retries or deletion of protected recovery points.

## Database tuning

PostgreSQL arrived on the M70 still carrying the settings it had on the Pi, which were sized for four cores, 3.7 GiB of RAM and a USB-attached SSD the kernel reported as rotational. On a twelve-thread machine with 15 GiB of RAM and an internal SATA SSD those values throttle ingestion: the buffer cache was 128 MB against a 15 GB database, the planner was told random reads cost four times a sequential one, and only one read could be issued at a time.

The overrides live in `/etc/postgresql/17/main/conf.d/10-m70-tuning.conf`, which is a drop-in file — the stock `postgresql.conf` is unmodified, so removing that one file reverts everything. Durability is deliberately untouched; commits are still flushed synchronously.

Most of it took effect on a configuration reload with no interruption. Three settings — the buffer cache, the worker-process ceiling and the autovacuum worker count — only apply after a full PostgreSQL restart, and had not been applied at the time of writing. A restart drops every connection at once, so the eight acquisition lanes lose their leases and the pipeline lock is released; those are reclaimed automatically, but any request in flight fails and is retried. It does not touch existing scores. Do it inside a deployment's quiescence window or an operator pause rather than under live lanes.

The measurement to watch is the buffer cache hit ratio, which was 90.3% before tuning; a healthy figure is above 99%, and it will not move meaningfully until the restart happens.

## First collection after Common Crawl validation

Zoho Recruit, Gem, JobScore, JazzHR, Manatal, ClearCompany and HireHive use the
[controlled first-collection policy](ATS_FIRST_COLLECTION_ADMISSION.md). Their
Common Crawl results enter a waiting inventory. A named pilot and the durable
admission gate must permit their first collection before normal rotation applies.
The immediate-eligibility behavior below applies to the other existing adapters.

A newly validated API board is eligible immediately, including when its assigned
weekly cohort is another weekday. Once that first collection completes, the
existing weekly schedule applies. Failed validation retains its 30-day recheck;
Gusto browser validation retains its separate collection path.

To release boards created with the former one-day discovery delay, preview
`scripts/release_ats_first_collection.ts --run-id=<audit UUID>` under the normal
production runtime environment. Add `--apply` to release the matching boards.
The script requires successful validation in that exact audit, an active board,
zero failures and retries, the original one-day schedule, and no acquisition
attempt, batch, sweep, or contact receipt. It updates only the first due date;
weekly cohorts, existing retries, retirement decisions, and scores stay intact.
The output includes the released identities and their previous due dates for
verification. Repeating it cannot release a board already made due.

## Routine administration

From the Mac, use `ssh m70`. Once connected:

```sh
systemctl status career-dashboard.service career-dashboard-acquisition.service
systemctl list-timers 'career-dashboard-*'
journalctl -u career-dashboard.service -n 40 --no-pager
sudo systemctl start career-dashboard-backup.service
```

For rack work that requires disconnecting power, first run `sudo shutdown -h now` and wait for the machine to power off. Ordinary administration does not require the TV or keyboard.

## Verification and limits

- The final restore completed at 20:58:23 UTC. All 850 surviving columns retain their names, relative order, types, defaults and nullability. All 250 indexes, 156 constraints, 11 user triggers and 11 non-extension functions match. Physical column-number gaps left by historical dropped columns disappear during logical restoration; no surviving column or value was removed.
- Health, Dashboard, Applied and bookmarked API reads passed. The new production database role passed a write test inside an explicitly rolled-back transaction; the entire selected job and its existing scores remained unchanged afterward.
- A real reboot returned SSH, PostgreSQL, Tailscale, the Dashboard and acquisition automatically without a console login. The Mac's private database tunnel reconnected as well. The subsequent direct-Next service restart check passed in 1.14 seconds.
- The Linux test suite passed 1,265 tests. The focused deployment and credential-transfer checks passed 26 tests. GitHub run history and systemd backup logs are the authority for later release and backup execution results.
- The current operator pause prevents a live acquisition-throughput acceptance check. Service startup and preservation of that pause are verified; zero acquisition leases during the pause is expected.
- Physical Mac-off/phone-away-from-home acceptance has not been performed. Headless service operation and a software reboot are separate from a physical power-loss test.
- At the migration check, the M70 Tailscale device key was shown as expiring March 1, 2027. Verify its current expiry in the Tailscale admin console before relying on that date.

### Himalayas employer discovery

The canonical resolver keeps the existing aggregator API pass and licensed browser fallback. Between them, a bounded employer-discovery pass reads the official website from Himalayas public MCP, follows employer-owned careers pages, and checks complete public catalogues from Lever, Greenhouse, Ashby, Recruitee, Breezy, and BambooHR. Unsupported, unreadable, truncated, or ambiguous catalogues defer the employer. This pass changes only verified application links; descriptions, scores, card status, application history, and duplicate-card decisions are untouched. Verified mappings use the exact Himalayas company slug and do not alter global employer-name rules. Permanently retired boards remain retired.

Use `npm run himalayas:resolve-employers -- --company-slug=panopto` for a read-only preview. Dry runs do not persist mappings or advance the cursor. The hourly service adds `--apply --limit=8`; each employer failure is isolated and the applied rotation advances so one miss cannot starve other employers.


## Public employer board collectors (October 17, 2026)

The public-board worker owns ADP, Avature, BrassRing, DZConneX employer sites,
iCIMS, Paycom, Paylocity, Phenom employer sites, Sage HR, Talemetry employer
sites, classic Taleo, Jobvite, Freshteam, and CATS. API acquisition excludes
these families. The first normal installation enables the new timer; later
releases preserve its previous timer state, and maintenance leaves it stopped.
Rollback removes the new unit when the prior release did not provide it.

Athena discovery records canonical employer board URLs. Phenom discovery is
limited to the verified Cigna and Arrow hosts because its customer career
sites commonly use their own domains. Vendor marketing hosts, ambiguous job
links without a board identity, and unverified employer identities are rejected.
Old Common Crawl checkpoints and query IDs remain authoritative. During legacy
CDX backoffs the worker can drain existing Athena results without submitting
new scans from the backoff path.

Each board keeps its pending page, posting list, completed posting IDs and page
signatures in `AtsBrowserSweep`. A completed page advances only after every
posting has a durable ingestion outcome. A crash after insertion repeats the
same stable source identity and becomes a duplicate. Provider failures defer
one board while other boards retain their progress. Neither partial sweeps nor
closed postings remove existing cards or scores. Success schedules the board
for a weekly recheck; bounded unfinished turns resume earlier. Full traversal
can take multiple timer passes on large boards.

Inspect progress with the provider's `IngestionTask` and `IngestionSourceRun`
rows, the per-board `AtsBrowserSweep` row, and
`journalctl -u career-dashboard-public-boards.service`. Source-run counters
separate inserted jobs, duplicates, filtered postings, and request failures.
Use `scripts/verify_browser_ats_collectors.ts` for a read-only public-page smoke
test. `scripts/seed_browser_ats_boards.ts` previews the twenty employer boards
verified in the audit; `--apply` adds missing seeds without reviving retired
boards or changing existing board schedules. Normal expansion comes from the
Athena/Common Crawl candidate queue.

### ATS Crawling lane

Gusto and the fourteen public-board families appear together in the **ATS
Crawling** status row, separately from source search/feed ingestion and API
ATS acquisition. Gusto retains its dedicated browser timer and profile. The
public-board worker retains its own timer and per-board progress. Both workers
and the canonical resolver serialize access to the shared licensed browser.

The former Gusto paid-browser task is reclassified in place before a new claim
or catalog reconciliation: its task ID, history, cursor, counters, due date,
watermark, lifecycle state and board schedules survive. A live lease blocks the
move until that work finishes. Existing source-run receipts retain their
historical classification; new Gusto runs use the public-board mode.

### ATS Crawling scheduling and capacity

The public-board worker keeps one licensed browser open for a bounded three-minute
pass. It can visit up to 24 boards, with at most 50 postings or one minute per
board turn. Listing and detail tabs are reused within a board; click pagination
advances the existing page instead of replaying every earlier page. The timer
retries 15 seconds after completion, with up to five seconds of jitter. Gusto
and protected link recovery wait up to four minutes for the shared browser lock,
so a busy crawling turn does not immediately discard their timer attempts. The browser
session limit remains one.

A ten-turn cycle per provider reserves four turns for saved continuations, three
for known board refreshes, two for first crawls, and one for retries. The task's
durable claim count advances this cycle across service passes and restarts.
Unused reservations flow to other useful work. At most two retry turns enter a
normal 24-turn pass. Among eligible providers, the provider whose task started
least recently is preferred, with a bounded adjustment for its eligible backlog
and the measured duration of its last 32 completed turns in the past seven days.
Larger queues and cheaper turns receive more opportunities. A provider waiting
15 minutes bypasses that weighting; providers without a previous start go first.
The bound applies at selection boundaries and cannot preempt an in-flight turn.
Its board is selected by queue priority and oldest due date. Durable task starts
keep this fairness across restarts. Cost samples distinguish HTTP and browser
worker turns when that provenance is available; older receipts remain usable.
Sampling reads at most 32 recent completed source turns before filtering by
worker lane, so a sparse lane cannot trigger an unbounded scan of HTTP history.
Paylocity/iCIMS store separate HTTP and browser start times in their existing
task checkpoint. HTTP turns never reset the browser fallback's fairness clock,
and the shared provider task lease still prevents concurrent claims.
If a selected task cannot be claimed, that provider waits until the next pass
rather than repeatedly consuming selection attempts. Existing due dates and retry holds
remain authoritative. Operator pauses, pilot policy, board retirement and the
shared ingestion pressure gate still stop work. Safety checks are cached for
at most two seconds; every completed posting still persists its cursor.

The public HTTP worker collects ADP plus eligible Paylocity and iCIMS boards
without taking the licensed browser lock. Paylocity/iCIMS browser continuations
keep their original pagination and stay with the licensed worker. New cycles
try HTTP first. If the initial listing or an exact posting detail cannot be
verified over HTTP, the saved sweep carries a browser handoff with its page,
offset, posting IDs and source identity intact. The same provider task lease
fences both workers; ownership is rechecked after claim. A detail handoff does
not change HTTP listing pagination. Failure to read a later HTTP listing retains
that exact traversal for retry, rather than interpreting it as a browser page.
A completed sweep may try HTTP again on its next normally scheduled cycle.

Retry spacing changes only after a new failed attempt. Confirmed 404/410 or DNS
failures and explicitly unavailable tenants retry after seven days, increasing
to 14 days with at least three previous failures and 28 days with at least five.
Missing catalogue/detail evidence starts at six hours and backs off to at most
seven days; access refusals/rate limits back off from six hours to at most three
days. Other transient errors retain a one-hour exponential retry capped at one
day. No failure is converted to a successful or empty board. Saved cursors,
existing future holds, retirement decisions, jobs and scores are retained.
Operator pauses, shutdown, lost leases, capacity holds and HTTP-to-browser
handoffs remain deferrals and do not acquire a failure backoff. Source receipts
record the worker lane, eligible backlog, observed turn cost, browser handoff and
retry category/date so later throughput measurements can explain the change.

A board that produces an admitted job stays eligible for daily refresh for 14
days. Other successful boards receive a stable weekday/hour in America/Chicago
for weekly refresh. This policy is prospective: it sets the next date after a
successful crawl and retains existing jobs, scores, observations and unfinished
progress. The same refresh policy applies to Gusto. Unavailable public tenants
retain their identity and evidence under the retry spacing above; Gusto keeps
its existing weekly recheck for recognized unavailable tenants.

Paycom and modern BrassRing use their published page-number fields to resume a
saved page directly. Keyboard activation avoids a cookie banner or job-card
overlay covering the arrow hitbox. The requested page position and changed
posting IDs must both be observed before work advances; unsupported templates
retain the bounded arrow/replay fallback. BrassRing waits for its search UI to
render before submitting an unfiltered search. Publisher-declared temporary
unavailability remains a retry and does not wait for missing search controls.

Classic Taleo resumes through the publisher's existing page-number submission
instead of replaying every earlier page. The reader keeps the site's results
per page unchanged and verifies the requested page, complete row count and
changed posting identities before accepting it. A Taleo turn that exhausts its
budget without advancing saved work receives the normal board retry backoff
instead of another immediate continuation. Saved pages, posting IDs and page
signatures remain intact; shutdown, pause, capacity and lease deferrals retain
their existing behavior.

An advertised total alone cannot prove a stable snapshot. When BrassRing reports
the final page, renders all expected cards and explicitly disables Next, the
worker retains that evidence alongside the original advertised count and every
processed posting ID. A fully processed traversal may then finish despite a
difference between unique IDs and the advertised total. Missing controls,
repeated pages, unprocessed postings or an unverified final page still retain
unfinished progress. Old held final pages are re-read and must match the saved
page signature before their final-page evidence can be restored.

Each source-run checkpoint records its crawl queue, board, completion and
deferral state under `checkpoint.crawl`. Run
`scripts/benchmark_ats_crawling.ts --since=<UTC ISO> --until=<UTC ISO>` under the
normal runtime environment for a read-only throughput report. It counts durable
finished turns and completions in an explicit wall-clock window; a short sample
with a different board mix is not a controlled hardware-capacity claim.

### HTTP transport, early exclusions and first-week reservations

Collection ownership does not imply that a browser is necessary. ADP already
uses public JSON for listings and details; its independent HTTP worker removes
that work from the shared browser lock. Paylocity and iCIMS try bounded public
HTTP reads before launching a browser. Paylocity requires one complete, branded
public catalogue of at most 250 jobs. Larger or unsupported catalogues retain
the browser path. iCIMS follows the publisher's exact unfiltered next-page URL
and requires page-position and card-completeness evidence. Exact details must
retain the original posting and employer identity. A first HTTP refusal falls
back to the browser; an established HTTP listing traversal retains its own
cursor semantics and retries rather than mixing pagination methods. Old saved
browser traversals continue with browser listing semantics.

The existing title exclusions run before detail retrieval only when the listing
provides a complete, verified title. Unknown, clipped and action-link text still
receives full detail retrieval. Known source observations are checked first.
Every new early rejection must save an immutable listing evidence event with
the posting ID, title, URL, board and rule reason before advancing the cursor.
These rejected future listings retain that evidence instead of a full archived
description. Existing job records, scores and lifecycle choices are unchanged.
The throughput report includes actual HTTP/browser operations, detail visits
avoided, and listing/detail/ingestion milliseconds. Older receipts lacking these
metrics remain unknown and are excluded from measured cost totals.

Discovery's untouched public-board placeholder historically used `parked` and
one failure despite never making a collection attempt. The scheduler now admits
that narrow state as first collection, ahead of genuine retry classification.
Recorded attempts, responses, saved sweeps, unfinished work and true validation
holds prevent that exception. Failure counters are retained.

Run `node --import tsx scripts/balance_ats_crawling.ts` in the configured runtime
to preview first-week reservations. The command saves its source snapshot,
proposed assignments and receipt under `.tasks/ats-crawling-rotation/`. It uses
whole completed-cycle worker time when available and provider estimates for
unknown boards, balancing ADP HTTP work separately from licensed-browser work.
Only a fresh invocation with `--apply` writes reservations. It moves only due,
never-attempted first boards with no saved sweep, open work, live task lease or
previous reservation. Application rechecks those guards under task locks and
changes only weekday, next date and reservation metadata. It does not run
automatically during deployment. Existing unfinished work and retry dates stay
eligible on their current terms; initial first collections can move later by
up to seven days. New public-board discoveries receive an initial slot directly,
and weekly refreshes honor the persisted weekday. The existing daily refresh
policy for recently productive boards remains in place.

Workload projections are provisional: completed-board samples favor boards that
already finish, and most newly discovered catalogues are unmeasured. A balanced
plan is not proof of weekly capacity. Measure actual completion and detail-visit
rates after activation before increasing browser concurrency or promising a
seven-day coverage target.

### Crawl capacity release (October 29, 2026)

Public crawl sessions now stay warm for at most six minutes, retaining the
60-second board deadline and graceful shutdown. The shared browser lock is
released at the end of every session for Gusto and canonical resolution.
Two disjoint HTTP provider groups run concurrently: ADP and the remaining
HTTP-first providers. Each provider still has one fenced task lease.

Elapsed board time targets 40% first collection, 30% refresh, 20% continuation
and 10% retry per session; unavailable queues lend time to available work.
Retries have a 10% session time ceiling, with at most one board-turn overshoot.
The shares are scheduling targets, not completion guarantees.

Initial unloaded HTTP-to-browser handoffs with a legacy discovery placeholder
are first collections only when saved state and historical receipts show no
genuine failure. This is a selection correction, not a database reset.
No saved dates, posting IDs, scores or failure counters are rewritten.

Paycom public HTTP collection accepts complete catalogues of at most 50 jobs,
using anonymous credentials issued by the employer public page. Credentials
stay in memory. Catalogue totals, unique job IDs, external visibility and
matching employer details are verified; larger or uncertain boards retain
browser collection. Existing browser traversals keep their pagination meaning.

The receipt benchmark now separates distinct completed boards and first-ever
completed collections from repeated completion turns. First-collection metrics
require receipts from this release; older receipts are not inferred as zero
first collections. Compare stable windows and provider mix before claiming a
sustained speedup.
