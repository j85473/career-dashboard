#!/usr/bin/env python3
"""Paired, encrypted, deduplicated PostgreSQL recovery points for M70.

Only a receipt published on BOTH disks makes a point eligible for retention.
The database stream remains a complete native pg_restore archive. Compression
belongs to restic so unchanged chunks can be shared across complete snapshots.
"""
import argparse
import contextlib
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import tarfile
import tempfile
import time
from urllib.parse import parse_qs, unquote, urlparse

GIB = 1024 ** 3
FLOOR = 5 * GIB
STAMP = re.compile(r'm70-\d{8}T\d{6}Z\Z')
SNAPSHOT = re.compile(r'[a-f0-9]{8,64}\Z')
APP = Path('/opt/career-dashboard')
LOCAL = Path('/var/lib/career-dashboard/backups')
SSD = Path('/mnt/backup/m70')
KEY = Path('/etc/career-dashboard/backup-repository.key')
ENABLED = Path('/etc/career-dashboard/backup-repository-enabled')
REQUIRED_TABLES = ('Job', 'JobScoreEvent', 'JobScoringArtifact')


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_suffix('.partial')
    with temporary.open('w') as stream:
        os.chmod(temporary, 0o600)
        json.dump(value, stream, indent=2)
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)
    descriptor = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def sha256_file(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(4 * 1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def paired_points(local=LOCAL, ssd=SSD):
    """Never count an incomplete, conflicting, or one-disk receipt."""
    points = []
    for path in sorted((local / 'recovery-points').glob('m70-*.json')):
        if not STAMP.fullmatch(path.stem) or path.is_symlink():
            continue
        other = ssd / 'recovery-points' / path.name
        if other.is_symlink() or not other.is_file() or path.read_bytes() != other.read_bytes():
            continue
        value = json.loads(path.read_text())
        if value.get('format') != 'restic-v1' or value.get('point') != path.stem:
            raise RuntimeError('Invalid recovery receipt: ' + path.name)
        for disk in ('local', 'ssd'):
            for kind in ('database', 'files'):
                if not SNAPSHOT.fullmatch(value['snapshots'][disk][kind]):
                    raise RuntimeError('Invalid snapshot in recovery receipt')
        for kind in ('database', 'files'):
            if not re.fullmatch(r'[a-f0-9]{64}', value['sha256'][kind]):
                raise RuntimeError('Invalid checksum in recovery receipt')
        if not isinstance(value.get('addedBytes'), int) or value['addedBytes'] < 0:
            raise RuntimeError('Invalid repository growth in recovery receipt')
        points.append(value)
    return points


def legacy_points(local=LOCAL, ssd=SSD):
    points = []
    for manifest in sorted(ssd.glob('m70-*.sha256')):
        base = manifest.stem
        if not STAMP.fullmatch(base) or manifest.is_symlink():
            continue
        names = [base + extension for extension in ('.dump', '.files.tar.gz', '.sha256')]
        if not all((directory / name).is_file() and not (directory / name).is_symlink()
                   for directory in (local, ssd) for name in names):
            continue
        if manifest.read_bytes() != (local / manifest.name).read_bytes():
            continue  # Unmatched historical files remain protected.
        points.append({'point': base, 'format': 'legacy'})
    return points


def retention_plan(points, keep=3):
    ordered = sorted(points, key=lambda point: point['point'], reverse=True)
    if len({point['point'] for point in ordered}) != len(ordered):
        raise RuntimeError('Conflicting recovery point identities')
    return ordered[:keep], ordered[keep:] if len(ordered) > keep else []


def repository_reserve(local=LOCAL, ssd=SSD):
    points = sorted(paired_points(local, ssd), key=lambda point: point['point'], reverse=True)[:3]
    if not points:
        raise RuntimeError('Repository mode has no paired, verified recovery point')
    # Charge the seed while it is recent. Once three incremental turns exist,
    # budget their largest actual addition with growth allowance and an 8 GiB
    # minimum, plus the separate hard 5 GiB emergency floor enforced at runtime.
    addition = max(8 * GIB, *(point['addedBytes'] for point in points))
    return addition * 5 // 4 + FLOOR


class RepositoryBackup:
    def __init__(self, local=LOCAL, ssd=SSD, key=KEY, app=APP, floor=FLOOR):
        self.local, self.ssd, self.key, self.app, self.floor = local, ssd, key, app, floor
        self.active = set()

    def base(self, disk):
        return self.local if disk == 'local' else self.ssd

    def restic(self, disk, *args):
        return ['restic', '--repo', str(self.base(disk) / 'repository'),
                '--password-file', str(self.key), '--no-cache', *args]

    def space(self, *disks):
        for disk in disks:
            if shutil.disk_usage(self.base(disk)).free < self.floor:
                raise RuntimeError('Backup stopped before consuming the emergency reserve on ' + disk)

    def stop(self, process):
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()

    def spawn(self, args, **kwargs):
        process = subprocess.Popen(args, start_new_session=True, **kwargs)
        self.active.add(process)
        return process

    def close(self):
        for process in self.active:
            self.stop(process)

    def progress(self, phase, processed=0):
        atomic_json(self.local.parent / 'ops' / 'backup-progress.json', {
            'phase': phase, 'processedBytes': processed,
            'updatedAt': dt.datetime.now(dt.timezone.utc).isoformat(),
        })

    def command(self, args, disks=(), env=None):
        with tempfile.TemporaryFile() as output:
            process = self.spawn(args, stdout=output, stderr=output, env=env)
            try:
                while process.poll() is None:
                    self.space(*disks)
                    time.sleep(1)
                output.seek(0)
                result = output.read().decode(errors='replace')
                if process.returncode:
                    raise RuntimeError('Backup command failed: ' + Path(args[0]).name + '\n' + result[-4000:])
                return result
            finally:
                self.stop(process)

    def initialize(self):
        self.key.parent.mkdir(parents=True, exist_ok=True)
        if not self.key.exists():
            if any((self.base(disk) / 'repository' / 'config').exists() for disk in ('local', 'ssd')):
                raise RuntimeError('Restore the escrowed key; never replace the key of an existing repository')
            descriptor = os.open(self.key, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, 'w') as stream:
                stream.write(secrets.token_hex(32) + '\n')
                stream.flush()
                os.fsync(stream.fileno())
        if not self.key.is_file() or self.key.is_symlink() or self.key.stat().st_mode & 0o077:
            raise RuntimeError('Repository key must be a private regular file')
        for disk in ('local', 'ssd'):
            base = self.base(disk)
            if base.is_symlink() or (base / 'repository').is_symlink():
                raise RuntimeError('Refusing a symlinked repository')
            if any((base / name).is_symlink() for name in
                   ('recovery-points', 'retired-recovery-points', 'retiring-recovery-points')):
                raise RuntimeError('Refusing symlinked recovery metadata')
            (base / 'recovery-points').mkdir(exist_ok=True, mode=0o700)
            if not (base / 'repository' / 'config').exists():
                if list((base / 'recovery-points').glob('*.json')):
                    raise RuntimeError('Repository is missing but recovery receipts exist; recovery is required')
                args = ['init', '--repository-version', '2']
                if disk == 'ssd':
                    args += ['--from-repo', str(self.local / 'repository'),
                             '--from-password-file', str(self.key), '--copy-chunker-params']
                self.command(self.restic(disk, *args), disks=(disk,))
            # Normal unlock removes stale locks only, never a live lock. The
            # outer production backup lock excludes our own concurrent writers.
            self.command(self.restic(disk, 'unlock'))
            self.command(self.restic(disk, 'check'))

    def validate_point_snapshots(self, point):
        for disk in ('local', 'ssd'):
            expected = point['snapshots'][disk]
            snapshots = json.loads(self.command(self.restic(disk, '--json', 'snapshots', *expected.values())))
            if len(snapshots) != 2:
                raise RuntimeError('Recovery receipt references a missing snapshot')
            for kind, identity in expected.items():
                if not any(snapshot['id'].startswith(identity) and kind in snapshot.get('tags', [])
                           and point['point'] in snapshot.get('tags', []) for snapshot in snapshots):
                    raise RuntimeError('Recovery receipt references the wrong snapshot')

    def forget_snapshots(self, disk, identities):
        # Retention is resumable after a crash between disks. A snapshot already
        # forgotten on one side is success, while ambiguous prefixes fail closed.
        existing = json.loads(self.command(self.restic(disk, '--json', 'snapshots')))
        selected = []
        for identity in identities:
            matches = [snapshot['id'] for snapshot in existing if snapshot['id'].startswith(identity)]
            if len(matches) > 1:
                raise RuntimeError('Ambiguous retired snapshot identity')
            selected.extend(matches)
        if selected:
            self.command(self.restic(disk, 'forget', *selected))

    def stream_backup(self, producer, point, kind, env=None):
        filename = 'database.dump' if kind == 'database' else 'files.tar.gz'
        with tempfile.TemporaryFile() as errors, tempfile.TemporaryFile() as result:
            source = self.spawn(producer, stdout=subprocess.PIPE, stderr=errors, env=env)
            target = self.spawn(self.restic('local', '--json', 'backup', '--stdin',
                '--stdin-filename', filename, '--host', 'm70', '--tag', 'career-nightly',
                '--tag', point, '--tag', kind), stdin=subprocess.PIPE, stdout=result, stderr=errors)
            digest = hashlib.sha256()
            processed, report_at = 0, 0.0
            try:
                for block in iter(lambda: source.stdout.read(1024 * 1024), b''):
                    self.space('local')
                    digest.update(block)
                    target.stdin.write(block)
                    processed += len(block)
                    if time.monotonic() >= report_at:
                        self.progress('saving-' + kind, processed)
                        print(f'Saving {kind}: {processed / GIB:.1f} GiB streamed', flush=True)
                        report_at = time.monotonic() + 60
                target.stdin.close()
                if source.wait() or target.wait():
                    errors.seek(0)
                    raise RuntimeError('Incomplete backup stream; previous recovery points preserved.\n'
                                       + errors.read().decode(errors='replace')[-4000:])
                result.seek(0)
                summaries = [json.loads(line) for line in result if b'"summary"' in line]
                snapshot = summaries[-1]['snapshot_id']
                if not SNAPSHOT.fullmatch(snapshot):
                    raise RuntimeError('Missing completed snapshot')
                return snapshot, digest.hexdigest(), summaries[-1]
            finally:
                self.stop(source)
                self.stop(target)

    def snapshots_for(self, disk, point):
        snapshots = json.loads(self.command(self.restic(disk, '--json', 'snapshots', '--tag', point)))
        result = {}
        for kind in ('database', 'files'):
            matches = [snapshot['id'] for snapshot in snapshots if kind in snapshot.get('tags', [])]
            if len(matches) != 1:
                raise RuntimeError('Incomplete or ambiguous copied recovery point')
            result[kind] = matches[0]
        return result

    def verify(self, disk, snapshots, checksums):
        for kind, snapshot in snapshots.items():
            filename = 'database.dump' if kind == 'database' else 'files.tar.gz'
            with tempfile.TemporaryFile() as errors, tempfile.TemporaryFile() as files, \
                    tempfile.NamedTemporaryFile() as prefix:
                source = self.spawn(self.restic(disk, 'dump', snapshot, filename),
                                    stdout=subprocess.PIPE, stderr=errors)
                # pg_restore decodes every table without connecting to a DB.
                decoder = self.spawn(['pg_restore', '--file=/dev/null'], stdin=subprocess.PIPE,
                                     stdout=subprocess.DEVNULL, stderr=errors) if kind == 'database' else None
                digest = hashlib.sha256()
                processed, report_at = 0, 0.0
                try:
                    for block in iter(lambda: source.stdout.read(1024 * 1024), b''):
                        digest.update(block)
                        if decoder and prefix.tell() < 32 * 1024 * 1024:
                            prefix.write(block)
                        if not decoder:
                            self.space('local')
                        (decoder.stdin if decoder else files).write(block)
                        processed += len(block)
                        if time.monotonic() >= report_at:
                            self.progress('verifying-' + disk + '-' + kind, processed)
                            print(f'Verifying {disk} {kind}: {processed / GIB:.1f} GiB restored', flush=True)
                            report_at = time.monotonic() + 60
                    if decoder:
                        decoder.stdin.close()
                    if source.wait() or (decoder and decoder.wait()):
                        raise RuntimeError('Restored archive failed decoding on ' + disk)
                    if digest.hexdigest() != checksums[kind]:
                        raise RuntimeError('Restored archive checksum mismatch on ' + disk)
                    if decoder:
                        prefix.flush()
                        listing = self.command(['pg_restore', '--list', prefix.name])
                        for table in REQUIRED_TABLES:
                            if not re.search(r'TABLE DATA public ' + table + r'\s', listing):
                                raise RuntimeError('Recovery archive is missing protected table ' + table)
                    if not decoder:
                        files.seek(0)
                        with tarfile.open(fileobj=files, mode='r:gz') as archive:
                            names = set(archive.getnames())
                            if not {'career-dashboard/runtime.env', 'career-dashboard/acquisition-release.env',
                                    'data/runtime'}.issubset(names):
                                raise RuntimeError('Recovery configuration archive is incomplete')
                    print('Verified complete ' + kind + ' restore stream on ' + disk, flush=True)
                finally:
                    self.stop(source)
                    if decoder:
                        self.stop(decoder)

    def verify_legacy(self, point):
        base = point['point']
        for disk in ('local', 'ssd'):
            directory = self.base(disk)
            lines = (directory / (base + '.sha256')).read_text().splitlines()
            expected = {base + '.dump', base + '.files.tar.gz'}
            if len(lines) != 2:
                raise RuntimeError('Invalid legacy manifest')
            for line in lines:
                digest, name = line.split('  ', 1)
                if name not in expected or sha256_file(directory / name) != digest:
                    raise RuntimeError('Retained legacy archive failed verification')
                expected.remove(name)

    def retain(self):
        pending = {}
        for disk in ('local', 'ssd'):
            for path in (self.base(disk) / 'retiring-recovery-points').glob('m70-*.json'):
                point = json.loads(path.read_text())
                if not STAMP.fullmatch(path.stem) or point.get('point') != path.stem:
                    raise RuntimeError('Invalid retirement journal')
                if path.stem in pending and pending[path.stem] != point:
                    raise RuntimeError('Conflicting retirement journals')
                pending[path.stem] = point
        points = [point for point in paired_points(self.local, self.ssd) + legacy_points(self.local, self.ssd)
                  if point['point'] not in pending]
        keep, remove = retention_plan(points)
        if not remove and not pending:
            return
        if len(keep) < 3:
            raise RuntimeError('Three surviving recovery points are required before completing retention')
        # One full repository scan validates shared chunks across ALL retained
        # snapshots; shared data is never removed by a retention decision.
        for disk in ('local', 'ssd'):
            self.command(self.restic(disk, 'check', '--read-data'), disks=(disk,))
        for point in keep:
            if point['format'] == 'legacy':
                self.verify_legacy(point)
            else:
                self.validate_point_snapshots(point)
        for point in [*remove, *pending.values()]:
            if point['point'] in {survivor['point'] for survivor in keep}:
                raise RuntimeError('Retirement would affect a retained recovery point')
            for disk in ('local', 'ssd'):
                atomic_json(self.base(disk) / 'retiring-recovery-points' / (point['point'] + '.json'), point)
            self.retire_point(point)
            print('Retired older verified recovery point ' + point['point'], flush=True)
        for disk in ('local', 'ssd'):
            self.command(self.restic(disk, 'prune', '--max-repack-size', '1G'), disks=(disk,))
            self.command(self.restic(disk, 'check'))

    def retire_point(self, point):
        # The journals are durable before the first deletion. Each operation is
        # idempotent, including a crash halfway through a legacy file set.
        if point['format'] == 'legacy':
            for disk in ('local', 'ssd'):
                for extension in ('.dump', '.files.tar.gz', '.sha256'):
                    path = self.base(disk) / (point['point'] + extension)
                    if path.is_symlink():
                        raise RuntimeError('Refusing symlinked retired archive')
                    path.unlink(missing_ok=True)
        elif point['format'] == 'restic-v1':
            for disk in ('local', 'ssd'):
                identities = point['snapshots'][disk].values()
                if not all(SNAPSHOT.fullmatch(identity) for identity in identities):
                    raise RuntimeError('Invalid retired snapshot identities')
                self.forget_snapshots(disk, point['snapshots'][disk].values())
        else:
            raise RuntimeError('Unknown retirement format')
        for disk in ('local', 'ssd'):
            atomic_json(self.base(disk) / 'retired-recovery-points' / (point['point'] + '.json'), point)
            (self.base(disk) / 'recovery-points' / (point['point'] + '.json')).unlink(missing_ok=True)
        for disk in ('local', 'ssd'):
            (self.base(disk) / 'retiring-recovery-points' / (point['point'] + '.json')).unlink(missing_ok=True)

    def reconcile_publication(self):
        """Finish a crash-interrupted receipt publication after re-verification."""
        for disk, other in (('local', 'ssd'), ('ssd', 'local')):
            for path in (self.base(disk) / 'recovery-points').glob('m70-*.json'):
                destination = self.base(other) / 'recovery-points' / path.name
                if destination.exists() or not STAMP.fullmatch(path.stem) or path.is_symlink():
                    continue
                point = json.loads(path.read_text())
                if point.get('format') != 'restic-v1' or point.get('point') != path.stem:
                    raise RuntimeError('Invalid interrupted recovery receipt')
                if any((self.base(side) / 'retiring-recovery-points' / path.name).exists()
                       for side in ('local', 'ssd')):
                    continue
                retired = self.base(other) / 'retired-recovery-points' / path.name
                if retired.exists():
                    if retired.read_bytes() != path.read_bytes():
                        raise RuntimeError('Conflicting interrupted retirement receipt')
                    own_retired = self.base(disk) / 'retired-recovery-points'
                    own_retired.mkdir(exist_ok=True, mode=0o700)
                    path.replace(own_retired / path.name)
                    continue
                self.validate_point_snapshots(point)
                for verify_disk in ('local', 'ssd'):
                    self.verify(verify_disk, point['snapshots'][verify_disk], point['sha256'])
                atomic_json(destination, point)
                print('Recovered interrupted receipt publication ' + point['point'], flush=True)

    def cleanup_unpublished(self):
        # Only abandoned attempts owned by THIS backup engine are eligible.
        # A receipt on either disk protects an interrupted publication. Unknown
        # snapshots and all three completed recovery points remain untouched.
        points = paired_points(self.local, self.ssd) + legacy_points(self.local, self.ssd)
        if len(points) < 3:
            return
        cutoff = dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=24)
        for disk in ('local', 'ssd'):
            snapshots = json.loads(self.command(self.restic(disk, '--json', 'snapshots', '--tag', 'career-nightly')))
            remove = []
            for snapshot in snapshots:
                tags = snapshot.get('tags', [])
                names = [tag for tag in tags if STAMP.fullmatch(tag)]
                if len(names) != 1 or not ({'database', 'files'} & set(tags)):
                    continue
                point = names[0]
                age = dt.datetime.strptime(point, 'm70-%Y%m%dT%H%M%SZ').replace(tzinfo=dt.timezone.utc)
                if age >= cutoff or any((self.base(side) / 'recovery-points' / (point + '.json')).exists()
                                        for side in ('local', 'ssd')):
                    continue
                # Published, retired points are handled by retain(), never here.
                if any((self.base(side) / 'retired-recovery-points' / (point + '.json')).exists()
                       for side in ('local', 'ssd')):
                    continue
                if not SNAPSHOT.fullmatch(snapshot['id']):
                    raise RuntimeError('Invalid abandoned snapshot identity')
                remove.append(snapshot['id'])
            if remove:
                self.command(self.restic(disk, 'forget', *remove))
                self.command(self.restic(disk, 'prune', '--max-repack-size', '1G'), disks=(disk,))
                self.command(self.restic(disk, 'check'))

    def backup(self, producer, files_producer, env=None, point=None):
        point = point or dt.datetime.now(dt.timezone.utc).strftime('m70-%Y%m%dT%H%M%SZ')
        if not STAMP.fullmatch(point):
            raise RuntimeError('Invalid recovery point name')
        self.space('local', 'ssd')
        self.reconcile_publication()
        before = sum(path.stat().st_size for path in (self.local / 'repository').rglob('*') if path.is_file())
        snapshots, checksums = {}, {}
        for kind, command in (('database', producer), ('files', files_producer)):
            snapshot, digest, _ = self.stream_backup(command, point, kind, env)
            snapshots[kind], checksums[kind] = snapshot, digest
        self.verify('local', snapshots, checksums)
        after = sum(path.stat().st_size for path in (self.local / 'repository').rglob('*') if path.is_file())
        added = max(0, after - before)
        # Seed/copy capacity uses the ACTUAL newly stored bytes, not the full
        # logical database size. Every write also enforces the hard disk floor.
        if shutil.disk_usage(self.ssd).free < added * 5 // 4 + self.floor:
            raise RuntimeError('SSD lacks space for the verified repository additions; originals preserved')
        self.command(self.restic('ssd', 'copy', '--from-repo', str(self.local / 'repository'),
            '--from-password-file', str(self.key), *snapshots.values()), disks=('local', 'ssd'))
        copied = self.snapshots_for('ssd', point)
        self.verify('ssd', copied, checksums)
        receipt = {'format': 'restic-v1', 'point': point,
                   'completedAt': dt.datetime.now(dt.timezone.utc).isoformat(),
                   'snapshots': {'local': snapshots, 'ssd': copied}, 'sha256': checksums,
                   'addedBytes': added}
        # A crash between these writes leaves a one-disk receipt, which is
        # explicitly excluded from retention, freshness, and capacity decisions.
        for disk in ('local', 'ssd'):
            atomic_json(self.base(disk) / 'recovery-points' / (point + '.json'), receipt)
        self.retain()
        self.cleanup_unpublished()
        self.progress('complete')
        print(json.dumps({'verifiedRecoveryPoint': point, 'addedBytes': added}), flush=True)
        return receipt


def database_producer():
    url = urlparse(os.environ.get('DATABASE_URL', ''))
    if url.scheme not in ('postgres', 'postgresql') or not url.hostname or not url.username or not url.path.strip('/'):
        raise RuntimeError('A valid database connection is required')
    env = dict(os.environ)
    env['PGPASSWORD'] = unquote(url.password or '')
    if 'sslmode' in parse_qs(url.query):
        env['PGSSLMODE'] = parse_qs(url.query)['sslmode'][0]
    return ['pg_dump', '--format=custom', '--compress=0', '--no-owner', '--no-privileges',
            '--host', url.hostname, '--port', str(url.port or 5432),
            '--username', unquote(url.username), '--dbname', unquote(url.path.lstrip('/'))], env


@contextlib.contextmanager
def production_lock():
    if os.geteuid() != 0 or socket.gethostname() != 'm70' or not os.path.ismount('/mnt/backup'):
        raise RuntimeError('Run only as root on M70 with the backup SSD mounted')
    if Path('/var/lib/m70-auto-maintenance/hold-background').exists():
        raise RuntimeError('Automatic maintenance owns the background hold')
    with open('/var/lib/career-dashboard/backup.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('prepare', 'backup', 'bootstrap', 'verify-latest', 'status'))
    args = parser.parse_args()
    engine = RepositoryBackup()
    for signum in (signal.SIGTERM, signal.SIGINT):
        signal.signal(signum, lambda *_: (_ for _ in ()).throw(InterruptedError('Backup interrupted')))
    try:
        if args.action == 'status':
            reserve = repository_reserve()
            print(json.dumps({'recoveryPoints': [point['point'] for point in paired_points() + legacy_points()],
                              'nextBackupReserveBytes': reserve,
                              'freeBytes': {disk: shutil.disk_usage(engine.base(disk)).free for disk in ('local', 'ssd')}}, indent=2))
            return
        if args.action == 'verify-latest':
            points = sorted(paired_points(), key=lambda point: point['point'])
            if not points:
                raise RuntimeError('No paired repository recovery point')
            point = points[-1]
            age = dt.datetime.now(dt.timezone.utc) - dt.datetime.strptime(point['point'], 'm70-%Y%m%dT%H%M%SZ').replace(tzinfo=dt.timezone.utc)
            if age.total_seconds() < 0 or age > dt.timedelta(hours=24):
                raise RuntimeError('Repository recovery point is stale or future-dated')
            engine.verify('ssd', point['snapshots']['ssd'], point['sha256'])
            print(point['point'])
            return
        with production_lock():
            os.chdir(APP)
            engine.command(['python3', 'scripts/deployment/m70-storage.py', 'cleanup', '--apply'])
            engine.initialize()
            if args.action == 'prepare':
                print('Repositories prepared; scheduling and existing recovery points are unchanged.')
                return
            escrow = KEY.with_suffix('.escrow-sha256')
            if not escrow.is_file() or escrow.read_text().strip() != sha256_file(KEY):
                raise RuntimeError('Export and verify the recovery key on the Mac before migrating backup retention')
            with tempfile.TemporaryDirectory(prefix='repository-runtime-', dir=LOCAL) as temporary:
                snapshot = Path(temporary) / 'runtime-snapshot'
                engine.command(['node', 'scripts/deployment/snapshot-backup-runtime.mjs', 'data/runtime', str(snapshot)])
                shutil.copystat(APP / 'data/runtime', snapshot)
                runtime_stat = (APP / 'data/runtime').stat()
                for root, directories, files in os.walk(snapshot):
                    for path in [Path(root), *(Path(root) / name for name in directories + files)]:
                        os.chown(path, runtime_stat.st_uid, runtime_stat.st_gid)
                files = ['tar', '--dereference', '--exclude=data/runtime', '--exclude=data/discover_logs.txt',
                         '--transform=s,^runtime-snapshot,data/runtime,', '-czf', '-',
                         '-C', str(APP), 'data', '-C', '/etc',
                         'career-dashboard/runtime.env', 'career-dashboard/acquisition-release.env',
                         '-C', temporary, 'runtime-snapshot']
                producer, env = database_producer()
                engine.backup(producer, files, env)
            if args.action == 'bootstrap':
                if ENABLED.exists():
                    raise RuntimeError('Repository mode is already enabled; use backup instead')
                atomic_json(ENABLED, {'format': 'restic-v1', 'enabledAt': dt.datetime.now(dt.timezone.utc).isoformat()})
                print('Repository backup enabled after independent verification on both disks.', flush=True)
    finally:
        engine.close()


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, RuntimeError, InterruptedError) as error:
        print('Backup failed safely: ' + str(error), file=sys.stderr)
        sys.exit(1)
