#!/usr/bin/env bash
set -Eeuo pipefail

if (( $# != 2 )); then
  echo "Usage: audit-storage.sh <postgres-data-directory> <application-directory>" >&2
  exit 2
fi

POSTGRES_DATA_DIRECTORY="$1"
APPLICATION_DIRECTORY="$2"
for directory in "$POSTGRES_DATA_DIRECTORY" "$APPLICATION_DIRECTORY"; do
  if [[ ! "$directory" =~ ^/[a-zA-Z0-9._/-]+$ ]] || [[ "$directory" == *"/../"* ]]; then
    echo "Unsafe storage-audit path: $directory" >&2
    exit 2
  fi
done

for command in findmnt lsblk udevadm; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Storage audit requires $command." >&2
    exit 1
  fi
done

database_target="$(findmnt -n -T "$POSTGRES_DATA_DIRECTORY" -o TARGET)"
database_source="$(findmnt -n -T "$POSTGRES_DATA_DIRECTORY" -o SOURCE)"
database_filesystem="$(findmnt -n -T "$POSTGRES_DATA_DIRECTORY" -o FSTYPE)"
database_options="$(findmnt -n -T "$POSTGRES_DATA_DIRECTORY" -o OPTIONS)"
application_target="$(findmnt -n -T "$APPLICATION_DIRECTORY" -o TARGET)"
application_source="$(findmnt -n -T "$APPLICATION_DIRECTORY" -o SOURCE)"

partition_name="${database_source#/dev/}"
parent_name="$(lsblk -ndo PKNAME "$database_source" 2>/dev/null || true)"
block_name="${parent_name:-$partition_name}"
model="$(lsblk -ndo MODEL "/dev/$block_name" 2>/dev/null | xargs || true)"
transport="$(lsblk -ndo TRAN "/dev/$block_name" 2>/dev/null | xargs || true)"
rotational="$(cat "/sys/class/block/$block_name/queue/rotational" 2>/dev/null || echo unknown)"
scheduler="$(cat "/sys/class/block/$block_name/queue/scheduler" 2>/dev/null || echo unknown)"
usb_driver="$(udevadm info --query=property --name="/dev/$block_name" 2>/dev/null | sed -n 's/^ID_USB_DRIVER=//p' | head -n 1)"
discard_max="$(lsblk -ndo DISC-MAX "/dev/$block_name" 2>/dev/null | xargs || true)"

echo "Storage performance audit"
printf '  PostgreSQL: %s on %s (%s, %s)\n' "$POSTGRES_DATA_DIRECTORY" "$database_source" "$database_filesystem" "$database_target"
printf '  Database mount options: %s\n' "$database_options"
printf '  Database device: %s model=%s transport=%s rotational=%s\n' "$block_name" "${model:-unknown}" "${transport:-unknown}" "$rotational"
printf '  USB driver: %s\n' "${usb_driver:-not-usb-or-unknown}"
printf '  Scheduler: %s\n' "$scheduler"
printf '  Maximum discard: %s\n' "${discard_max:-unknown}"
printf '  Application: %s on %s (%s)\n' "$APPLICATION_DIRECTORY" "$application_source" "$application_target"

warning_count=0
if [[ "$rotational" != "0" ]]; then
  echo "  WARNING: Linux does not expose the database device as non-rotational."
  warning_count=$((warning_count + 1))
fi
if [[ "$transport" == "usb" && "$usb_driver" != "uas" ]]; then
  echo "  WARNING: the USB SSD is using usb-storage rather than UAS; adapter or kernel compatibility is the likely boundary."
  warning_count=$((warning_count + 1))
fi
if [[ "$discard_max" == "0B" || "$discard_max" == "0" ]]; then
  echo "  WARNING: the USB storage path does not advertise discard/TRIM support."
  warning_count=$((warning_count + 1))
fi
if [[ ",$database_options," != *,noatime,* ]]; then
  echo "  INFO: the database mount uses relatime. noatime is optional and intentionally not changed automatically."
fi
if [[ "$application_source" != "$database_source" ]]; then
  echo "  INFO: application files and PostgreSQL use different storage devices; database placement is the performance-critical one."
fi
printf '  Audit completed with %d hardware or kernel warning(s).\n' "$warning_count"
