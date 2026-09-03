#!/usr/bin/env bash
# One-time base setup for Joseph's verified M70. Run interactively with sudo.
# Does not install/start the Dashboard, restore data, change SSH policy, or grant sudo rights.
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Run with sudo on the M70; enter the password locally when prompted." >&2
  exit 1
fi
source /etc/os-release
[[ ${ID:-} == ubuntu && ${VERSION_ID:-} == 24.04 && $(uname -m) == x86_64 ]] || {
  echo "Expected Ubuntu 24.04 amd64; stopping." >&2; exit 1;
}
[[ $(hostname) == m70 ]] || { echo "Expected hostname m70; stopping." >&2; exit 1; }
[[ $(cat /sys/class/net/eno1/address) == 2c:f0:5d:47:f1:22 ]] || {
  echo "Wired hardware identity differs; stopping." >&2; exit 1;
}
[[ $(lsblk -dnro SERIAL /dev/sda | xargs) == PNY011822360701002A0 ]] || {
  echo "Internal SSD identity differs; stopping." >&2; exit 1;
}
[[ $(findmnt -nro UUID /) == be454a64-715e-42ec-a83b-6eac18550d5d ]] || {
  echo "Installed root filesystem differs; stopping." >&2; exit 1;
}

umask 077
exec > >(tee -a /var/log/m70-base-preparation.log) 2>&1
trap 'echo "Base preparation stopped at line $LINENO; inspect the log before retrying."' ERR
date -u '+Base preparation started %Y-%m-%dT%H:%M:%SZ'

# Use the Ubuntu repositories already configured by the installer.
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  ca-certificates curl gnupg git rsync jq build-essential pkg-config python3 \
  smartmontools locales unzip
locale-gen en_GB.UTF-8
timedatectl set-timezone America/Chicago

echo "Checking SSD health (read-only; no self-test or disk write requested)."
smart_status=0
smartctl -x /dev/sda > /var/log/m70-internal-ssd-health.txt 2>&1 || smart_status=$?
cat /var/log/m70-internal-ssd-health.txt
echo "smartctl exit bitmask: $smart_status"
if (( smart_status != 0 )); then
  echo "SSD report needs review before migration; see /var/log/m70-internal-ssd-health.txt."
fi

echo "Console diagnostics:"
systemctl is-active getty@tty1.service
python3 - <<'PY'
from pathlib import Path
header = Path('/dev/vcsa1').open('rb').read(4)
if len(header) == 4:
    rows, columns, cursor_x, cursor_y = header
    print(f'Text console: {columns} columns, {rows} rows; cursor column {cursor_x}, row {cursor_y}')
    # Report whether a prompt exists; do not print screen text or keystrokes.
    screen = Path('/dev/vcs1').read_bytes()
    print(f'Console buffer contains a login prompt: {b"login:" in screen}')
PY
timedatectl status
df -hT /
date -u '+Base preparation completed %Y-%m-%dT%H:%M:%SZ'
echo "Dashboard, PostgreSQL, Node, private remote access, and migration remain separate steps."
chgrp adm /var/log/m70-base-preparation.log /var/log/m70-internal-ssd-health.txt
chmod 0640 /var/log/m70-base-preparation.log /var/log/m70-internal-ssd-health.txt
