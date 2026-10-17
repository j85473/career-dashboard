#!/usr/bin/env python3
"""Bound release retention and reserve room for the next complete backup."""
import argparse
import fcntl
import os
from pathlib import Path
import re
import shutil
import socket
import sys
import time

GIB = 1024 ** 3
REVISION = re.compile(r"[0-9a-f]{40}\Z")
RELEASES = Path('/opt/career-dashboard-releases')
SHARED = Path('/var/lib/career-dashboard')


def process_releases(proc_root=Path('/proc')):
    protected = set()
    for proc in proc_root.iterdir():
        if not proc.name.isdigit():
            continue
        try:
            values = [os.readlink(proc / 'cwd'), os.readlink(proc / 'exe'),
                      (proc / 'cmdline').read_bytes().decode(errors='replace')]
        except (FileNotFoundError, ProcessLookupError):
            continue
        # Root must be able to establish whether a release is in use.
        for value in values:
            protected.update(re.findall(r'/opt/career-dashboard-releases/([0-9a-f]{40})(?=/|\x00|\s|$)', value))
    return protected


def release_plan(root, protected, now=None):
    now = time.time() if now is None else now
    completed, abandoned = [], []
    for entry in root.iterdir():
        if not REVISION.fullmatch(entry.name) or entry.is_symlink() or not entry.is_dir():
            continue
        marker = entry / '.release-id'
        built = entry / '.m70-build-complete'
        accepted = not (entry / '.m70-activation-started').exists() or (entry / '.m70-activation-complete').is_file()
        if accepted and marker.is_file() and not marker.is_symlink() and marker.read_text().strip() == entry.name and built.is_file():
            completed.append((built.stat().st_mtime, entry))
        elif now - entry.stat().st_mtime > 24 * 3600:
            abandoned.append(entry)
    completed.sort(key=lambda item: (item[0], item[1].name), reverse=True)
    keep = set(protected) | {entry.name for _, entry in completed[:3]}
    return sorted([entry for _, entry in completed if entry.name not in keep] +
                  [entry for entry in abandoned if entry.name not in keep])


def backup_reserve(directory):
    dumps, files = [], []
    for entry in directory.iterdir():
        if entry.is_symlink() or not entry.is_file():
            continue
        if re.fullmatch(r'(?:m70|predeploy)-\d{8}T\d{6}Z\.dump', entry.name):
            dumps.append(entry.stat().st_size)
        if re.fullmatch(r'm70-\d{8}T\d{6}Z\.files\.tar\.gz', entry.name):
            files.append(entry.stat().st_size)
    return (max(dumps, default=8 * GIB) + max(files, default=GIB // 2)) * 5 // 4 + 5 * GIB


def check_capacity(directory, ssd, extra_bytes=0, extra_backup=False, disk_usage=shutil.disk_usage):
    if extra_bytes < 0:
        raise ValueError('Extra allocation must be nonnegative')
    reserve = backup_reserve(directory)
    for volume, required in ((directory, reserve * (2 if extra_backup else 1) + extra_bytes), (ssd, reserve)):
        free = disk_usage(volume).free
        print(f'Backup capacity on {volume}: {free} bytes free; {required} bytes required.', flush=True)
        if free < required:
            raise RuntimeError(f'Insufficient space on {volume}; preserving the next nightly backup reserve')


def protected_releases(extra):
    protected = set(extra) | process_releases()
    for link in ('/opt/career-dashboard', '/opt/career-dashboard.next', '/opt/career-dashboard.rollback'):
        path = Path(link)
        if path.is_symlink():
            target = path.resolve(strict=True)
            if target.parent == RELEASES:
                protected.add(target.name)
    for name in ('acquisition-release.env', 'acquisition-release.env.previous'):
        config = Path('/etc/career-dashboard') / name
        if config.exists():
            protected.update(re.findall(r'^ATS_WORKER_RELEASE_ID=([0-9a-f]{40})$', config.read_text(), re.M))
    return protected


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('cleanup', 'check-capacity'))
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--protect-release', action='append', default=[])
    parser.add_argument('--deploy-lock-held', action='store_true')
    parser.add_argument('--extra-bytes', type=int, default=0)
    parser.add_argument('--extra-backup', action='store_true')
    args = parser.parse_args()
    if os.geteuid() != 0 or socket.gethostname() != 'm70':
        raise RuntimeError('Run only as root on M70')
    args.protect_release = [Path(value).name for value in args.protect_release]
    if any(not REVISION.fullmatch(value) for value in args.protect_release):
        raise ValueError('Invalid protected release')
    if args.action == 'check-capacity':
        if not os.path.ismount('/mnt/backup'):
            raise RuntimeError('Backup SSD is not mounted')
        check_capacity(SHARED / 'backups', Path('/mnt/backup/m70'), args.extra_bytes, args.extra_backup)
        return
    with open(SHARED / 'deploy.lock', 'a') as lock:
        if not args.deploy_lock_held:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                print('Release cleanup deferred: a deployment owns the release lock.')
                return
        protected = protected_releases(args.protect_release)
        candidates = release_plan(RELEASES, protected)
        print(f'Release cleanup: {len(candidates)} obsolete directories; {len(protected)} protected references.', flush=True)
        for candidate in candidates:
            print(('Removing ' if args.apply else 'Would remove ') + str(candidate), flush=True)
            if args.apply:
                # rmtree does not follow data/runtime or configuration symlinks.
                # A root-directory symlink is refused, even if it appeared after planning.
                shutil.rmtree(candidate)


if __name__ == '__main__':
    try:
        main()
    except (OSError, RuntimeError, ValueError) as error:
        print(f'Storage maintenance failed: {error}', file=sys.stderr)
        sys.exit(1)
