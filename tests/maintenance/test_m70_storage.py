"""Exercise release retention and allocation budgets against real temporary files."""
import importlib.util
import os
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('storage', ROOT / 'scripts/deployment/m70-storage.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class StorageTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def release(self, number, complete=True, age=100000):
        directory = self.root / f'{number:040x}'
        directory.mkdir()
        if complete:
            (directory / '.release-id').write_text(directory.name + '\n')
            marker = directory / '.m70-build-complete'
            marker.touch()
            os.utime(marker, (number, number))
        os.utime(directory, (200000 - age, 200000 - age))
        return directory

    def test_keep_three_recent_completed_releases_and_every_in_use_release(self):
        releases = [self.release(n) for n in range(1, 7)]
        self.assertEqual(m.release_plan(self.root, {releases[0].name}, 200000), releases[1:3])

    def test_failed_builds_do_not_displace_rollback_and_recent_work_is_protected(self):
        releases = [self.release(n) for n in range(1, 5)]
        failed = self.release(5)
        (failed / '.m70-activation-started').touch()
        os.utime(failed, (100000, 100000))
        recent = self.release(6, complete=False, age=100)
        abandoned = self.release(7, complete=False)
        unrelated = self.root / 'manual-recovery'
        unrelated.mkdir()
        self.assertEqual(m.release_plan(self.root, set(), 200000), [releases[0], failed, abandoned])
        self.assertNotIn(recent, m.release_plan(self.root, set(), 200000))

    def test_deleting_release_does_not_follow_shared_runtime_symlink(self):
        shared = self.root / 'shared-runtime'
        shared.mkdir()
        (shared / 'history.json').write_text('retained history')
        releases = [self.release(n) for n in range(1, 5)]
        (releases[0] / 'runtime').symlink_to(shared, target_is_directory=True)
        (self.root / f'{9:040x}').symlink_to(shared, target_is_directory=True)
        for candidate in m.release_plan(self.root, set(), 200000):
            shutil.rmtree(candidate)
        self.assertEqual((shared / 'history.json').read_text(), 'retained history')

    def test_running_process_references_protect_old_release(self):
        proc = self.root / '123'
        proc.mkdir()
        revision = f'{1:040x}'
        (proc / 'cwd').symlink_to('/unrelated')
        (proc / 'exe').symlink_to('/usr/bin/node')
        (proc / 'cmdline').write_bytes(f'node\0/opt/career-dashboard-releases/{revision}/scripts/worker.js\0'.encode())
        self.assertEqual(m.process_releases(self.root), {revision})

    def test_allocate_test_database_and_deployment_snapshot_without_spending_nightly_reserve(self):
        backup = self.root / 'backups'
        ssd = self.root / 'ssd'
        backup.mkdir()
        ssd.mkdir()
        with (backup / 'predeploy-20261016T203049Z.dump').open('wb') as handle:
            handle.truncate(30 * m.GIB)
        with (backup / 'm70-20261016T081504Z.files.tar.gz').open('wb') as handle:
            handle.truncate(m.GIB)
        reserve = 31 * m.GIB * 5 // 4 + 5 * m.GIB
        usage = lambda _: shutil._ntuple_diskusage(300 * m.GIB, 0, 80 * m.GIB)
        self.assertEqual(m.backup_reserve(backup), reserve)
        m.check_capacity(backup, ssd, disk_usage=usage)
        with self.assertRaisesRegex(RuntimeError, 'nightly backup reserve'):
            m.check_capacity(backup, ssd, extra_backup=True, disk_usage=usage)
        with self.assertRaisesRegex(RuntimeError, 'nightly backup reserve'):
            m.check_capacity(backup, ssd, extra_bytes=112 * m.GIB, disk_usage=usage)
        with self.assertRaises(ValueError):
            m.check_capacity(backup, ssd, extra_bytes=-1, disk_usage=usage)

    def test_full_ssd_refuses_allocation_even_when_application_disk_has_room(self):
        backup = self.root / 'backups'
        ssd = self.root / 'ssd'
        backup.mkdir()
        ssd.mkdir()
        usage = lambda volume: shutil._ntuple_diskusage(300 * m.GIB, 0, (1 if volume == ssd else 200) * m.GIB)
        with self.assertRaisesRegex(RuntimeError, 'nightly backup reserve'):
            m.check_capacity(backup, ssd, disk_usage=usage)

    def test_incremental_nightly_budget_does_not_underreserve_a_full_migration_archive(self):
        backup, ssd = self.root / 'backups', self.root / 'ssd'
        backup.mkdir()
        ssd.mkdir()
        with (backup / 'predeploy-20261016T203049Z.dump').open('wb') as stream:
            stream.truncate(30 * m.GIB)
        usage = lambda _: shutil._ntuple_diskusage(300 * m.GIB, 0, 45 * m.GIB)
        with patch.object(m, 'backup_reserve', return_value=15 * m.GIB):
            m.check_capacity(backup, ssd, disk_usage=usage)
            with self.assertRaisesRegex(RuntimeError, 'nightly backup reserve'):
                m.check_capacity(backup, ssd, extra_backup=True, disk_usage=usage)


if __name__ == '__main__':
    unittest.main()
