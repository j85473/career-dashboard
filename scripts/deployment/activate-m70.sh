#!/bin/bash
set -Eeuo pipefail
[[ $(id -u) == 0 && $(hostname) == m70 ]]
REV=${1:?Commit required}
MODE=${2:-normal}
[[ $MODE == normal || $MODE == maintenance ]] || exit 2
[[ $REV =~ ^[a-f0-9]{40}$ ]]
export PATH=/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
STAGE=/opt/career-dashboard-releases/$REV
APP=/opt/career-dashboard
SHARED=/var/lib/career-dashboard
[[ -f $STAGE/package-lock.json ]]
exec 9>"$SHARED/deploy.lock"
flock -n 9 || { echo 'Another release is active'; exit 1; }
FREE=$(df --output=avail -B1 "$STAGE" | tail -1)
(( FREE > 20000000000 )) || { echo 'Less than 20 GB free; release refused'; exit 1; }
# The build receives a deliberately unusable database address, not production credentials.
if [[ ! -f $STAGE/.m70-build-complete ]]; then
 chown -R career-dashboard:career-dashboard "$STAGE"
 cd "$STAGE"
 runuser -u career-dashboard -- env DATABASE_URL=postgresql://build:build@127.0.0.1:1/build PUPPETEER_SKIP_DOWNLOAD=true PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci
 runuser -u career-dashboard -- env DATABASE_URL=postgresql://build:build@127.0.0.1:1/build npx prisma generate
 runuser -u career-dashboard -- env DATABASE_URL=postgresql://build:build@127.0.0.1:1/build npm run build
 touch .m70-build-complete
fi
# Config and user data survive every release swap. Never put credentials in the checkout/archive.
ln -sfn /etc/career-dashboard/runtime.env "$STAGE/.env"
[[ -d $SHARED/data/runtime ]]
# Keep release-owned scoring policies in the release; preserve uploaded files and runtime state.
rsync -a --ignore-existing --exclude=runtime/ "$SHARED/data/" "$STAGE/data/"
if [[ ! -L $STAGE/data/runtime ]]; then
 [[ ! -e $STAGE/data/runtime ]] || mv "$STAGE/data/runtime" "$STAGE/data/runtime.from-archive"
 ln -s "$SHARED/data/runtime" "$STAGE/data/runtime"
fi
chown -R career-dashboard:career-dashboard "$STAGE/data" "$SHARED/data"
# Discovery also writes one checkpoint outside data/runtime. Keep that checkpoint
# and its display log across release swaps without changing their application paths.
if [[ ! -e $SHARED/data/runtime/discover_progress.json && -f $APP/discover_progress.json ]]; then
 cp -p "$APP/discover_progress.json" "$SHARED/data/runtime/discover_progress.json"
 chown career-dashboard:career-dashboard "$SHARED/data/runtime/discover_progress.json"
fi
ln -sfn "$SHARED/data/runtime/discover_progress.json" "$STAGE/discover_progress.json"
if [[ ! -e $SHARED/data/discover_logs.txt ]]; then
 install -o career-dashboard -g career-dashboard -m 600 /dev/null "$SHARED/data/discover_logs.txt"
fi
ln -sfn "$SHARED/data/discover_logs.txt" "$STAGE/data/discover_logs.txt"
printf '%s\n' "$REV" > "$STAGE/.release-id"
if [[ ! -f /etc/career-dashboard/production-enabled ]]; then
 echo "Built release $REV; production gate is absent, so no services were changed."
 exit 0
