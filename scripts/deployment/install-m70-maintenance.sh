#!/bin/bash
# Installing files never enables maintenance; --enable is a separate authorized action.
set -euo pipefail
[[ $(id -u) == 0 && $(hostname) == m70 ]]
MODE=${1:---install-only}
[[ $MODE == --install-only || $MODE == --enable ]] || { echo 'Use --install-only or --enable' >&2; exit 2; }
[[ $MODE != --enable || -f /etc/career-dashboard/production-enabled ]]
SOURCE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
exec 7>/run/lock/m70-maintenance-install.lock
flock -n 7 || { echo 'Maintenance installation is already active' >&2; exit 1; }
install -d -o root -g root -m 700 /var/lib/m70-auto-maintenance
exec 6>/var/lib/m70-auto-maintenance/maintenance.lock
flock -n 6 || { echo 'Maintenance or recovery is running' >&2; exit 1; }
# Replacing a running coordinator or its recovery state is unsafe.
[[ ! -f /var/lib/m70-auto-maintenance/pending.json ]]
! systemctl is-active --quiet m70-auto-maintenance.service
install -o root -g root -m 755 "$SOURCE/m70-auto-maintenance.py" /usr/local/sbin/m70-auto-maintenance
install -o root -g root -m 644 "$SOURCE"/m70-maintenance/* /etc/systemd/system/

# These conditions prevent enabled background units starting before boot recovery
# has checked the dashboards. They are inert when no maintenance hold exists.
python3 - "$SOURCE/m70-auto-maintenance.py" <<'PY'
import importlib.util
from pathlib import Path
import sys
spec = importlib.util.spec_from_file_location('maintenance', sys.argv[1])
maintenance = importlib.util.module_from_spec(spec)
spec.loader.exec_module(maintenance)
for unit in (*maintenance.BACKGROUND, *maintenance.INVOCATIONS):
    directory = Path('/etc/systemd/system') / (unit + '.d')
    directory.mkdir(mode=0o755, parents=True, exist_ok=True)
    (directory / '50-automatic-maintenance.conf').write_text(
        '[Unit]\nConditionPathExists=!/var/lib/m70-auto-maintenance/hold-background\n')
for unit in maintenance.FOREGROUND:
    directory = Path('/etc/systemd/system') / (unit + '.d')
    directory.mkdir(mode=0o755, parents=True, exist_ok=True)
    (directory / '50-automatic-maintenance.conf').write_text(
        '[Unit]\nConditionPathExists=!/var/lib/m70-auto-maintenance/skip-' + unit + '\n')
PY
systemctl daemon-reload
if [[ $MODE == --enable ]]; then
  # Keep Ubuntu security updates enabled; only this coordinator may schedule a reboot.
  install -o root -g root -m 644 /dev/null /etc/apt/apt.conf.d/99-m70-maintenance
  cat > /etc/apt/apt.conf.d/99-m70-maintenance <<'APT'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
Unattended-Upgrade::Automatic-Reboot "false";
APT
  install -o root -g root -m 600 /dev/null /etc/career-dashboard/automatic-maintenance-enabled
  systemctl enable --now apt-daily.timer apt-daily-upgrade.timer
  systemctl enable m70-maintenance-recover.service
  systemctl enable m70-maintenance-hold.service
  systemctl enable --now m70-maintenance-recover.timer
  systemctl enable --now m70-auto-maintenance.timer
  echo 'Automatic required reboots enabled for 05:30 America/Chicago; no reboot requested now.'
else
  echo 'Maintenance files installed; authorization and timer enablement unchanged.'
fi
