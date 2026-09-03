#!/usr/bin/env bash
# Read-only target inspection. Does not install packages, partition disks, or change services.
set -euo pipefail
if [[ "${1:-}" == "--help" ]]; then
  echo "Usage: bash scripts/migration/inspect-ubuntu-host.sh"
  echo "Run on the prospective Ubuntu amd64 server; reports hardware, storage, networking, and installed runtimes."
  exit 0
fi
if [[ $# != 0 || ! -r /etc/os-release ]]; then
  echo "Run this without arguments on the Ubuntu server." >&2
  exit 2
fi
if ! grep -qx 'ID=ubuntu' /etc/os-release || [[ "$(uname -m)" != x86_64 ]]; then
  echo "Expected Ubuntu on x86_64; refusing to treat this host as the migration target." >&2
  exit 2
fi

date -u '+Captured %Y-%m-%dT%H:%M:%SZ'
hostname
cat /etc/os-release
lscpu
free -h
lsblk -o NAME,TYPE,SIZE,MODEL,SERIAL,TRAN,FSTYPE,MOUNTPOINTS
df -hT
findmnt /
ip -brief address
ip route
timedatectl status
ss -lnt
for runtime in node npm psql pg_dump pg_restore; do
  if command -v "$runtime" >/dev/null 2>&1; then
    "$runtime" --version
  else
    echo "$runtime: not installed"
  fi
done
if command -v pg_lsclusters >/dev/null 2>&1; then pg_lsclusters; fi
for service in ssh tailscaled postgresql career-dashboard career-dashboard-acquisition; do
  systemctl show "$service.service" --property=Id,LoadState,ActiveState,SubState,UnitFileState
done
echo "Remaining: privileged SSD SMART check, BIOS power-restoration check, SSH key login, and remote reboot verification."
