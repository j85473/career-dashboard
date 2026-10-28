"""Failure and retention tests use actual temporary receipts and archive files."""
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('repository_backup', ROOT / 'scripts/deployment/m70-repository-backup.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class RepositoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.local, self.ssd = self.root / 'local', self.root / 'ssd'
        for directory in (self.local, self.ssd):
            (directory / 'recovery-points').mkdir(parents=True)
            (directory / 'repository').mkdir()
        self.commands = []
        self.engine = m.RepositoryBackup(self.local, self.ssd, self.root / 'key', floor=0)
        self.engine.command = lambda command, **_: self.commands.append(command) or ''
        self.engine.validate_point_snapshots = lambda point: None
        self.engine.forget_snapshots = lambda disk, ids: self.engine.command(self.engine.restic(disk, 'forget', *ids))

    def receipt(self, day, added=1, disks=('local', 'ssd')):
        point = f'm70-202610{day:02d}T081500Z'
        value = {'format': 'restic-v1', 'point': point, 'addedBytes': added,
                 'snapshots': {disk: {'database': f'{day:064x}', 'files': f'{day + 100:064x}'}
                               for disk in ('local', 'ssd')},
                 'sha256': {'database': 'a' * 64, 'files': 'b' * 64}}
        for disk in disks:
            m.atomic_json(self.engine.base(disk) / 'recovery-points' / (point + '.json'), value)
        return value

    def legacy(self, day):
        point = f'm70-202610{day:02d}T081500Z'
        for directory in (self.local, self.ssd):
            manifest = []
            for extension in ('.dump', '.files.tar.gz'):
                data = (point + extension).encode()
                (directory / (point + extension)).write_bytes(data)
                manifest.append(hashlib.sha256(data).hexdigest() + '  ' + point + extension)
            (directory / (point + '.sha256')).write_text('\n'.join(manifest) + '\n')
        return point

    def test_one_disk_and_conflicting_receipts_never_authorize_retention(self):
        self.receipt(1, disks=('local',))
        second = self.receipt(2)
        path = self.ssd / 'recovery-points' / (second['point'] + '.json')
        path.write_text(path.read_text() + '\n')
        self.assertEqual(m.paired_points(self.local, self.ssd), [])

    def test_invalid_snapshot_or_growth_fails_closed(self):
        value = self.receipt(1)
        for field, change in [('snapshots', {'local': {'database': '../outside', 'files': 'a' * 64}}),
                              ('addedBytes', -1)]:
            bad = dict(value, **{field: change})
            for directory in (self.local, self.ssd):
                m.atomic_json(directory / 'recovery-points' / (value['point'] + '.json'), bad)
            with self.assertRaises((RuntimeError, KeyError)):
                m.paired_points(self.local, self.ssd)

    def test_reserve_accounts_for_seed_then_recent_incremental_additions(self):
        self.receipt(1, 30 * m.GIB)
        self.assertEqual(m.repository_reserve(self.local, self.ssd), 30 * m.GIB * 5 // 4 + m.FLOOR)
        for day in (2, 3, 4):
            self.receipt(day, m.GIB)
        self.assertEqual(m.repository_reserve(self.local, self.ssd), 8 * m.GIB * 5 // 4 + m.FLOOR)

    def test_no_paired_receipt_cannot_enable_an_incremental_budget(self):
        self.receipt(1, disks=('local',))
        with self.assertRaises(RuntimeError):
            m.repository_reserve(self.local, self.ssd)

    def test_migration_keeps_three_complete_points_across_both_formats(self):
        oldest = self.legacy(1)
        retained = [self.legacy(day) for day in (2, 3)]
        self.receipt(4)
        self.engine.retain()
        for directory in (self.local, self.ssd):
            self.assertFalse((directory / (oldest + '.dump')).exists())
            for point in retained:
                self.assertTrue((directory / (point + '.dump')).is_file())
        self.assertEqual(len(m.paired_points(self.local, self.ssd) + m.legacy_points(self.local, self.ssd)), 3)
        self.assertTrue(any('--read-data' in command for command in self.commands))

    def test_corrupt_survivor_stops_before_any_recovery_point_is_deleted(self):
        points = [self.legacy(day) for day in (1, 2, 3)]
        self.receipt(4)
        (self.ssd / (points[1] + '.dump')).write_bytes(b'corrupt')
        with self.assertRaises(RuntimeError):
            self.engine.retain()
        for directory in (self.local, self.ssd):
            for point in points:
                self.assertTrue((directory / (point + '.dump')).is_file())

    def test_repository_read_failure_stops_before_retention(self):
        points = [self.legacy(day) for day in (1, 2, 3)]
        self.receipt(4)
        def fail(*_, **__):
            raise RuntimeError('repository corruption')
        self.engine.command = fail
        with self.assertRaises(RuntimeError):
            self.engine.retain()
        self.assertTrue(all((self.local / (point + '.dump')).exists() for point in points))

    def test_retention_forgets_exact_old_snapshot_ids_and_preserves_receipts_for_audit(self):
        points = [self.receipt(day) for day in (1, 2, 3, 4, 5)]
        self.engine.retain()
        self.assertEqual([point['point'] for point in m.paired_points(self.local, self.ssd)],
                         [point['point'] for point in points[2:]])
        forgotten = [command[command.index('forget') + 1:] for command in self.commands if 'forget' in command]
        self.assertEqual(len(forgotten), 4)
        self.assertEqual({snapshot for command in forgotten for snapshot in command},
                         {snapshot for point in points[:2] for snapshot in point['snapshots']['local'].values()})
        self.assertTrue((self.ssd / 'retired-recovery-points' / (points[0]['point'] + '.json')).exists())

    def test_unmatched_local_history_and_one_disk_receipts_stay_protected(self):
        for day in (1, 2, 3, 4):
            self.receipt(day)
        unmatched = self.local / 'm70-20260901T081500Z.dump'
        unmatched.write_bytes(b'historical archive')
        one_disk = self.receipt(5, disks=('local',))
        self.engine.retain()
        self.assertEqual(unmatched.read_bytes(), b'historical archive')
        self.assertTrue((self.local / 'recovery-points' / (one_disk['point'] + '.json')).exists())

    def test_emergency_floor_rejects_writes_before_the_disk_fills(self):
        self.engine.floor = 5 * m.GIB
        usage = shutil._ntuple_diskusage(100 * m.GIB, 96 * m.GIB, 4 * m.GIB)
        with patch.object(m.shutil, 'disk_usage', return_value=usage), self.assertRaises(RuntimeError):
            self.engine.space('local')

    def test_backup_publishes_nothing_when_copy_or_independent_restore_fails(self):
        for failure in ('copy', 'verify'):
            with self.subTest(failure=failure):
                self.engine.stream_backup = lambda command, point, kind, env: ('a' * 64, 'b' * 64, {})
                self.engine.snapshots_for = lambda disk, point: {'database': 'a' * 64, 'files': 'c' * 64}
                def command(args, **_):
                    if failure == 'copy' and 'copy' in args:
                        raise RuntimeError('copy failed')
                    return ''
                def verify(disk, *args):
                    if failure == 'verify' and disk == 'ssd':
                        raise RuntimeError('independent restore failed')
                self.engine.command, self.engine.verify = command, verify
                with self.assertRaises(RuntimeError):
                    self.engine.backup(['producer'], ['files'], point='m70-20261028T081500Z')
                self.assertEqual(m.paired_points(self.local, self.ssd), [])
                self.assertEqual(list((self.local / 'recovery-points').iterdir()), [])

    def test_secret_is_environment_only_and_full_database_is_never_filtered(self):
        with patch.dict(m.os.environ, {'DATABASE_URL': 'postgresql://backup:p%24ss@127.0.0.1:5432/career_db'}):
            command, env = m.database_producer()
        self.assertEqual(env['PGPASSWORD'], 'p$ss')
        self.assertNotIn('p$ss', ' '.join(command))
        self.assertIn('--compress=0', command)
        self.assertFalse(any(value.startswith('--table') or value.startswith('--exclude') for value in command))

    def test_missing_recovery_key_never_generates_a_replacement_for_existing_data(self):
        (self.local / 'repository' / 'config').write_text('existing encrypted repository')
        with self.assertRaisesRegex(RuntimeError, 'escrowed key'):
            self.engine.initialize()
        self.assertFalse(self.engine.key.exists())

    def test_missing_repository_with_existing_receipts_requires_recovery(self):
        self.receipt(1)
        self.engine.key.write_text('test key')
        self.engine.key.chmod(0o600)
        with self.assertRaisesRegex(RuntimeError, 'Repository is missing'):
            self.engine.initialize()

    def test_receipt_cannot_count_a_snapshot_that_disappeared(self):
        point = self.receipt(1)
        self.engine.command = lambda *args, **kwargs: '[]'
        with self.assertRaisesRegex(RuntimeError, 'missing snapshot'):
            m.RepositoryBackup.validate_point_snapshots(self.engine, point)

    def test_interrupted_publication_is_completed_only_after_both_restore_checks(self):
        point = self.receipt(1, disks=('local',))
        verified = []
        self.engine.verify = lambda disk, *args: verified.append(disk)
        self.engine.reconcile_publication()
        self.assertEqual(verified, ['local', 'ssd'])
        self.assertEqual(m.paired_points(self.local, self.ssd), [point])

    def test_failed_restore_keeps_an_interrupted_receipt_one_sided(self):
        self.receipt(1, disks=('local',))
        def fail(*args):
            raise RuntimeError('restore failed')
        self.engine.verify = fail
        with self.assertRaises(RuntimeError):
            self.engine.reconcile_publication()
        self.assertEqual(m.paired_points(self.local, self.ssd), [])

    def test_abandoned_cleanup_protects_unpublished_receipts_and_unknown_snapshots(self):
        for day in (10, 11, 12):
            self.receipt(day)
        self.receipt(2, disks=('local',))
        snapshots = [
            {'id': 'a' * 64, 'tags': ['career-nightly', 'm70-20261001T081500Z', 'database']},
            {'id': 'b' * 64, 'tags': ['career-nightly', 'm70-20261002T081500Z', 'database']},
            {'id': 'c' * 64, 'tags': ['unrelated', 'database']},
        ]
        def command(args, **_):
            self.commands.append(args)
            return json.dumps(snapshots) if 'snapshots' in args else ''
        self.engine.command = command
        self.engine.cleanup_unpublished()
        forgotten = [command[command.index('forget') + 1:] for command in self.commands if 'forget' in command]
        self.assertEqual(forgotten, [['a' * 64], ['a' * 64]])

    def test_retirement_resumes_when_one_disk_already_forgot_the_snapshot(self):
        self.engine.command = lambda *args, **kwargs: '[]'
        m.RepositoryBackup.forget_snapshots(self.engine, 'local', ['a' * 64])

    def test_interrupted_retirement_is_never_republished_as_a_live_point(self):
        point = self.receipt(1)
        root = self.local / 'retired-recovery-points'
        root.mkdir()
        path = self.local / 'recovery-points' / (point['point'] + '.json')
        path.replace(root / path.name)
        self.engine.reconcile_publication()
        self.assertEqual(m.paired_points(self.local, self.ssd), [])
        self.assertTrue((self.ssd / 'retired-recovery-points' / path.name).exists())

    def test_partial_legacy_deletion_resumes_from_its_journal(self):
        oldest = self.legacy(1)
        for day in (2, 3):
            self.legacy(day)
        self.receipt(4)
        def interrupted(point):
            (self.local / (point['point'] + '.dump')).unlink()
            raise RuntimeError('simulated interruption after first deletion')
        self.engine.retire_point = interrupted
        with self.assertRaises(RuntimeError):
            self.engine.retain()
        self.assertTrue((self.ssd / (oldest + '.dump')).exists())
        self.engine.retire_point = lambda point: m.RepositoryBackup.retire_point(self.engine, point)
        self.engine.retain()
        for directory in (self.local, self.ssd):
            self.assertFalse((directory / (oldest + '.dump')).exists())
            self.assertEqual(list((directory / 'retiring-recovery-points').iterdir()), [])
            self.assertTrue((directory / 'retired-recovery-points' / (oldest + '.json')).exists())


if __name__ == '__main__':
    unittest.main()
