# Career Dashboard on the M70

September 2, 2026. **Production runs on the M70.** The final archive restored successfully and every saved column across all 50 tables matches. The Pi Dashboard is stopped and its public tables are write-fenced. Do not restart the old Dashboard against its retained database.

## Ownership and access

- The selected production host is the Lenovo M70 running Ubuntu Server 24.04.4 LTS, with its existing i5-10400, 16 GB RAM and 480 GB SSD.
- Dashboard: <http://100.107.116.123:3000>, available to devices connected to Joseph's Tailscale network. There is no Dashboard login screen.
- Administration from the Mac: `ssh m70`. The account is `j85473`; passwordless sudo is explicitly authorized. The application runs as the separate `career-dashboard` account, which cannot use sudo.
- PostgreSQL 17 listens only on `127.0.0.1:5432` on the M70. The production database is `career_db`; the service login is `career_admin`. Credentials are in the restricted `/etc/career-dashboard/runtime.env` file, never in Git.
- The Mac's managed SSH tunnel exposes that database only at `127.0.0.1:55432` on the Mac. Its LaunchAgent is `com.josephlamb.career-dashboard-db-tunnel`. The tunnel is for Mac tools; the M70's services connect locally and do not depend on it.
- Interactive Claude, Codex, and manual scoring remain on the Mac. The Pi continues hosting Homebridge, file sharing and the walking application. Its walking-map database remains authoritative there; the M70 contains only the walking-map snapshot included in the whole-database archive.

## Unattended operation

| Responsibility | M70 service | Behavior |
| --- | --- | --- |
| Dashboard and API | `career-dashboard.service` | Starts at boot; restarts after failure; binds the Tailscale address on port 3000. |
| ATS acquisition | `career-dashboard-acquisition.service` | Runs the existing portable acquisition child with the existing eight-slot ceiling; waits through an operator pause. The historical logical lane name still says `mac-continuation`; it does not identify the physical host. |
| Scheduled pipeline, publication and persistence | `career-dashboard-scheduler.timer` | Invokes the existing scheduled pipeline every minute with its existing database coordination and a filesystem lock. |
| Repair watchdog | `career-dashboard-watchdog.timer` | Runs the existing repair checks every 15 minutes. Preserves the cap of three repairs per action per six hours and the ledger across releases. A critical finding remains a failed service result, not a successful health check. |
| Database and file backups | `career-dashboard-backup.timer` | Runs daily at 03:15 America/Chicago and catches a missed run after startup. Copies completed backups to the Pi SSD. |

The web service and unattended services require `/etc/career-dashboard/production-enabled`. Repairs additionally require `/etc/career-dashboard/watchdog-repair-enabled`. The watchdog's repair ledger is `/var/lib/career-dashboard/data/runtime/ats-watchdog-repairs.json`.

The old Mac acquisition and repair-watchdog LaunchAgents are unloaded, disabled and archived outside `~/Library/LaunchAgents`. The retired native scoring watcher stays retired. The separate, previously paused Codex ATS cutover automation remains paused; its obsolete Pi/Mac instructions must not be resumed blindly.

The operator's pre-existing pipeline pause is preserved through migration and deployment. At the final source freeze it was scheduled to expire **September 2 at 8:55:14 PM America/Chicago** (`2026-09-03T01:55:14.112Z`). A running acquisition process can correctly hold zero leases while that pause is in force. The watchdog can report `no_live_workers` during that pause; this is not proof of failed service startup or justification to clear the pause.

## Releases and persistent files

The GitHub workflow is **Deploy to M70**. Pushes to `main`, and manual workflow dispatches, now target the M70. The existing CI key and RapidAPI secret names are retained; the destination, pinned host key and restricted configuration path have changed.

The deployment entrypoint is `scripts/deployment/deploy-m70.sh`. The root-owned activation process builds with deliberately unusable database credentials, quiesces existing work, preserves operator pause intent, waits for runtime leases to drain, takes a predeployment backup, applies pending migrations, swaps the active release and proves HTTP health before restoring previously running background services. It does not reset acquisition evidence or invalidate existing scores.

The legacy GitHub variable `PI_ACTIVATION_MODE=maintenance` remains supported: it leaves acquisition, scheduler and repair timers stopped after deployment. With the variable absent, normal deployment restores the previously active background services. The old `scripts/deploy.sh` is historical Pi tooling and is not the active workflow.

Application releases are under `/opt/career-dashboard-releases/<commit>`, selected by the `/opt/career-dashboard` symlink. Runtime state is shared under `/var/lib/career-dashboard/data/runtime`. Discovery checkpoints and display logs also persist across release swaps. The current acquisition release file overrides the old source revision in the runtime environment for all background and web services. Checked-in scoring policies and canonical documents remain release-owned. Do not treat any policy or evidence version change as permission to invalidate existing scores.

The web unit supervises Next.js directly rather than through npm. The first production reboot exposed a three-minute shutdown delay with the npm wrapper. Direct supervision subsequently passed a production restart in 1.14 seconds, with health returning and no forced termination. The unit allows a 30-second graceful drain and treats Next's documented signal exit codes as successful shutdowns.

## Backups and recovery

Daily backups contain a PostgreSQL custom archive, an archive of application data and restricted runtime configuration, and a SHA-256 manifest. Local completed sets are kept for seven days. Off-host copies are kept for fourteen days in `/mnt/pgdata/career-dashboard.db-backups/m70` on the Pi SSD. The dedicated backup SSH key can upload through restricted rsync; it cannot open a shell or delete remote files. Configuration archives contain credentials and must remain private.

The frozen migration archive is retained separately on both hosts. Its SHA-256 is `33e89af93ccff1b131758aa2a597d0ccb50d580d6ad46ca86a870010633fb0bf`; it contains 4,685,523,363 bytes. Its source snapshot has **810,511 jobs and 586 Applied jobs**. All existing score fields, job status/history, acquisition receipts, saved pages and migration records matched before activation. The [complete row-comparison record](migrations/m70s/final-row-comparison-2026-09-02.json) covers all 50 tables and every archived column.

The Pi's public tables belong to a non-login archive owner. Its former application role can read those tables but cannot update them. The walking-map table retains its original role's write access. The old Dashboard systemd unit is disabled and guarded by an absent Pi-production marker; its managed pipeline cron is removed.

**Once the M70 accepts new writes, the Pi database is stale.** Never restart the Pi Dashboard as an automatic fallback. Recovery onto the Pi requires stopping target writers, copying or reconciling the newer M70 state, preserving any newer walking-map data, validating it and establishing one writable Dashboard authority again. A release rollback changes application routing; it does not restore an old database over newer user actions.

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
- The M70 Tailscale device key currently expires March 1, 2027. Its expiry policy has not been changed; the available browser session was not signed in to the admin console.