fi
OLD=$(readlink -f "$APP")
[[ $OLD == /opt/career-dashboard-releases/* || $OLD == /opt/career-dashboard.rehearsal-* ]] || { echo 'Unexpected prior release'; exit 1; }
SCHEDULE=0; WATCHDOG=0; ACQUISITION=0; PRUNING=0
systemctl is-active --quiet career-dashboard-scheduler.timer && SCHEDULE=1 || true
systemctl is-active --quiet career-dashboard-watchdog.timer && WATCHDOG=1 || true
systemctl is-active --quiet career-dashboard-acquisition.service && ACQUISITION=1 || true
# Read-only weekly review. Stopped with the rest so a deploy never interrupts
# a pass mid-scan, and restored only if it was running beforehand.
systemctl is-active --quiet career-dashboard-board-pruning.timer && PRUNING=1 || true
[[ $MODE != maintenance ]] || { SCHEDULE=0; WATCHDOG=0; ACQUISITION=0; PRUNING=0; }
restart_background() {
 (( ACQUISITION == 0 )) || systemctl start career-dashboard-acquisition.service
 (( SCHEDULE == 0 )) || systemctl start career-dashboard-scheduler.timer
 (( WATCHDOG == 0 )) || systemctl start career-dashboard-watchdog.timer
 (( PRUNING == 0 )) || systemctl start career-dashboard-board-pruning.timer
}
SWAPPED=0
recover() {
 echo 'Release failed; preserving the database and restoring prior application routing.' >&2
 if (( SWAPPED == 1 )); then
   systemctl stop career-dashboard.service
   ln -sfn "$OLD" "$APP.rollback"; mv -Tf "$APP.rollback" "$APP"
   cp /etc/career-dashboard/acquisition-release.env.previous /etc/career-dashboard/acquisition-release.env
 fi
 if [[ -d $OLD/scripts/deployment/m70 ]]; then
  install -o root -g root -m 644 "$OLD"/scripts/deployment/m70/* /etc/systemd/system/
  install -o root -g root -m 755 "$OLD/scripts/deployment/m70-backup.sh" /usr/local/sbin/career-m70-backup
  systemctl daemon-reload
 fi
 systemctl start career-dashboard.service
 restart_background
}
trap recover ERR
systemctl stop career-dashboard-scheduler.timer career-dashboard-watchdog.timer
# Tolerated separately: units are installed further down, so on the first
# release that introduces one, stopping it here fails with 'not loaded' and
# would trip the ERR trap into a rollback of an otherwise good release.
systemctl stop career-dashboard-board-pruning.timer 2>/dev/null || true
curl -fsS --max-time 15 -X POST http://100.107.116.123:3000/api/pipeline/stop?mode=quiesce
systemctl stop career-dashboard-acquisition.service
# Let a current watchdog/scheduler invocation finish rather than interrupting its DB work.
for unit in career-dashboard-watchdog.service career-dashboard-scheduler.service career-dashboard-board-pruning.service; do
 for ((i=0;i<120;i++)); do
  systemctl is-active --quiet "$unit" || break
  sleep 5
 done
 ! systemctl is-active --quiet "$unit"
done
cd "$APP"
QUIET=0
for ((i=0;i<120;i++)); do
 # The gate below is the authority on whether it is safe to migrate. A reclaim
 # that fails transiently must not roll back an otherwise good release, so its
 # failure is reported and the gate is consulted anyway.
 runuser -u career-dashboard -- node scripts/with-env.mjs node "$STAGE/scripts/deployment/reclaim-deployment-leases.cjs" \
  || echo 'Lease reclaim failed; deferring to the quiescence gate.' >&2
 if runuser -u career-dashboard -- env QUIESCENCE_GATE_MODE=runtime node scripts/with-env.mjs node "$STAGE/scripts/deployment/quiescence-query.cjs"; then QUIET=1; break; fi
 sleep 5
done
(( QUIET == 1 ))
systemctl stop career-dashboard.service
# A fresh recovery point precedes schema migration; failed migrations never restore old DB data automatically.
runuser -u career-dashboard -- node scripts/with-env.mjs node scripts/deployment/backup-postgres.mjs "$SHARED/backups/predeploy-$(date -u +%Y%m%dT%H%M%SZ).dump"
cd "$STAGE"
runuser -u career-dashboard -- node scripts/with-env.mjs npx prisma migrate deploy
cp /etc/career-dashboard/acquisition-release.env /etc/career-dashboard/acquisition-release.env.previous
printf 'ATS_WORKER_RELEASE_ID=%s\n' "$REV" > /etc/career-dashboard/acquisition-release.env
chown root:career-dashboard /etc/career-dashboard/acquisition-release.env
chmod 640 /etc/career-dashboard/acquisition-release.env
ln -sfn "$STAGE" "$APP.next"; mv -Tf "$APP.next" "$APP"
SWAPPED=1
install -o root -g root -m 644 "$STAGE"/scripts/deployment/m70/* /etc/systemd/system/
install -o root -g root -m 755 "$STAGE/scripts/deployment/m70-backup.sh" /usr/local/sbin/career-m70-backup
systemctl daemon-reload
systemctl start career-dashboard.service
HEALTHY=0
for ((i=0;i<40;i++)); do
 if curl -fsS --max-time 10 http://100.107.116.123:3000/api/health > /dev/null; then HEALTHY=1; break; fi
 sleep 3
done
(( HEALTHY == 1 ))
restart_background
trap - ERR
echo "Activated $REV on M70; preserved database, shared files and background-service ownership."
