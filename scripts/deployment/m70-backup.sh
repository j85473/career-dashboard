#!/bin/bash
set -euo pipefail
umask 077
[[ $(id -u) == 0 && $(hostname) == m70 ]]
export PATH=/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
exec 9>/var/lib/career-dashboard/backup.lock
flock -n 9 || exit 1
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
DIR=/var/lib/career-dashboard/backups
cd /opt/career-dashboard
runuser -u career-dashboard -- node scripts/with-env.mjs node scripts/deployment/backup-postgres.mjs "$DIR/m70-$STAMP.dump.partial"
mv "$DIR/m70-$STAMP.dump.partial" "$DIR/m70-$STAMP.dump"
tar --dereference --exclude='data/runtime/*.log' --exclude='data/runtime/*.lock' -czf "$DIR/m70-$STAMP.files.tar.gz.partial" -C /opt/career-dashboard data -C /etc career-dashboard/runtime.env career-dashboard/acquisition-release.env
chmod 600 "$DIR/m70-$STAMP.files.tar.gz.partial"
mv "$DIR/m70-$STAMP.files.tar.gz.partial" "$DIR/m70-$STAMP.files.tar.gz"
cd "$DIR"
sha256sum "m70-$STAMP.dump" "m70-$STAMP.files.tar.gz" > "m70-$STAMP.sha256"
# The second copy lives on the dedicated 250 GB SSD attached to this machine,
# not on the Pi's NAS drive, which is the MacBook's Time Machine target.
#
# Be clear about what that costs: this copy is on the same machine as the
# database. It survives a bad deployment, a wrong migration, a dropped table --
# every failure this backup has actually been needed for. It does not survive
# losing the machine itself. The frozen migration archive and the pre-cutover
# history already on this disk are likewise single-copy.
#
# Mounted nofail, so a missing or failed backup disk can never stop the server
# booting. If it is not mounted, that is a hard failure here rather than a
# backup silently written to the root filesystem and pruned away unnoticed.
mountpoint -q /mnt/backup || { echo 'Backup disk is not mounted at /mnt/backup' >&2; exit 1; }
install -d -o root -g career-dashboard -m 750 /mnt/backup/m70
cp -p "m70-$STAMP.dump" "m70-$STAMP.files.tar.gz" "m70-$STAMP.sha256" /mnt/backup/m70/
sync -f /mnt/backup/m70
# Verify the copy before anything is pruned anywhere: a backup nobody has read
# back is a file, not a backup.
(cd /mnt/backup/m70 && sha256sum -c "m70-$STAMP.sha256" >/dev/null)
# Fourteen days on the backup disk, which has room for far more than that.
find /mnt/backup/m70 -maxdepth 1 -type f -name 'm70-*' -mtime +14 -delete
# Prune only completed local backup sets older than seven days, after the copy succeeded.
find "$DIR" -maxdepth 1 -type f -name 'm70-*' ! -name '*.partial' -mtime +7 -delete
find "$DIR" -maxdepth 1 -type f -name 'predeploy-*.dump' -mtime +7 -delete
find /var/lib/career-dashboard/data/runtime -maxdepth 1 -type f -name 'cron-*.log' -mtime +30 -delete
printf 'Backed up %s to the release disk and the dedicated backup SSD.\n' "$STAMP"
