#!/usr/bin/env python3
"""Compare every archived COPY row with the isolated restore, without live DB access.

Sort per-row SHA-256 digests so physical row order cannot change the result.
Every archived column participates, including existing scores, status and history.
Sequence values and schema definitions require separate verification.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import tempfile

ARCHIVE = Path('/var/lib/postgresql/m70-rehearsal/source-20260901T223925Z.dump')
OUTPUT = ARCHIVE.parent / 'row-comparison.json'
MANIFEST = ARCHIVE.parent / 'archive-rows.json'
DATABASE = 'career_rehearsal_20260902'


def finish_hash(digests):
    digests.sort()
    digest = hashlib.sha256()
    for row in digests:
        digest.update(row)
    return {'rows': len(digests), 'sha256_sorted_row_digests': digest.hexdigest()}


def target_rows(copy_target):
    env = dict(os.environ)
    # Even a mistaken write would be rejected; no application or provider credentials.
    env['PGOPTIONS'] = ('-c default_transaction_read_only=on -c statement_timeout=600000 '
                        '-c DateStyle=ISO -c IntervalStyle=postgres -c extra_float_digits=3 '
                        '-c bytea_output=hex')
    with tempfile.TemporaryFile() as errors:
        proc = subprocess.Popen(
            ['psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', DATABASE,
             '-c', 'COPY ' + copy_target + ' TO STDOUT;'],
            stdout=subprocess.PIPE, stderr=errors, env=env)
        digests = [hashlib.sha256(row).digest() for row in proc.stdout]
        if proc.wait() != 0:
            raise RuntimeError('Target read-only COPY failed; no production changes made')
    return finish_hash(digests)


def main():
    if socket.gethostname() != 'm70' or os.getuid() == 0:
        raise RuntimeError('Run only on m70 as the local postgres OS account')
    mode = sys.argv[1:]
    if mode not in ([], ['--archive-only'], ['--compare-manifest']):
        raise SystemExit('Use --archive-only, --compare-manifest, or no arguments')
    archive_only = mode == ['--archive-only']
    destination = MANIFEST if archive_only else OUTPUT
    if not ARCHIVE.is_file() or destination.exists():
        raise RuntimeError('Verified archive missing or previous comparison exists; inspect first')
    digest = hashlib.file_digest(ARCHIVE.open('rb'), 'sha256').hexdigest()
    if digest != '084f885ba22d4793a5a27d0abbe51e796f8f8a55a8c0aca377d7416589d49889':
        raise RuntimeError('Archive checksum differs from the verified Pi copy')
    if mode == ['--compare-manifest']:
        report = json.loads(MANIFEST.read_text())
        if report.get('archive_sha256') != digest or report.get('database') != DATABASE:
            raise RuntimeError('Manifest identity mismatch')
        for table in report['tables']:
            table['restored'] = target_rows(table['copy_target'])
            table['match'] = table['archive'] == table['restored']
            print(f'{table["copy_target"].split(" (", 1)[0]}: match={table["match"]}', flush=True)
        save_report(report, destination, False)
        return
    report = {'database': DATABASE, 'archive': ARCHIVE.name,
              'archive_sha256': digest,
              'method': 'SHA256(sorted(SHA256(each raw COPY row))); all archived columns',
              'tables': [], 'all_tables_match': False}
    # Headers come from pg_restore of the verified internal archive, never arbitrary input.
    copy_pattern = re.compile(rb'^COPY (.+) FROM stdin;\n$')
    copy_target = None
    digests = []
    with tempfile.TemporaryFile() as errors:
        proc = subprocess.Popen(['pg_restore', '--data-only', '--file=-', str(ARCHIVE)],
                                stdout=subprocess.PIPE, stderr=errors)
        try:
            for line in proc.stdout:
                if copy_target is None:
                    match = copy_pattern.match(line)
                    if match:
                        copy_target = match.group(1).decode('utf-8')
                        digests = []
                elif line == b'\\.\n':
                    source = finish_hash(digests)
                    digests = []
                    target = None if archive_only else target_rows(copy_target)
                    entry = {'copy_target': copy_target, 'archive': source,
                             'restored': target, 'match': None if archive_only else source == target}
                    report['tables'].append(entry)
                    table = copy_target.split(' (', 1)[0]
                    print(f'{table}: {source["rows"]} rows; match={entry["match"]}', flush=True)
                    copy_target = None
                else:
                    digests.append(hashlib.sha256(line).digest())
            if proc.wait() != 0 or copy_target is not None:
                raise RuntimeError('Archive data extraction incomplete')
        finally:
            if proc.poll() is None:
                proc.terminate()
                proc.wait()
    save_report(report, destination, archive_only)


def save_report(report, destination, archive_only):
    if not report['tables']:
        raise RuntimeError('No COPY tables extracted; refusing vacuous success')
    report['all_tables_match'] = None if archive_only else all(t['match'] for t in report['tables'])
    with destination.open('x') as out:
        json.dump(report, out, indent=2)
        out.write('\n')
    destination.chmod(0o600)
    print(f'Compared {len(report["tables"])} tables; all match={report["all_tables_match"]}')
    if not archive_only and not report['all_tables_match']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
