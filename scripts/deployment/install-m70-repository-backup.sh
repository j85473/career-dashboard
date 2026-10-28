#!/bin/bash
# Enable only after bootstrap published a verified recovery point on both disks.
set -euo pipefail
[[ $(id -u) == 0 && $(hostname) == m70 ]]
SOURCE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
if [[ ${1:-} == --backup-lock-held ]]; then
 [[ $(readlink /proc/$$/fd/8) == /var/lib/career-dashboard/backup.lock ]]
else
 [[ $# == 0 ]]
 exec 8>/var/lib/career-dashboard/backup.lock
 flock -n 8 || { echo 'A backup owns the engine; installation deferred.' >&2; exit 1; }
fi
command -v restic >/dev/null
[[ -f /etc/career-dashboard/backup-repository-enabled ]]
[[ -s /etc/career-dashboard/backup-repository.key ]]
install -d -o root -g root -m 755 /usr/local/lib/career-dashboard
install -o root -g root -m 755 "$SOURCE/m70-repository-backup.py" /usr/local/lib/career-dashboard/m70-repository-backup.py.next
mv -Tf /usr/local/lib/career-dashboard/m70-repository-backup.py.next /usr/local/lib/career-dashboard/m70-repository-backup.py
# This dispatcher and drop-in survive an application rollback. Old releases
# cannot silently resume full-file backups after the repository migration.
cat > /usr/local/sbin/career-m70-repository-backup <<'WRAPPER'
#!/bin/bash
set -euo pipefail
umask 077
export GOMAXPROCS="${GOMAXPROCS:-4}"
cd /opt/career-dashboard
exec node scripts/with-env.mjs python3 /usr/local/lib/career-dashboard/m70-repository-backup.py backup
WRAPPER
chmod 755 /usr/local/sbin/career-m70-repository-backup
install -d -o root -g root -m 755 /etc/systemd/system/career-dashboard-backup.service.d
cat > /etc/systemd/system/career-dashboard-backup.service.d/60-repository-backup.conf <<'UNIT'
[Service]
ExecStart=
ExecStart=/usr/local/sbin/career-m70-repository-backup
# Full decode/checksum verification on both repositories precedes retention.
TimeoutStartSec=3h
Nice=10
IOSchedulingClass=best-effort
IOSchedulingPriority=6
UNIT
systemctl daemon-reload
echo 'Paired repository backups installed; nightly schedule unchanged.'
