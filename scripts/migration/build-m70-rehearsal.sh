#!/usr/bin/env bash
# Build the frozen code export on amd64 without source credentials or a usable DB URL.
set -euo pipefail
[[ $(hostname) == m70 && $(id -un) == career-dashboard ]] || exit 1
[[ $(pwd) == /opt/career-dashboard.rehearsal-340dbdd0e8ba ]] || exit 1
[[ ! -e /etc/career-dashboard/production-enabled && ! -f .env && ! -f .env.local ]] || exit 1
export PATH=/usr/local/bin:/usr/bin:/bin
export NEXT_TELEMETRY_DISABLED=1
export PUPPETEER_SKIP_DOWNLOAD=true
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
export DATABASE_URL='postgresql://rehearsal_build:unused@127.0.0.1:1/build_only?schema=public'
export DATABASE_RUNTIME_HOST=127.0.0.1
export NODE_OPTIONS=--max-old-space-size=4096
umask 027
date -u '+Build rehearsal started %Y-%m-%dT%H:%M:%SZ'
node --version
npm --version
npm ci --no-audit --no-fund
./node_modules/.bin/prisma generate --schema prisma/schema.prisma
npm run build
date -u '+Build rehearsal completed %Y-%m-%dT%H:%M:%SZ'
echo 'No schema migrations, application server, acquisition, scoring, or schedules started.'
echo 'Browser binaries and OS dependencies are not validated by this build.'
