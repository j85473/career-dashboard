#!/bin/bash
set -euo pipefail
umask 077
[[ $(id -u) == 0 && $(hostname) == m70 ]]
export PATH=/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
exec 9>/var/lib/career-dashboard/backup.lock
flock -n 9 || exit 1
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
DIR=/var/lib/career-dashboard/backups
COPY_DIR=/mnt/backup/m70
cd /opt/career-dashboard
# The backup disk is mounted nofail. Check it before writing another large dump
# to the release disk, or a failed copy can fill the application filesystem.
mountpoint -q /mnt/backup || { echo 'Backup disk is not mounted at /mnt/backup' >&2; exit 1; }
install -d -o root -g career-dashboard -m 750 "$COPY_DIR"

# Keep the three newest complete recovery points even after a long outage.
# Remove completed sets older than seven days before checking capacity; waiting
# until after a new copy succeeds deadlocks cleanup when the disk is full.
SSD_RETENTION_MINUTES=$((7 * 24 * 60))
mapfile -t manifests < <(find "$COPY_DIR" -maxdepth 1 -type f -name 'm70-*.sha256' -printf '%f\n' | sort -r)
complete=0
for name in "${manifests[@]}"; do
  base=${name%.sha256}
  [[ -s "$COPY_DIR/$name" && -s "$COPY_DIR/$base.dump" && -s "$COPY_DIR/$base.files.tar.gz" ]] || continue
  complete=$((complete + 1))
  if (( complete > 3 )) && [[ -n $(find "$COPY_DIR/$name" -mmin +"$SSD_RETENTION_MINUTES" -print) ]]; then
    rm -- "$COPY_DIR/$base.dump" "$COPY_DIR/$base.files.tar.gz" "$COPY_DIR/$name"
  fi
done

# An older local duplicate can be released only when its verified SSD copy
# still exists. A failed destination copy must never erase the sole archive.
prune_verified_local_copies() {
  while IFS= read -r -d '' manifest; do
    name=${manifest##*/}
    base=${name%.sha256}
    [[ -s "$COPY_DIR/$name" && -s "$COPY_DIR/$base.dump" && -s "$COPY_DIR/$base.files.tar.gz" ]] || continue
    [[ -s "$DIR/$base.dump" && -s "$DIR/$base.files.tar.gz" ]] || continue
    cmp -s "$manifest" "$COPY_DIR/$name" || continue
    [[ $(stat -c %s "$DIR/$base.dump") == $(stat -c %s "$COPY_DIR/$base.dump") ]] || continue
    [[ $(stat -c %s "$DIR/$base.files.tar.gz") == $(stat -c %s "$COPY_DIR/$base.files.tar.gz") ]] || continue
    rm -- "$DIR/$base.dump" "$DIR/$base.files.tar.gz" "$manifest"
  done < <(find "$DIR" -maxdepth 1 -type f -name 'm70-*.sha256' -mtime +7 -print0)
}
prune_verified_local_copies

# Failed runs retain their partials for inspection. Remove only partial output
# old enough that no active or imminent systemd retry can still own it.
find "$DIR" -maxdepth 1 -type f -name 'm70-*.partial' -mmin +1440 -delete

# Use the most recent dump as a size hint and demand generous room on both
# filesystems. A capacity failure now leaves the live pipeline untouched.
latest_dump=$(find "$DIR" -maxdepth 1 -type f -name 'm70-*.dump' -printf '%f\n' | sort | tail -n 1)
size_hint=$((8 * 1024 * 1024 * 1024))
[[ -z $latest_dump ]] || size_hint=$(stat -c %s "$DIR/$latest_dump")
required_bytes=$((size_hint * 2 + 5 * 1024 * 1024 * 1024))
for volume in "$DIR" "$COPY_DIR"; do
  available_bytes=$(df -B1 --output=avail "$volume" | tail -n 1)
  if (( available_bytes < required_bytes )); then
    echo "Insufficient free space for a new backup on $volume: $available_bytes available, $required_bytes required." >&2
    exit 1
  fi
done

runuser -u career-dashboard -- node scripts/with-env.mjs node scripts/deployment/backup-postgres.mjs "$DIR/m70-$STAMP.dump.partial"
mv "$DIR/m70-$STAMP.dump.partial" "$DIR/m70-$STAMP.dump"
# Preserve recovery history separately from the changing runtime directory.
# The private snapshot is validated before archiving and restored to its normal
# data/runtime paths by tar's name transform. Keep tar strict for retained files.
SNAPSHOT=$(mktemp -d "$DIR/m70-$STAMP.runtime.XXXXXX")
trap 'rm -rf -- "$SNAPSHOT"' EXIT
node scripts/deployment/snapshot-backup-runtime.mjs data/runtime "$SNAPSHOT/runtime-snapshot"
# A restore must leave the service able to read its history, not root-owned
# files inherited from the private staging directory.
chown -R --reference=data/runtime "$SNAPSHOT/runtime-snapshot"
chmod --reference=data/runtime "$SNAPSHOT/runtime-snapshot"
tar --dereference \
  --exclude='data/runtime' \
  --exclude='data/discover_logs.txt' \
  --transform='s,^runtime-snapshot,data/runtime,' \
  -czf "$DIR/m70-$STAMP.files.tar.gz.partial" \
  -C /opt/career-dashboard data \
  -C /etc career-dashboard/runtime.env career-dashboard/acquisition-release.env \
  -C "$SNAPSHOT" runtime-snapshot
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
stage=$(mktemp -d "$COPY_DIR/.m70-$STAMP.XXXXXX")
trap 'rm -rf -- "$SNAPSHOT" "$stage"' EXIT
cp -p "m70-$STAMP.dump" "m70-$STAMP.files.tar.gz" "m70-$STAMP.sha256" "$stage/"
sync -f "$stage"
# Verify the copy before publishing its manifest. A failed copy stays inside
# the temporary directory and cannot masquerade as a complete backup set.
(cd "$stage" && sha256sum -c "m70-$STAMP.sha256" >/dev/null)
mv "$stage/m70-$STAMP.dump" "$stage/m70-$STAMP.files.tar.gz" "$COPY_DIR/"
mv "$stage/m70-$STAMP.sha256" "$COPY_DIR/"
prune_verified_local_copies
find "$DIR" -maxdepth 1 -type f -name 'predeploy-*.dump' -mtime +7 -delete
find /var/lib/career-dashboard/data/runtime -maxdepth 1 -type f -name 'cron-*.log' -mtime +30 -delete
printf 'Backed up %s to the release disk and the dedicated backup SSD.\n' "$STAMP"
