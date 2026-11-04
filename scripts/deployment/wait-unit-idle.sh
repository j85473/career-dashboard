#!/bin/bash
set -euo pipefail
UNIT=${1:?Systemd unit required}
# A Type=oneshot unit stays activating throughout ExecStart. is-active returns
# nonzero for that state even though the process can still write to PostgreSQL.
for ((attempt=0;attempt<120;attempt++)); do
 state=$(systemctl show "$UNIT" --property=ActiveState --value)
 case "$state" in
  inactive|failed) exit 0 ;;
  active|activating|deactivating|reloading|refreshing) sleep 5 ;;
  *) echo "Could not establish whether $UNIT is idle: $state" >&2; exit 1 ;;
 esac
done
echo "$UNIT is still $state; refusing to continue the release." >&2
exit 1
