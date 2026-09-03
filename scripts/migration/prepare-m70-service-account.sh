#!/usr/bin/env bash
# Create the unprivileged application identity before any production activation.
set -euo pipefail
[[ ${EUID} -eq 0 && $(hostname) == m70 ]] || exit 1
[[ $(cat /sys/class/net/eno1/address) == 2c:f0:5d:47:f1:22 ]] || exit 1
[[ $(findmnt -nro UUID /) == be454a64-715e-42ec-a83b-6eac18550d5d ]] || exit 1
[[ ! -e /etc/career-dashboard/production-enabled ]] || exit 1
if getent passwd career-dashboard >/dev/null; then
  [[ $(getent passwd career-dashboard | cut -d: -f7) == /usr/sbin/nologin ]] || exit 1
else
  useradd --system --user-group --create-home --home-dir /var/lib/career-dashboard \
    --shell /usr/sbin/nologin career-dashboard
fi
[[ $(id -Gn career-dashboard) == career-dashboard ]] || {
  echo 'Unexpected service-account groups; stopping.' >&2; exit 1;
}
install -d -o career-dashboard -g career-dashboard -m 0750 \
  /var/lib/career-dashboard /var/log/career-dashboard
install -d -o j85473 -g career-dashboard -m 0750 /opt/career-dashboard
install -d -o root -g career-dashboard -m 0750 /etc/career-dashboard
if runuser -u career-dashboard -- sudo -k -n /usr/bin/true 2>/dev/null; then
  echo 'Unexpected administrator access for the service account; do not activate services.' >&2
  exit 1
fi
id career-dashboard
stat -c '%U:%G %a %n' /opt/career-dashboard /etc/career-dashboard \
  /var/lib/career-dashboard /var/log/career-dashboard
echo 'Service account exists and cannot use sudo. Code/data permissions still need release rehearsal.'
