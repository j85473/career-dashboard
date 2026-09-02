#!/bin/bash
set -euo pipefail
[[ $(id -u) == 0 && $(hostname) == m70 ]]
export PATH=/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
exec 9>/var/lib/career-dashboard/backup.lock
flock -n 9 || exit 1
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
DIR=/var/lib/career-dashboard/backups
cd /opt/career-dashboard
runuser -u career-dashboard -- node scripts/with-env.mjs node scripts/deployment/backup-postgres.mjs "$DIR/m70-$STAMP.dump.partial"
mv "$DIR/m70-$STAMP.dump.partial" "$DIR/m70-$STAMP.dump"
tar --dereference --exclude='data/runtime/*.log' --exclude='data/runtime/*.lock' -czf "$DIR/m70-$STAMP.files.tar.gz" -C /opt/career-dashboard data -C /etc career-dashboard/runtime.env career-dashboard/acquisition-release.env
chmod 600 "$DIR/m70-$STAMP.files.tar.gz"
cd "$DIR"
sha256sum "m70-$STAMP.dump" "m70-$STAMP.files.tar.gz" > "m70-$STAMP.sha256"
rsync -t --chmod=F600 -e 'ssh -i /etc/career-dashboard/backup_ed25519 -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/etc/career-dashboard/backup_known_hosts' "m70-$STAMP.dump" "m70-$STAMP.files.tar.gz" "m70-$STAMP.sha256" j85473@100.80.154.113:
# Prune only completed local backup sets older than seven days, after off-host success.
find "$DIR" -maxdepth 1 -type f -name 'm70-*' ! -name '*.partial' -mtime +7 -delete
find "$DIR" -maxdepth 1 -type f -name 'predeploy-*.dump' -mtime +7 -delete
find /var/lib/career-dashboard/data/runtime -maxdepth 1 -type f -name 'cron-*.log' -mtime +30 -delete
printf 'Backed up %s locally and to the Pi SSD.\n' "$STAMP"
