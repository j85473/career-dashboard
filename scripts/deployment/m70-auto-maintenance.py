#!/usr/bin/env python3
"""Coordinate required Ubuntu reboots; never upgrade releases or restore data."""
import argparse
import contextlib
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import sqlite3
import subprocess
import tarfile
import time
import urllib.request
from zoneinfo import ZoneInfo

STATE = Path('/var/lib/m70-auto-maintenance')
APP = Path('/opt/career-dashboard')
BACKUPS = Path('/mnt/backup/m70')
HOLD = STATE / 'hold-background'
BACKGROUND = (
    'career-dashboard-scheduler.timer', 'career-dashboard-watchdog.timer',
    'career-dashboard-board-pruning.timer', 'career-dashboard-discovery.timer',
    'career-dashboard-canonical-resolver.timer', 'career-dashboard-gusto.timer',
    'career-dashboard-stats-warm.timer', 'career-dashboard-rotation-balance.timer',
    'career-dashboard-backup.timer', 'walking-dashboard-update.timer',
    'travel-dashboard-backup.timer', 'career-dashboard-acquisition.service',
    'career-dashboard-discovery-audit.service',
)
INVOCATIONS = tuple(unit.replace('.timer', '.service') for unit in BACKGROUND
                    if unit.endswith('.timer'))
FOREGROUND = ('career-dashboard.service', 'walking-dashboard.service', 'travel-dashboard.service')
LOCKS = (
    '/var/lib/career-dashboard/deploy.lock', '/var/lib/career-dashboard/backup.lock',
    '/run/lock/walking-dashboard-update.lock', '/run/lock/travel-dashboard-deploy.lock',
)
APT_LOCKS = ('/var/lib/dpkg/lock-frontend', '/var/lib/dpkg/lock',
             '/var/lib/apt/lists/lock', '/var/cache/apt/archives/lock')
HEALTH = {
    'career-dashboard.service': 'http://100.107.116.123:3000/api/health',
    'walking-dashboard.service': 'http://100.107.116.123:3005/api/health',
    'travel-dashboard.service': 'http://127.0.0.1:3006/api/health',
}


class Deferred(RuntimeError):
    pass


