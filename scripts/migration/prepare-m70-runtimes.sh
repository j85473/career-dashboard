#!/usr/bin/env bash
# Bootstrap only the verified M70. No production data, app, cron, or SSH-policy changes.
# PostgreSQL stays on loopback. Tailscale is installed but enrollment is separate.
set -euo pipefail
[[ ${EUID} -eq 0 ]] || { echo 'Run with sudo on the M70.' >&2; exit 1; }
source /etc/os-release
[[ ${ID:-} == ubuntu && ${VERSION_ID:-} == 24.04 && $(uname -m) == x86_64 ]] || exit 1
[[ $(hostname) == m70 ]] || exit 1
[[ $(cat /sys/class/net/eno1/address) == 2c:f0:5d:47:f1:22 ]] || exit 1
[[ $(lsblk -dnro SERIAL /dev/sda | xargs) == PNY011822360701002A0 ]] || exit 1
[[ $(findmnt -nro UUID /) == be454a64-715e-42ec-a83b-6eac18550d5d ]] || exit 1
[[ ! -e /etc/career-dashboard/production-enabled ]] || {
  echo 'Production gate exists; bootstrap is no longer appropriate.' >&2; exit 1;
}
if [[ -d /etc/postgresql/17/main ]]; then
  echo 'PostgreSQL is already configured; inspect it instead of rerunning bootstrap.' >&2
  exit 1
fi

umask 027
touch /var/log/m70-runtime-preparation.log
chown root:adm /var/log/m70-runtime-preparation.log
chmod 0640 /var/log/m70-runtime-preparation.log
exec > >(tee -a /var/log/m70-runtime-preparation.log) 2>&1
runtime_tmp=$(mktemp -d /tmp/m70-runtimes.XXXXXXXX)
trap 'rm -rf -- "$runtime_tmp"' EXIT
trap 'echo "Runtime setup stopped at line $LINENO. Inspect the log before retrying."' ERR
date -u '+Runtime preparation started %Y-%m-%dT%H:%M:%SZ'

# Official Node release, pinned to the HTTPS-published checksum inspected on September 2.
# This is checksum verification; no detached Node release signature is claimed.
node_release=node-v24.20.0-linux-x64
node_sha=2f2c0da162318f0de47665410c7c8c2ed3d36c8f3105de4bbc61176c70a7cbf2
for binary in node npm npx; do
  if [[ -e /usr/local/bin/$binary || -L /usr/local/bin/$binary ]]; then
    echo "Existing /usr/local/bin/$binary needs review; stopping." >&2
    exit 1
  fi
done
[[ ! -e /opt/$node_release ]] || { echo 'Node destination already exists; inspect it first.' >&2; exit 1; }
curl --fail --silent --show-error --location --retry 3 \
  "https://nodejs.org/dist/v24.20.0/$node_release.tar.xz" -o "$runtime_tmp/node.tar.xz"
printf '%s  %s\n' "$node_sha" "$runtime_tmp/node.tar.xz" | sha256sum --check -

# Only these two signed package repositories are added, scoped by Signed-By.
curl -fsSL --retry 3 https://www.postgresql.org/media/keys/ACCC4CF8.asc -o "$runtime_tmp/pgdg.asc"
curl -fsSL --retry 3 https://pkgs.tailscale.com/stable/ubuntu/noble.noarmor.gpg -o "$runtime_tmp/tailscale.gpg"
pg_fingerprint=$(gpg --batch --show-keys --with-colons "$runtime_tmp/pgdg.asc" 2>/dev/null | awk -F: '$1=="fpr" {print $10; exit}')
ts_fingerprint=$(gpg --batch --show-keys --with-colons "$runtime_tmp/tailscale.gpg" 2>/dev/null | awk -F: '$1=="fpr" {print $10; exit}')
[[ $pg_fingerprint == B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8 ]] || exit 1
[[ $ts_fingerprint == 2596A99EAAB33821893C0A79458CA832957F5868 ]] || exit 1
install -d -m 0755 /usr/share/postgresql-common/pgdg /usr/share/keyrings
install -m 0644 "$runtime_tmp/pgdg.asc" /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
install -m 0644 "$runtime_tmp/tailscale.gpg" /usr/share/keyrings/tailscale-archive-keyring.gpg
cat > "$runtime_tmp/pgdg.sources" <<'EOF'
Types: deb
URIs: https://apt.postgresql.org/pub/repos/apt
Suites: noble-pgdg
Architectures: amd64
Components: main
Signed-By: /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
EOF
cat > "$runtime_tmp/tailscale.list" <<'EOF'
deb [signed-by=/usr/share/keyrings/tailscale-archive-keyring.gpg] https://pkgs.tailscale.com/stable/ubuntu noble main
EOF
for repo in pgdg.sources tailscale.list; do
  if [[ -e /etc/apt/sources.list.d/$repo ]] && ! cmp -s "$runtime_tmp/$repo" "/etc/apt/sources.list.d/$repo"; then
    echo "Existing $repo differs; stopping." >&2; exit 1
  fi
  install -m 0644 "$runtime_tmp/$repo" "/etc/apt/sources.list.d/$repo"
done
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  postgresql-17 postgresql-client-17 tailscale xz-utils

install -d -m 0755 /opt
tar --no-same-owner -xJf "$runtime_tmp/node.tar.xz" -C /opt
chmod -R a+rX /opt/"$node_release"
for binary in node npm npx; do
  ln -s "/opt/$node_release/bin/$binary" "/usr/local/bin/$binary"
done
install -d -o j85473 -g j85473 -m 0750 /opt/career-dashboard /opt/career-dashboard.db-backups
install -d -o root -g j85473 -m 0750 /etc/career-dashboard

# This is a newly installed, empty cluster. Never expose it on LAN or Tailscale.
pg_conftool 17 main set listen_addresses localhost
systemctl restart postgresql@17-main.service
systemctl enable --now tailscaled.service
# Allow the existing administrator account to enroll/manage this Tailscale node.
# This does not grant general passwordless sudo or enable Tailscale SSH/Funnel.
tailscale set --operator=j85473

echo 'Installed runtime versions:'
/usr/local/bin/node --version
/usr/local/bin/npm --version
psql --version
tailscale version
pg_lsclusters
runuser -u postgres -- psql -X -v ON_ERROR_STOP=1 -d postgres -c "SHOW listen_addresses;" \
  -c "SELECT datname FROM pg_database ORDER BY datname;" \
  -c "SELECT name, default_version FROM pg_available_extensions WHERE name IN ('pg_trgm','btree_gist');"
ss -lnt 'sport = :5432'
systemctl is-active postgresql@17-main.service tailscaled.service
date -u '+Runtime preparation completed %Y-%m-%dT%H:%M:%SZ'
echo 'Tailscale still needs account enrollment. Database restore and application activation have not run.'
