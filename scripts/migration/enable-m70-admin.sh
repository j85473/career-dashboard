#!/usr/bin/env bash
# User-requested passwordless sudo for the existing M70 administrator account.
# Consequence: every session authenticated as j85473 can obtain full root access.
# No password is read, stored, embedded, or passed to another process by this script.
set -euo pipefail
[[ ${EUID} -eq 0 ]] || { echo 'Run once with sudo; enter the password interactively.' >&2; exit 1; }
[[ $(hostname) == m70 ]] || { echo 'Expected m70; stopping.' >&2; exit 1; }
[[ $(cat /sys/class/net/eno1/address) == 2c:f0:5d:47:f1:22 ]] || exit 1
[[ $(findmnt -nro UUID /) == be454a64-715e-42ec-a83b-6eac18550d5d ]] || exit 1
[[ $(id -u j85473) == 1000 ]] || { echo 'Unexpected administrator identity; stopping.' >&2; exit 1; }

rule_path=/etc/sudoers.d/99-m70-admin
rule_text='j85473 ALL=(ALL:ALL) NOPASSWD: ALL'
/usr/sbin/visudo -c
if [[ -e $rule_path || -L $rule_path ]]; then
  echo 'The managed sudo rule already exists; inspect it before making changes.' >&2
  exit 1
fi

umask 077
# A dot in the staging filename keeps it out of sudoers includedir processing.
rule_tmp=$(mktemp /etc/sudoers.d/.m70-admin.XXXXXXXX)
trap 'if [[ -n ${rule_tmp:-} ]]; then rm -f -- "$rule_tmp"; fi' EXIT
printf '%s\n' "$rule_text" > "$rule_tmp"
chown root:root "$rule_tmp"
chmod 0440 "$rule_tmp"
/usr/sbin/visudo -cf "$rule_tmp"
mv -T -- "$rule_tmp" "$rule_path"
rule_tmp=''

if ! /usr/sbin/visudo -c || ! runuser -u j85473 -- sudo -k -n /usr/bin/true; then
  rm -f -- "$rule_path"
  /usr/sbin/visudo -c
  echo 'Validation failed; the newly added rule was removed.' >&2
  exit 1
fi
echo 'Passwordless sudo is enabled for j85473 on m70.'
echo 'No password has been stored. Existing SSH authentication settings were preserved.'
echo 'To revoke this grant later: sudo rm /etc/sudoers.d/99-m70-admin'
