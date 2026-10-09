# Automatic M70 security maintenance

Local implementation prepared October 8, 2026. Building and testing this feature
does not authorize deployment or enable scheduled reboots.

Ubuntu's existing daily unattended security updates remain responsible for
installing security patches. This coordinator finishes patches that require a
reboot, at 05:30 America/Chicago. It does not upgrade Ubuntu releases, run a
general package upgrade, deploy applications, delete backups, restore database
snapshots, clear leases, or change score authority.

## Scheduled behavior

The timer does nothing when Ubuntu has no required reboot. A required reboot
must begin and be requested within 05:30–05:59 Chicago time. Missed windows do
not trigger a daytime catch-up reboot. Chicago daylight saving changes are
handled by both systemd's calendar and the coordinator's time check.

Before stopping work, the coordinator obtains the Career deployment and backup
locks, the Walking and Travel deployment locks, and the POSIX APT/dpkg locks. It
checks the running dashboards, database and Tailscale. A completed Career backup
on the mounted backup SSD must be no more than 24 hours old. Both archive hashes,
required database table data, runtime files, and configuration are checked. The
whole database dump also retains the Walking schema. If Travel is running, its
recent SQLite metadata backup must pass a read-only integrity check. Original
Travel media remains on its existing NAS storage; the routine does not copy it.

It then records which background services and timers were running, holds new
background admissions, and calls the existing pipeline quiesce endpoint. That
endpoint preserves operator pause intent. Acquisition and the durable discovery
audit receive their normal service stop signals. Existing scheduled invocations
may finish for up to five minutes. The repository's read-only runtime quiescence
gate must pass; expired leases are not cleared or reinterpreted by this routine.
The visitor-facing dashboards stop before one final gate and the reboot request.

After boot, persisted conditions hold background work until the previously
running dashboards pass health checks. The recovery service then restores only
the previously running background units. Optional dashboards that were stopped
are held through that boot. A recovery timer retries interrupted runs every ten
minutes, including interruptions that did not reboot the server. A rejected
reboot or failed drain restores the prior service state. An unhealthy boot leaves
background work held and the failure recorded. If a completed reboot still leaves
Ubuntu asking for a restart, further automatic reboots are blocked for review.

Manual scoring exports and existing job scores survive maintenance. An import
or browser request submitted during the brief outage may need to be retried.

## Installation and standing authorization

The GitHub release path installs the coordinator and unit files with
`--install-only`; it does not enable the timer or create standing authorization.
The same installation helper is used when restoring a prior compatible release.
On an approved deployment, enable the scheduled policy once, from the released
checkout:

```sh
sudo bash /opt/career-dashboard/scripts/deployment/install-m70-maintenance.sh --enable
```

This enables Ubuntu's existing security-update timers, explicitly keeps Ubuntu's
own automatic reboot option false, creates the standing-authorization marker,
and enables maintenance and recovery. It does not reboot immediately. Future
routine runs require no fresh approval. A deployment may refresh the installed
coordinator but preserves its existing timer enablement and authorization.

The installer refuses to replace a running coordinator or unfinished recovery
state. The coordinator runs only as root on the M70 and only with its standing
authorization present. Recovery remains allowed for an already pending run if
that authorization was removed, so disabling maintenance cannot strand work.

## Review and operational checks

```sh
sudo /usr/local/sbin/m70-auto-maintenance check
sudo /usr/local/sbin/m70-auto-maintenance status
systemctl list-timers m70-auto-maintenance.timer m70-maintenance-recover.timer
journalctl -u m70-auto-maintenance -u m70-maintenance-recover --no-pager -n 80
```

`check` validates readiness without stopping services or requesting a reboot.
It takes coordination locks during the check. It does not modify jobs or scores.
Status and unfinished recovery state live outside application releases, under
`/var/lib/m70-auto-maintenance`. Deferrals and failures produce a failed service
result and a readable reason; a successful no-op or completed recovery is quiet.
There is no external notification channel in this implementation. A separately
authorized monitor can read this status and report failures or host unavailability.

To disable future scheduled maintenance, stop and disable the maintenance timer
and remove `/etc/career-dashboard/automatic-maintenance-enabled`. Leave recovery
enabled while any pending run exists. Remove a `reboot-blocked` marker only after
reviewing why the preceding reboot did not clear Ubuntu's restart request.

## Validation

The Python behavioral suite uses temporary backup archives and fake services to
exercise fresh and damaged backups, missing score data, manifest traversal,
SQLite integrity, time windows, lock contention, drain failure, refused reboots,
boot recovery, unhealthy startup, preservation of stopped services, and loop
prevention. It executes through the normal repository test command. A successful
local test does not establish a real reboot or deployed behavior; those require
an approved release and live maintenance verification.
