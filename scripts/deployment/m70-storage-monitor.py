#!/usr/bin/env python3
"""Observe the database filesystem without depending on PostgreSQL availability."""
import fcntl
import calendar
import json
import os
from pathlib import Path
import socket
import sys
import time

GIB = 1024 ** 3
STATE = Path('/var/lib/career-dashboard/data/runtime/storage-pressure.json')
HISTORY = Path('/var/lib/career-dashboard/data/runtime/storage-capacity-history.json')


def pressure(free, prior):
    critical = free < 15 * GIB or (prior.get('backgroundPaused', False) and free < 20 * GIB)
    paused = critical or free < 30 * GIB or (prior.get('collectionPaused', False) and free < 40 * GIB)
    return critical, paused


def atomic_json(path, data):
    temporary = path.with_suffix('.tmp')
    with temporary.open('w') as stream:
        os.chmod(temporary, 0o640)
        json.dump(data, stream)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def load(path, default):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return default


def main():
    if socket.gethostname() != 'm70':
        raise RuntimeError('This monitor is for M70 only')
    now = time.time()
    prior = load(STATE, {})
    result = {'version': 1, 'checkedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(now)),
              'level': 'unknown', 'freeBytes': None, 'totalBytes': None,
              'collectionPaused': True, 'backgroundPaused': True, 'message': 'Database disk cannot be verified.'}
    try:
        root = Path('/mnt/nvme')
        if not os.path.ismount(root) or os.stat(root).st_dev != os.stat(root / 'postgresql/17/main').st_dev:
            raise RuntimeError('Database disk is not mounted at the expected location')
        disk = os.statvfs(root)
        free, total = disk.f_bavail * disk.f_frsize, disk.f_blocks * disk.f_frsize
        critical, paused = pressure(free, prior)
        result.update(freeBytes=free, totalBytes=total, backgroundPaused=critical, collectionPaused=paused,
                      level='critical' if critical else 'collection_paused' if paused else 'warning' if free < 40 * GIB else 'normal',
                      message='')
        history = load(HISTORY, [])
        history = [row for row in history if now - row['at'] <= 30 * 86400]
        if not history or now - history[-1]['at'] >= 3600:
            history.append({'at': now, 'freeBytes': free, 'totalBytes': total})
            atomic_json(HISTORY, history)
        baseline = next((row for row in reversed(history) if now - row['at'] >= 86400), None)
        growth = max(0, (baseline['freeBytes'] - free) * 86400 / (now - baseline['at'])) if baseline else None
        result.update(growthBytesPerDay=growth,
                      daysToCollectionPause=max(0, (free - 30 * GIB) / growth) if growth else None)
    except (OSError, RuntimeError) as error:
        result['message'] = str(error)
    atomic_json(STATE, result)
    if prior.get('level') != result['level']:
        print(json.dumps(result), flush=True)


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == '--allow':
        state = load(STATE, {})
        try:
            checked = calendar.timegm(time.strptime(state['checkedAt'], '%Y-%m-%dT%H:%M:%SZ'))
            fresh = state.get('version') == 1 and -5 <= time.time() - checked <= 90
            field = {'collection': 'collectionPaused', 'background': 'backgroundPaused'}[sys.argv[2]]
            sys.exit(0 if fresh and state.get(field) is False else 1)
        except (KeyError, ValueError, TypeError):
            sys.exit(1)
    with open('/var/lib/career-dashboard/data/runtime/storage-monitor.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        main()