def atomic_json(path, value):
    temporary = path.with_suffix('.tmp')
    with temporary.open('w') as stream:
        json.dump(value, stream, indent=2)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)
    descriptor = os.open(path.parent, os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def within_window(now):
    local = now.astimezone(ZoneInfo('America/Chicago'))
    return local.hour == 5 and local.minute >= 30


def sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def verify_backup(directory, now, archive_list):
    """Only complete, fresh, exactly named archives can authorize a reboot."""
    candidates = sorted(directory.glob('m70-*.sha256'))
    if not candidates:
        raise Deferred('No completed Career Dashboard backup exists.')
    manifest = candidates[-1]
    match = re.fullmatch(r'm70-(\d{8}T\d{6}Z)\.sha256', manifest.name)
    if not match or manifest.is_symlink():
        raise Deferred('Unexpected backup manifest.')
    timestamp = dt.datetime.strptime(match[1], '%Y%m%dT%H%M%SZ').replace(tzinfo=dt.timezone.utc)
    age = (now - timestamp).total_seconds()
    if not 0 <= age <= 24 * 60 * 60:
        raise Deferred('The latest Career Dashboard backup is older than 24 hours or future-dated.')
    base = manifest.name.removesuffix('.sha256')
    expected = {base + '.dump', base + '.files.tar.gz'}
    hashes = {}
    for line in manifest.read_text().splitlines():
        parsed = re.fullmatch(r'([0-9a-f]{64}) [ *]([^/]+)', line)
        if not parsed or parsed[2] not in expected or parsed[2] in hashes:
            raise Deferred('The backup manifest does not identify exactly one database and file archive.')
        hashes[parsed[2]] = parsed[1]
    if hashes.keys() != expected:
        raise Deferred('The backup set is incomplete.')
    for name, digest in hashes.items():
        path = directory / name
        if path.is_symlink() or not path.is_file() or path.stat().st_size == 0:
            raise Deferred('A completed backup archive is missing or empty.')
        if sha256(path) != digest:
            raise Deferred('A backup checksum failed; no reboot will be attempted.')
    listing = archive_list(directory / (base + '.dump'))
    for table in ('Job', 'JobScoreEvent', 'JobScoringArtifact'):
        if not re.search(r' TABLE DATA public ' + table + r' ', listing):
            raise Deferred('The database archive lacks required job or score data.')
    with tarfile.open(directory / (base + '.files.tar.gz'), 'r:gz') as archive:
        names = {member.name.rstrip('/') for member in archive}
    if not {'career-dashboard/runtime.env', 'career-dashboard/acquisition-release.env',
            'data/runtime'}.issubset(names):
        raise Deferred('The file archive lacks required runtime state or configuration.')
    return base


def verify_travel_backup(directory, now):
    candidates = sorted(directory.glob('travel-*.sqlite'))
    if not candidates:
        raise Deferred('No completed Travel Dashboard metadata backup exists.')
    latest = candidates[-1]
    age = now.timestamp() - latest.stat().st_mtime
    if latest.is_symlink() or not 0 <= age <= 24 * 60 * 60:
        raise Deferred('The Travel Dashboard backup is stale or unsafe.')
    with sqlite3.connect(latest.as_uri() + '?mode=ro', uri=True) as connection:
        if connection.execute('PRAGMA quick_check').fetchall() != [('ok',)]:
            raise Deferred('The Travel Dashboard metadata backup failed its integrity check.')
    return latest.name


class Coordinator:
    def __init__(self, state=STATE):
        self.state = state
        self.pending = state / 'pending.json'
        self.hold = state / 'hold-background'
        self.lock_streams = {}

    def now(self):
        return dt.datetime.now(dt.timezone.utc)

    def boot_id(self):
        return Path('/proc/sys/kernel/random/boot_id').read_text().strip()

    def reboot_required(self):
        return Path('/run/reboot-required').exists()

    def command(self, args, timeout=30, check=True, cwd=None):
        result = subprocess.run(args, text=True, capture_output=True, timeout=timeout, cwd=cwd,
                                env={**os.environ, 'PATH': '/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'})
        if check and result.returncode:
            # Do not persist arbitrary subprocess output: it may contain private data.
            raise Deferred('A required command failed: ' + Path(args[0]).name)
        return result

    def unit_state(self, unit):
        return self.command(['systemctl', 'show', unit, '-p', 'ActiveState', '--value']).stdout.strip()

    def loaded(self, unit):
        return self.command(['systemctl', 'show', unit, '-p', 'LoadState', '--value']).stdout.strip() == 'loaded'

    def active(self, unit):
        return self.unit_state(unit) in ('active', 'activating', 'reloading', 'deactivating')

    def systemctl(self, action, units):
        if units:
            self.command(['systemctl', action, *units], timeout=240)

    def write_status(self, status, reason, **details):
        atomic_json(self.state / 'status.json', {
            'status': status, 'reason': reason, 'checked_at': self.now().isoformat(), **details,
        })
        print(status + ': ' + reason, flush=True)

    def read_pending(self):
        value = json.loads(self.pending.read_text())
        if set(value['background']) - set(BACKGROUND) or set(value['foreground']) - set(FOREGROUND):
            raise Deferred('Maintenance recovery state contains unexpected units.')
        return value

    @contextlib.contextmanager
    def locks(self):
        with contextlib.ExitStack() as stack:
            for path in (str(self.state / 'maintenance.lock'), *LOCKS):
                stream = stack.enter_context(open(path, 'a+b'))
                try:
                    fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError as error:
                    raise Deferred('A deployment, backup, or maintenance run is already active.') from error
                self.lock_streams[path] = stream
            # APT/dpkg use POSIX locks, not flock. Hold them until reboot is requested.
            for path in APT_LOCKS:
                stream = stack.enter_context(open(path, 'r+b'))
                try:
                    fcntl.lockf(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError as error:
                    raise Deferred('Package installation is running; reboot deferred.') from error
            yield

    def release_background_locks(self):
        # Persistent backup/update timers may fire as soon as they restart. Let
        # them acquire their own locks; keep Career deployment and maintenance
        # excluded until restoration has finished.
        for path in LOCKS[1:]:
            stream = self.lock_streams.pop(path, None)
            if stream:
                stream.close()

    def check_health(self, units):
        for unit in units:
            if not self.active(unit):
                raise Deferred('A previously running dashboard has not started: ' + unit)
            with urllib.request.urlopen(HEALTH[unit], timeout=10) as response:
                payload = json.load(response)
            if unit == 'career-dashboard.service':
                healthy = all(payload.get(key) is True for key in ('ok', 'database', 'schema', 'migration'))
            else:
                healthy = payload.get('status') == 'ok'
            if not healthy:
                raise Deferred('A dashboard failed its health check: ' + unit)
        if not self.active('tailscaled.service') or not self.active('postgresql@17-main.service'):
            raise Deferred('Private access or the PostgreSQL database is unavailable.')

    def preflight(self):
        if not self.active('career-dashboard.service'):
            raise Deferred('The Career Dashboard is intentionally stopped or unhealthy.')
        foreground = [unit for unit in FOREGROUND if self.loaded(unit) and self.active(unit)]
        self.check_health(foreground)
        if not os.path.ismount('/mnt/backup'):
            raise Deferred('The backup SSD is not mounted.')
        backup = verify_backup(BACKUPS, self.now(), lambda path: self.command(
            ['/usr/lib/postgresql/17/bin/pg_restore', '--list', str(path)], timeout=60).stdout)
        if 'travel-dashboard.service' in foreground:
            verify_travel_backup(Path('/media/nas/travel-dashboard/backups'), self.now())
        return backup, foreground

    def wait_idle(self, deadline):
        while time.monotonic() < deadline:
            if not any(self.loaded(unit) and self.active(unit) for unit in INVOCATIONS):
                result = self.command(['runuser', '-u', 'career-dashboard', '--', 'env',
                    'QUIESCENCE_GATE_MODE=runtime', 'node', 'scripts/with-env.mjs',
                    'node', 'scripts/deployment/quiescence-query.cjs'],
                    timeout=40, check=False, cwd=APP)
                if result.returncode == 0:
                    return
            time.sleep(5)
        raise Deferred('Active database work did not drain within five minutes.')

    def restore(self, pending):
        # Keep background admission blocked until the Dashboard can serve requests.
        self.systemctl('stop', [unit for unit in FOREGROUND if unit not in pending['foreground']
                               and self.loaded(unit) and self.active(unit)])
        self.systemctl('start', pending['foreground'])
        deadline = time.monotonic() + 180
        while True:
            try:
                self.check_health(pending['foreground'])
                break
            except Exception:
                if time.monotonic() >= deadline:
                    raise Deferred('Dashboards did not recover; background work remains held.')
                time.sleep(5)
        self.release_background_locks()
        self.hold.unlink(missing_ok=True)
        self.systemctl('start', pending['background'])
        for unit in pending['background']:
            if not self.active(unit):
                raise Deferred('A previously running background unit did not recover: ' + unit)
        for unit in FOREGROUND:
            (self.state / ('skip-' + unit)).unlink(missing_ok=True)
        self.pending.unlink()

    def recover(self):
        if not self.pending.exists():
            return
        pending = self.read_pending()
        rebooted = self.boot_id() != pending['boot_id']
        self.restore(pending)
        if rebooted and self.reboot_required():
            (self.state / 'reboot-blocked').touch(mode=0o600)
            self.write_status('attention', 'The reboot completed, but Ubuntu still requests a restart.')
            raise Deferred('Another restart is requested; review before another automatic reboot.')
        self.write_status('healthy' if rebooted else 'deferred',
                          'Required reboot completed and services recovered.' if rebooted else
                          'Interrupted maintenance restored the previous service state.',
                          backup=pending['backup'], rebooted=rebooted)

    def run(self, check_only=False):
        if self.pending.exists():
            if check_only:
                raise Deferred('An unfinished maintenance run needs recovery.')
            with self.locks():
                self.recover()
            return
        if (self.state / 'reboot-blocked').exists():
            raise Deferred('A prior reboot did not clear the restart request; automatic reboots are held for review.')
        if not self.reboot_required():
            if not check_only:
                self.write_status('healthy', 'Security updates need no reboot.')
            return
        if not check_only and not within_window(self.now()):
            self.write_status('scheduled', 'A required reboot will wait for the 05:30 Chicago window.')
            return
        with self.locks():
            backup, foreground = self.preflight()
            if check_only:
                print(json.dumps({'ready': True, 'backup': backup, 'foreground': foreground}))
                return
            background = [unit for unit in BACKGROUND if self.loaded(unit) and self.active(unit)]
            pending = {'boot_id': self.boot_id(), 'backup': backup,
                       'foreground': foreground, 'background': background}
            atomic_json(self.pending, pending)
            for unit in FOREGROUND:
                if unit not in foreground:
                    (self.state / ('skip-' + unit)).touch(mode=0o600)
            self.hold.touch(mode=0o600)
            self.command(['sync', '-f', str(self.state)])
            reboot_requested = False
            try:
                self.systemctl('stop', [unit for unit in background if unit.endswith('.timer')])
                # The existing quiesce endpoint preserves schedulePaused and pausedUntil.
                self.command(['curl', '-fsS', '--max-time', '15', '-X', 'POST',
                              HEALTH['career-dashboard.service'].replace('/api/health', '/api/pipeline/stop?mode=quiesce')])
                self.systemctl('stop', [unit for unit in background if unit.endswith('.service')])
                self.wait_idle(time.monotonic() + 300)
                # Close visitor write routes before the final read-only quiescence gate.
                self.systemctl('stop', foreground)
                self.wait_idle(time.monotonic() + 60)
                if not within_window(self.now()):
                    raise Deferred('Draining exceeded the maintenance window; reboot deferred.')
                self.write_status('rebooting', 'Verified recovery point and idle work; requesting reboot.', backup=backup)
                self.command(['systemctl', 'reboot'], timeout=20)
                reboot_requested = True
            finally:
                if not reboot_requested:
                    self.restore(pending)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=('run', 'check', 'recover', 'status'))
    args = parser.parse_args()
    if args.mode == 'status':
        print((STATE / 'status.json').read_text() if (STATE / 'status.json').exists() else
              json.dumps({'status': 'not-run'}))
        return 0
    if os.geteuid() != 0 or socket.gethostname() != 'm70':
        parser.error('Only root on m70 may run maintenance or recovery.')
    if not Path('/etc/career-dashboard/automatic-maintenance-enabled').exists() and not (
            args.mode == 'recover' and (STATE / 'pending.json').exists()):
        parser.error('Standing maintenance authorization is not enabled.')
    if args.mode in ('run', 'check') and not Path('/etc/career-dashboard/production-enabled').exists():
        parser.error('The production gate is not enabled.')
    coordinator = Coordinator()
    try:
        if args.mode == 'recover':
            with coordinator.locks():
                coordinator.recover()
        else:
            coordinator.run(check_only=args.mode == 'check')
        return 0
    except Exception as error:
        if args.mode != 'check':
            coordinator.write_status('attention' if coordinator.pending.exists() else 'deferred',
                                     str(error) if isinstance(error, Deferred) else
                                     'Maintenance failed safely; inspect the service journal.')
        else:
            print('Readiness check failed: ' + (str(error) if isinstance(error, Deferred) else type(error).__name__))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
