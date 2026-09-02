> Historical preparation record. The authorized production transfer has now passed the final restore and all-table comparison. See [current M70 operations](M70_PRODUCTION_OPERATIONS.md) for the live host, services, release process, backups and remaining acceptance checks. Statements below about the Pi still serving production describe the earlier preparation stage.

# M70s Ubuntu Server: selected direction and preparation

Decision recorded September 2, 2026; updated at the first verified remote login. Ubuntu is installed and local-network SSH works. Production has not migrated.

## Accepted decisions

- Use Ubuntu Server on the Lenovo ThinkCentre M70s.
- Keep the interactive Claude and Codex applications on Joseph's Mac. Native Codex mobile hosting on the M70s is no longer a requirement.
- Design around the existing 16 GB RAM. A memory upgrade is not a prerequisite or an assumed future dependency.
- Operate the server remotely after initial setup; Joseph may use a TV for installation but does not want a daily desktop workflow.
- Remote inspection now confirms the i5-10400 (six cores, twelve threads), 16 GB memory class, and 480 GB PNY CS900 SSD. The recorded SSD health assessment passed; this is not a lifetime guarantee.

## Target user-visible behavior

The M70s should host the production Dashboard and its authoritative PostgreSQL database. Joseph should be able to browse and mark jobs Applied from his phone while the Mac is off. Those changes commit directly to the server database and are visible from the Mac when it reconnects.

Claude and Codex on the Mac administer the server through an authenticated remote command connection. They do not need to run on the server to manage it when the Mac is available. With the Mac off, the Dashboard and configured server services can remain available, but Mac-hosted agent sessions are unavailable.

Interactive AI applications and unattended acquisition processes are different workloads. The earlier inspection found eight ATS acquisition slots running on the Mac. Keeping the AI applications on the Mac does not settle where those acquisition processes should run. Inventory and migrate any processes required for Mac-independent pipeline operation before claiming that the whole pipeline works with the Mac off. Preserve existing provider limits and concurrency initially.

## Consequences for the earlier proposal

- The Mac-primary database and Pi replication design is superseded as the default architecture.
- Ordinary edits while the Mac is off no longer require a special offline action journal, because the always-on server owns both the Dashboard and database.
- This does not provide continued edits during an M70s failure. Pi failover or a durable offline-edit feature for a server outage remains a separate availability decision; do not promise it as part of basic migration.
- Keep the Pi production system available during preparation and restore rehearsal. Plan a single writable authority at cutover and a rollback procedure that accounts for any writes made after cutover. Do not silently resume an outdated Pi database.

## Preparation completed September 2

Joseph completed Ubuntu Server 24.04.4 LTS installation onto the internal PNY SSD, replacing Windows, and removed the Toshiba installer. The hostname is `m70`, display name Joe Lamb, account `j85473`. At 19:24 UTC, separate SSH sessions from the Mac succeeded using its existing public key at `192.168.1.26`. The internal root filesystem has about 409 GiB available, the system clock is synchronized, and no systemd units are failed. See the [target inspection record](migrations/m70s/target-host-2026-09-02.txt). The TV prompt is still not visible to Joseph, although the console login service is active and logs show keyboard input reached it. This has not blocked SSH access. Passwordless administration is now verified in fresh SSH sessions; no password was requested in chat or stored.

The authorized Toshiba writer completed at 18:51:29 UTC with full read-back checksum verification and safe ejection. See the [installation-media verification record](migrations/m70s/installer-media-verification.json). Base preparation completed at 19:27:44 UTC: Ubuntu administration/build/SMART tools, Chicago timezone and the source database locale are installed. The SSD passes its recorded overall health assessment with no ATA error-log entries, zero reported uncorrectable errors and 21% endurance used; this is not a new self-test or future reliability guarantee. Root inspection found the login prompt in the console buffer, supporting a TV display/cropping explanation. Runtime installation completed at 19:34:32 UTC. Node 24.20.0, npm 11.19.0, PostgreSQL 17.11 and Tailscale 1.102.3 are verified. Tailscale enrollment and SSH to its private address, 100.107.116.123, are working. The Mac alias is `ssh m70`. Production migration remains later.

