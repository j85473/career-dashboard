#!/bin/bash
set -euo pipefail
[[ $(id -u) == 0 && $(hostname) == m70 ]]
# The same lock reserves disk capacity for nightly backups and deployments.
# A timer retries after a busy lock; it must never compete for their reserve.
exec 8>/var/lib/career-dashboard/backup.lock
flock -n 8 || exit 0
exec runuser -u postgres -g career-dashboard -- /usr/local/bin/node \
  /opt/career-dashboard/scripts/deployment/crawl-archive.mjs --apply
