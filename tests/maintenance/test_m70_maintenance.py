"""Exercise actual coordination code using temporary archives and fake services."""
import contextlib
import datetime as dt
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('maintenance', ROOT / 'scripts/deployment/m70-auto-maintenance.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
NOW = dt.datetime(2026, 10, 9, 10, 35, tzinfo=dt.timezone.utc)  # 05:35 Chicago
TABLES = '\n'.join('1; 0 1 TABLE DATA public ' + name + ' owner' for name in
                   ('Job', 'JobScoreEvent', 'JobScoringArtifact'))


class Fake(m.Coordinator):
    def __init__(self, state):
        super().__init__(state)
        self.events = []
        self.units = {'career-dashboard.service', 'walking-dashboard.service',
                      'career-dashboard-scheduler.timer', 'career-dashboard-acquisition.service'}
        self.loaded_units = set(self.units)
        self.clock = NOW
        self.boot = 'before'
        self.required = True
        self.drain_fails = False
        self.reboot_fails = False
        self.preflight_fails = False

    def now(self):
        return self.clock

    def boot_id(self):
        return self.boot

    def reboot_required(self):
        return self.required

    def active(self, unit):
        return unit in self.units

    def loaded(self, unit):
        return unit in self.loaded_units

    @contextlib.contextmanager
    def locks(self):
        self.events.append(('lock',))
        yield
        self.events.append(('unlock',))

    def command(self, args, **kwargs):
        self.events.append(tuple(args))
        if args == ['systemctl', 'reboot'] and self.reboot_fails:
            raise m.Deferred('Reboot command rejected.')
        return subprocess.CompletedProcess(args, 0, stdout='', stderr='')

    def systemctl(self, action, units):
        self.events.append((action, *units))
        if action == 'stop':
            self.units.difference_update(units)
        elif action == 'start':
            # Match the installed condition: background work stays held until health passes.
            if self.hold.exists() and set(units) & set(m.BACKGROUND):
                raise AssertionError('Started background work before lifting its maintenance hold')
            self.units.update(units)

    def preflight(self):
        self.events.append(('preflight',))
        if self.preflight_fails:
            raise m.Deferred('Backup failed verification.')
        return 'verified-backup', [unit for unit in m.FOREGROUND if unit in self.units]

    def check_health(self, units):
        self.events.append(('health', *units))
        if not set(units).issubset(self.units):
            raise m.Deferred('Dashboard did not recover.')

    def wait_idle(self, deadline):
        self.events.append(('drain',))
        if self.drain_fails:
            raise m.Deferred('Still active.')


class BackupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.base = 'm70-20261009T081500Z'
        (self.root / (self.base + '.dump')).write_bytes(b'PGDMP database fixture')
        with tarfile.open(self.root / (self.base + '.files.tar.gz'), 'w:gz') as archive:
            for name in ('career-dashboard/runtime.env', 'career-dashboard/acquisition-release.env', 'data/runtime'):
                member = tarfile.TarInfo(name)
                member.size = 4
                archive.addfile(member, io.BytesIO(b'test'))
        self.manifest()

    def manifest(self):
        lines = []
        for extension in ('.dump', '.files.tar.gz'):
            name = self.base + extension
            lines.append(hashlib.sha256((self.root / name).read_bytes()).hexdigest() + '  ' + name)
        (self.root / (self.base + '.sha256')).write_text('\n'.join(lines) + '\n')

    def verify(self, now=NOW, tables=TABLES):
        return m.verify_backup(self.root, now, lambda _: tables)

    def test_complete_fresh_backup_passes(self):
        self.assertEqual(self.verify(), self.base)

    def test_corrupt_database_defers(self):
        (self.root / (self.base + '.dump')).write_bytes(b'changed')
        with self.assertRaises(m.Deferred):
            self.verify()

    def test_corrupt_file_archive_defers(self):
        (self.root / (self.base + '.files.tar.gz')).write_bytes(b'changed')
        with self.assertRaises(m.Deferred):
            self.verify()

    def test_old_backup_defers(self):
        with self.assertRaises(m.Deferred):
            self.verify(NOW + dt.timedelta(days=2))

    def test_future_dated_backup_defers(self):
        with self.assertRaises(m.Deferred):
            self.verify(NOW - dt.timedelta(days=2))

    def test_partial_only_is_not_a_recovery_point(self):
        (self.root / (self.base + '.sha256')).unlink()
        (self.root / (self.base + '.dump.partial')).write_bytes(b'partial')
        with self.assertRaises(m.Deferred):
            self.verify()

    def test_manifest_cannot_escape_backup_directory(self):
        (self.root / (self.base + '.sha256')).write_text('0' * 64 + '  ../outside.dump\n')
        with self.assertRaises(m.Deferred):
            self.verify()

    def test_duplicate_manifest_entry_defers(self):
        manifest = self.root / (self.base + '.sha256')
        manifest.write_text(manifest.read_text() * 2)
        with self.assertRaises(m.Deferred):
            self.verify()

    def test_missing_score_data_defers(self):
        with self.assertRaises(m.Deferred):
            self.verify(tables=TABLES.replace('TABLE DATA public JobScoreEvent', 'TABLE public JobScoreEvent'))

    def test_incomplete_configuration_archive_defers(self):
        with tarfile.open(self.root / (self.base + '.files.tar.gz'), 'w:gz'):
            pass
        self.manifest()
        with self.assertRaises(m.Deferred):
            self.verify()

    def test_linked_archive_defers(self):
        path = self.root / (self.base + '.dump')
        path.rename(self.root / 'outside')
        path.symlink_to(self.root / 'outside')
        with self.assertRaises(m.Deferred):
            self.verify()

    def test_travel_backup_is_read_only_and_checked(self):
        path = self.root / 'travel-2026-10-09.sqlite'
        with sqlite3.connect(path) as connection:
            connection.execute('CREATE TABLE trips(id integer)')
        os.utime(path, (NOW.timestamp(), NOW.timestamp()))
        self.assertEqual(m.verify_travel_backup(self.root, NOW), path.name)
        with self.assertRaises(m.Deferred):
            m.verify_travel_backup(self.root, NOW + dt.timedelta(days=2))

    def test_corrupt_travel_backup_cannot_pass(self):
        path = self.root / 'travel-2026-10-09.sqlite'
        path.write_bytes(b'not sqlite')
        os.utime(path, (NOW.timestamp(), NOW.timestamp()))
        with self.assertRaises(sqlite3.DatabaseError):
            m.verify_travel_backup(self.root, NOW)


class CoordinationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.fake = Fake(Path(self.temp.name))
        self.output = contextlib.redirect_stdout(io.StringIO())
        self.output.__enter__()
        self.addCleanup(self.output.__exit__, None, None, None)

    def test_no_reboot_needed_does_not_stop_work_or_check_archives(self):
        self.fake.required = False
        self.fake.run()
        self.assertEqual(self.fake.events, [])

    def test_daytime_run_waits_without_touching_work(self):
        self.fake.clock = NOW + dt.timedelta(hours=7)
        self.fake.run()
        self.assertEqual(self.fake.events, [])
        self.assertEqual(json.loads((self.fake.state / 'status.json').read_text())['status'], 'scheduled')

    def test_check_only_never_stops_services_or_creates_pending_state(self):
        self.fake.run(check_only=True)
        self.assertFalse(self.fake.pending.exists())
        self.assertFalse(self.fake.hold.exists())
        self.assertNotIn(('systemctl', 'reboot'), self.fake.events)

    def test_failed_backup_never_stops_work(self):
        original = set(self.fake.units)
        self.fake.preflight_fails = True
        with self.assertRaises(m.Deferred):
            self.fake.run()
        self.assertEqual(self.fake.units, original)
        self.assertFalse(self.fake.pending.exists())

    def test_success_stops_admission_then_drains_before_reboot(self):
        self.fake.run()
        events = self.fake.events
        preflight = events.index(('preflight',))
        stop_timers = events.index(('stop', 'career-dashboard-scheduler.timer'))
        drain = events.index(('drain',))
        stop_web = events.index(('stop', 'career-dashboard.service', 'walking-dashboard.service'))
        reboot = events.index(('systemctl', 'reboot'))
        self.assertLess(preflight, stop_timers)
        self.assertLess(stop_timers, drain)
        self.assertLess(drain, stop_web)
        self.assertLess(stop_web, reboot)
        self.assertTrue(self.fake.pending.exists())
        self.assertTrue(self.fake.hold.exists())
        self.assertTrue((self.fake.state / 'skip-travel-dashboard.service').exists())
        quiesce = next(event for event in events if event[0] == 'curl')
        self.assertTrue(quiesce[-1].endswith('?mode=quiesce'))

    def test_drain_timeout_restores_exact_prior_service_state(self):
        original = set(self.fake.units)
        self.fake.drain_fails = True
        with self.assertRaises(m.Deferred):
            self.fake.run()
        self.assertEqual(self.fake.units, original)
        self.assertFalse(self.fake.pending.exists())
        self.assertFalse(self.fake.hold.exists())
        self.assertNotIn(('systemctl', 'reboot'), self.fake.events)

    def test_rejected_reboot_restores_dashboard_and_work(self):
        original = set(self.fake.units)
        self.fake.reboot_fails = True
        with self.assertRaises(m.Deferred):
            self.fake.run()
        self.assertEqual(self.fake.units, original)
        self.assertFalse(self.fake.pending.exists())

    def test_recovery_after_actual_boot_checks_health_before_background(self):
        original = set(self.fake.units)
        self.fake.run()
        self.fake.events.clear()
        self.fake.boot = 'after'
        self.fake.required = False
        self.fake.recover()
        self.assertEqual(self.fake.units, original)
        health = self.fake.events.index(('health', 'career-dashboard.service', 'walking-dashboard.service'))
        start_background = self.fake.events.index(('start', 'career-dashboard-scheduler.timer', 'career-dashboard-acquisition.service'))
        self.assertLess(health, start_background)
        self.assertFalse(self.fake.pending.exists())
        self.assertFalse((self.fake.state / 'skip-travel-dashboard.service').exists())
        self.assertEqual(json.loads((self.fake.state / 'status.json').read_text())['status'], 'healthy')

    def test_same_boot_recovery_does_not_request_another_reboot(self):
        self.fake.run()
        self.fake.events.clear()
        self.fake.run()
        self.assertNotIn(('systemctl', 'reboot'), self.fake.events)
        self.assertEqual(json.loads((self.fake.state / 'status.json').read_text())['status'], 'deferred')

    def test_a_restart_still_required_after_reboot_blocks_a_loop(self):
        self.fake.run()
        self.fake.boot = 'after'
        with self.assertRaises(m.Deferred):
            self.fake.recover()
        self.assertTrue((self.fake.state / 'reboot-blocked').exists())
        self.fake.events.clear()
        with self.assertRaises(m.Deferred):
            self.fake.run()
        self.assertNotIn(('systemctl', 'reboot'), self.fake.events)

    def test_recovery_refuses_an_unexpected_service(self):
        m.atomic_json(self.fake.pending, {'foreground': ['unexpected.service'], 'background': []})
        with self.assertRaises(m.Deferred):
            self.fake.recover()
        self.assertEqual(self.fake.events, [])

    def test_unhealthy_boot_keeps_background_held_and_recovery_state(self):
        self.fake.run()
        self.fake.boot = 'after'
        self.fake.check_health = lambda _: (_ for _ in ()).throw(m.Deferred('unhealthy'))
        with patch.object(m.time, 'monotonic', side_effect=[0, 200]), patch.object(m.time, 'sleep'):
            with self.assertRaises(m.Deferred):
                self.fake.recover()
        self.assertTrue(self.fake.pending.exists())
        self.assertTrue(self.fake.hold.exists())
        self.assertNotIn('career-dashboard-acquisition.service', self.fake.units)

    def test_window_expiry_restores_service_state(self):
        original = set(self.fake.units)
        self.fake.wait_idle = lambda _: setattr(self.fake, 'clock', NOW + dt.timedelta(hours=1))
        with self.assertRaises(m.Deferred):
            self.fake.run()
        self.assertEqual(self.fake.units, original)
        self.assertNotIn(('systemctl', 'reboot'), self.fake.events)

    def test_file_lock_contention_defers_without_waiting(self):
        real = m.Coordinator(self.fake.state)
        with patch.object(m, 'LOCKS', ()), patch.object(m, 'APT_LOCKS', ()):
            with real.locks():
                with self.assertRaises(m.Deferred):
                    with real.locks():
                        self.fail('Contending maintenance acquired the lock')

    def test_posix_package_lock_contention_defers(self):
        lock_path = self.fake.state / 'package.lock'
        lock_path.touch()
        child = subprocess.Popen(['python3', '-c',
            'import fcntl,sys; f=open(sys.argv[1],"r+b"); '
            'fcntl.lockf(f,fcntl.LOCK_EX); print("locked",flush=True); sys.stdin.read()',
            str(lock_path)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        try:
            self.assertEqual(child.stdout.readline().strip(), 'locked')
            with patch.object(m, 'LOCKS', ()), patch.object(m, 'APT_LOCKS', (str(lock_path),)):
                with self.assertRaises(m.Deferred):
                    with m.Coordinator(self.fake.state).locks():
                        self.fail('Maintenance bypassed an active POSIX package lock')
        finally:
            child.communicate('', timeout=5)

    def test_restoration_releases_backup_lock_before_resuming_timers(self):
        real = m.Coordinator(self.fake.state)
        backup_lock = self.fake.state / 'backup.lock'
        with patch.object(m, 'LOCKS', ('unused-deploy', str(backup_lock))), patch.object(m, 'APT_LOCKS', ()):
            # Avoid a lock outside the temporary fixture.
            with patch.object(m, 'LOCKS', (str(self.fake.state / 'deploy.lock'), str(backup_lock))):
                with real.locks():
                    real.release_background_locks()
                    with backup_lock.open('a+b') as stream:
                        m.fcntl.flock(stream, m.fcntl.LOCK_EX | m.fcntl.LOCK_NB)
                    with self.assertRaises(m.Deferred):
                        with m.Coordinator(self.fake.state).locks():
                            self.fail('Maintenance exclusion ended before restoration completed')

    def test_recovery_preserves_an_optional_dashboard_that_was_stopped(self):
        self.fake.run()
        self.fake.boot = 'after'
        self.fake.required = False
        self.fake.loaded_units.add('travel-dashboard.service')
        self.fake.units.add('travel-dashboard.service')
        self.fake.recover()
        self.assertNotIn('travel-dashboard.service', self.fake.units)

    def test_quiescence_check_is_read_only_and_cannot_reclaim_leases(self):
        real = m.Coordinator(self.fake.state)
        real.loaded = lambda _: False
        seen = []
        def command(args, **kwargs):
            seen.append(args)
            return subprocess.CompletedProcess(args, 1, stdout='', stderr='active work')
        real.command = command
        with patch.object(m.time, 'monotonic', side_effect=[0, 1000]), patch.object(m.time, 'sleep'):
            with self.assertRaises(m.Deferred):
                real.wait_idle(300)
        self.assertEqual(len(seen), 1)
        self.assertIn('scripts/deployment/quiescence-query.cjs', seen[0])
        self.assertFalse(any('reclaim' in part for part in seen[0]))

    def test_chicago_window_handles_summer_and_winter_offsets(self):
        self.assertTrue(m.within_window(NOW))
        self.assertFalse(m.within_window(NOW.replace(minute=29)))
        self.assertFalse(m.within_window(NOW.replace(hour=11, minute=0)))
        self.assertTrue(m.within_window(dt.datetime(2026, 12, 9, 11, 30, tzinfo=dt.timezone.utc)))


if __name__ == '__main__':
    unittest.main()