- Rechecked the live Pi: Dashboard health passes, Node is 24.19.0, PostgreSQL is 17.10, the application is on microSD, and the database is on the external SSD.
- Captured a read-only database baseline: approximately 17.6 GB, 809,169 jobs, 586 Applied, and existing score counts. These are dated observations, not the eventual cutover totals.
- Found 49 public tables and an additional walking-map table in a separate schema. A whole-database backup preserves both; moving the walking application is not implied.
- Checked the existing backup archive's table of contents. Its transfer checksum matches, the isolated restore completed in 745 seconds, and field-level fingerprints match for every archived column across all 50 tables. The current live source will need its own final frozen backup and comparison at cutover.
- Identified the Pi-specific release workflow, the Mac-only acquisition wrapper, the Mac repair watchdog, and the separate legacy Python scheduler that must be accounted for during a write freeze.
- Prepared read-only database and Ubuntu-host inspection tools, dormant service drafts, and the [operator migration runbook](migrations/m70s/RUNBOOK.md). No existing production code, configuration, data, or services were changed.
- Downloaded the Ubuntu Server 24.04.4 amd64 installer to the Mac and matched its SHA-256 against Canonical's HTTPS checksum list. The [verification record](migrations/m70s/installer-verification.json) identifies the local image. The Toshiba external HDD has now been written and verified as installation media.

The Mac acquisition LaunchAgent was not loaded at the latest inspection. Its saved configuration requests eight slots; the live database had zero unexpired slot leases. The Mac repair watchdog remains registered on a 15-minute interval. Its latest logged check reports stopped acquisition and no repairs. Both its schedule and repair ledger are explicitly covered in the runbook and dormant M70 service/timer drafts. The historical native scoring watcher remains retired: its executable/installer/LaunchAgent are absent and only old logs remain. A separate Codex ATS cutover automation is paused and contains obsolete Pi/Mac instructions; it must not be resumed blindly. These live processes were not changed during preparation.

## Preparation still required

1. The isolated restore, all-table comparison, fresh Linux build, initial application reads and detection-only watchdog rehearsal passed. Next complete application write/pipeline behavior, browser dependencies and production release/runtime permissions. The dedicated `career-dashboard` service account cannot use sudo; production services remain disabled.
2. A software reboot passed: private SSH, passwordless administration, Tailscale and PostgreSQL returned automatically without a TV login. Verify private phone access away from home and Tailscale expiry policy. Firmware reports “Last State” after power loss, but physical power-loss recovery/display-disconnected boot has not been tested. TV prompt visibility remains unresolved even though its console-buffer presence is confirmed.
3. Refresh the captured database baseline at the actual migration time. Repeat the successful logical-restore procedure with the final frozen snapshot; do not copy the Pi's ARM database directory. Verify locale behavior and preserve all scores/history against that matching source.
4. All four service/timer drafts passed Ubuntu syntax validation. Finish production credentials, persistent-file, walking-map dependency, and all-writer fencing checks. Verify the actual eight-slot acquisition service and pipeline within 16 GB RAM.
5. Implement and rehearse the release-workflow changes identified in the runbook, including acquisition stop/restart and release identity. The current workflow still targets the Pi; choosing Ubuntu has not redirected deployments.
6. Validate the restored Dashboard, representative reads/writes, existing scores, Applied behavior, and pipeline recovery before an authorized production cutover. Keep development copies and production services separate.
7. Verify Mac-off operation, phone access, server restart recovery, and backups after activation. Distinguish web/database availability from full unattended acquisition and processing.

Preserve existing scores, application decisions, history, and acquisition evidence. Do not introduce a Dashboard login screen. No production settings, data, services, or deployment targets were changed while recording this decision.

## Earlier evidence

The [earlier inspection report](MAC_PRIMARY_PI_REPLICA_BUILD_READINESS_2026-09-02.md) contains the September 2 Mac/Pi hardware and PostgreSQL findings. Treat these as a dated baseline and refresh the operational facts during migration preparation.
