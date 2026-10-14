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

RECOVERY_POINTS=3

# A complete set has a published manifest and both archives. Verify the three
# retained SSD sets before deleting any older recovery point on either disk.
verify_ssd_set() {
  local name=$1 base=${1%.sha256}
  [[ $(wc -l < "$COPY_DIR/$name") -eq 2 ]] || return 1
  grep -Eq "^[a-f0-9]{64}  ${base}\\.dump$" "$COPY_DIR/$name" || return 1
  grep -Eq "^[a-f0-9]{64}  ${base}\\.files\\.tar\\.gz$" "$COPY_DIR/$name" || return 1
  (cd "$COPY_DIR" && sha256sum --strict -c "$name" >/dev/null)
}

prune_completed_backups() {
  local name base
  local -a manifests complete_sets=()
  mapfile -t manifests < <(find "$COPY_DIR" -maxdepth 1 -type f -name 'm70-*.sha256' -printf '%f\n' | sort -r)
  for name in "${manifests[@]}"; do
    [[ $name =~ ^m70-[0-9]{8}T[0-9]{6}Z\.sha256$ ]] || continue
    base=${name%.sha256}
    [[ -s "$COPY_DIR/$name" && -s "$COPY_DIR/$base.dump" && -s "$COPY_DIR/$base.files.tar.gz" ]] || continue
    [[ ! -L "$COPY_DIR/$base.dump" && ! -L "$COPY_DIR/$base.files.tar.gz" ]] || continue
    complete_sets+=("$name")
  done
  (( ${#complete_sets[@]} > RECOVERY_POINTS )) || return 0
  for name in "${complete_sets[@]:0:RECOVERY_POINTS}"; do
    verify_ssd_set "$name" || { echo "Retained backup failed verification: $name" >&2; return 1; }
  done
  for name in "${complete_sets[@]:RECOVERY_POINTS}"; do
    base=${name%.sha256}
    verify_ssd_set "$name" || return 1
    # An unmatched local archive remains protected. Remove a matching local
    # duplicate while its verified SSD copy is still present.
    if [[ -s "$DIR/$name" && -s "$DIR/$base.dump" && -s "$DIR/$base.files.tar.gz" ]] \
      && cmp -s "$DIR/$name" "$COPY_DIR/$name" \
      && [[ $(stat -c %s "$DIR/$base.dump") == $(stat -c %s "$COPY_DIR/$base.dump") ]] \
      && [[ $(stat -c %s "$DIR/$base.files.tar.gz") == $(stat -c %s "$COPY_DIR/$base.files.tar.gz") ]]; then
      rm -- "$DIR/$base.dump" "$DIR/$base.files.tar.gz" "$DIR/$name"
    fi
    rm -- "$COPY_DIR/$base.dump" "$COPY_DIR/$base.files.tar.gz" "$COPY_DIR/$name"
    printf 'Removed older completed nightly backup: %s\n' "$base"
  done
}

# Deployment dumps have no companion files/manifest. Count only readable
# PostgreSQL archives older than one hour; never prune an in-flight dump.
prune_predeployment_backups() {
  local name complete=0
  local -a archives
  mapfile -t archives < <(find "$DIR" -maxdepth 1 -type f -name 'predeploy-*.dump' -mmin +60 -printf '%f\n' | sort -r)
  for name in "${archives[@]}"; do
    [[ $name =~ ^predeploy-[0-9]{8}T[0-9]{6}Z\.dump$ && -s "$DIR/$name" ]] || continue
    pg_restore --list "$DIR/$name" >/dev/null 2>&1 || continue
    complete=$((complete + 1))
    if (( complete > RECOVERY_POINTS )); then
      rm -- "$DIR/$name"
      printf 'Removed older completed predeployment backup: %s\n' "$name"
    fi
  done
}
prune_completed_backups
prune_predeployment_backups

# Failed runs retain their partials for inspection. Remove only partial output
# old enough that no active or imminent systemd retry can still own it.
find "$DIR" -maxdepth 1 -type f -name 'm70-*.partial' -mmin +1440 -delete

# Each filesystem receives one dump and one file archive, not two dumps. Use
# the largest retained dump (including newer predeployment backups) and file
# archive, with 25% growth room plus 5 GiB. Refuse before touching the database
# if either disk cannot safely hold that complete set.
largest_dump=$(find "$DIR" -maxdepth 1 -type f \( -name 'm70-*.dump' -o -name 'predeploy-*.dump' \) -printf '%s\n' | sort -n | tail -n 1)
largest_files=$(find "$DIR" -maxdepth 1 -type f -name 'm70-*.files.tar.gz' -printf '%s\n' | sort -n | tail -n 1)
size_hint=$((8 * 1024 * 1024 * 1024))
[[ -z $largest_dump ]] || size_hint=$largest_dump
files_size_hint=${largest_files:-$((512 * 1024 * 1024))}
required_bytes=$(((size_hint + files_size_hint) * 5 / 4 + 5 * 1024 * 1024 * 1024))
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
prune_completed_backups
prune_predeployment_backups
find /var/lib/career-dashboard/data/runtime -maxdepth 1 -type f -name 'cron-*.log' -mtime +30 -delete
printf 'Backed up %s to the release disk and the dedicated backup SSD.\n' "$STAMP"
