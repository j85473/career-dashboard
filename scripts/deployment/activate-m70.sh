#!/bin/bash
set -Eeuo pipefail
[[ $(id -u) == 0 && $(hostname) == m70 ]]
REV=${1:?Commit required}
MODE=${2:-normal}
FORCE_PREDEPLOY_BACKUP=${3:-0}
[[ $MODE == normal || $MODE == maintenance ]] || exit 2
[[ $FORCE_PREDEPLOY_BACKUP == 0 || $FORCE_PREDEPLOY_BACKUP == 1 ]] || exit 2
[[ $REV =~ ^[a-f0-9]{40}$ ]]
export PATH=/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
STAGE=/opt/career-dashboard-releases/$REV
APP=/opt/career-dashboard
SHARED=/var/lib/career-dashboard
[[ -f $STAGE/package-lock.json ]]
exec 9>"$SHARED/deploy.lock"
flock -n 9 || { echo 'Another release is active'; exit 1; }
# Backups and deployments share disk capacity. Wait for a running backup rather
# than switching its source release or spending the space it already reserved.
exec 8>"$SHARED/backup.lock"
flock -w 2700 8 || { echo 'Backup still owns storage; release refused'; exit 1; }
python3 "$STAGE/scripts/deployment/m70-storage.py" cleanup --apply --deploy-lock-held --protect-release "$REV"
python3 "$STAGE/scripts/deployment/m70-storage.py" check-capacity --extra-bytes 5368709120
touch "$STAGE/.m70-activation-started"
# The build receives a deliberately unusable database address, not production credentials.
if [[ ! -f $STAGE/.m70-build-complete ]]; then
 chown -R career-dashboard:career-dashboard "$STAGE"
 cd "$STAGE"
 runuser -u career-dashboard -- env DATABASE_URL=postgresql://build:build@127.0.0.1:1/build PUPPETEER_SKIP_DOWNLOAD=true PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --no-audit --no-fund
 runuser -u career-dashboard -- env DATABASE_URL=postgresql://build:build@127.0.0.1:1/build npx prisma generate
 runuser -u career-dashboard -- env DATABASE_URL=postgresql://build:build@127.0.0.1:1/build npm run build
 touch .m70-build-complete
fi
python3 "$STAGE/scripts/deployment/m70-storage.py" check-capacity
# Config and user data survive every release swap. Never put credentials in the checkout/archive.
ln -sfn /etc/career-dashboard/runtime.env "$STAGE/.env"
[[ -d $SHARED/data/runtime ]]
# Keep release-owned scoring policies in the release; preserve uploaded files and runtime state.
rsync -a --ignore-existing --exclude=runtime/ "$SHARED/data/" "$STAGE/data/"
if [[ ! -L $STAGE/data/runtime ]]; then
 [[ ! -e $STAGE/data/runtime ]] || mv "$STAGE/data/runtime" "$STAGE/data/runtime.from-archive"
 ln -s "$SHARED/data/runtime" "$STAGE/data/runtime"
fi
# Workers still own the shared runtime until quiescence below. Their browser
# caches change while running, so never walk that tree during preparation.
# Own copied release files and links without following links into live state.
chown -hR -P career-dashboard:career-dashboard "$STAGE/data"
chown career-dashboard:career-dashboard "$SHARED/data" "$SHARED/data/runtime"
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
SCHEDULE=0; WATCHDOG=0; ACQUISITION=0; PRUNING=0; DISCOVERY=0; DISCOVERY_AUDIT=0; CANONICAL_RESOLVER=0; GUSTO=0; STATS_WARM=0; ROTATION_BALANCE=0; FIRST_COLLECTIONS=0; CANONICAL_API=0; CANONICAL_API_NEW=0; PUBLIC_BOARDS=0; PUBLIC_BOARDS_NEW=0; PUBLIC_HTTP=0; PUBLIC_HTTP_NEW=0; WEB_DISCOVERY=0
[[ -f /etc/systemd/system/career-dashboard-public-boards.timer ]] || PUBLIC_BOARDS_NEW=1
systemctl is-active --quiet career-dashboard-public-boards.timer && PUBLIC_BOARDS=1 || true
[[ -f /etc/systemd/system/career-dashboard-public-http.timer ]] || PUBLIC_HTTP_NEW=1
systemctl is-active --quiet career-dashboard-public-http.timer && PUBLIC_HTTP=1 || true
systemctl is-active --quiet career-dashboard-web-discovery.timer && WEB_DISCOVERY=1 || true
[[ -f /etc/systemd/system/career-dashboard-canonical-api.timer ]] || CANONICAL_API_NEW=1
systemctl is-active --quiet career-dashboard-canonical-api.timer && CANONICAL_API=1 || true
systemctl is-active --quiet career-dashboard-first-collections.timer && FIRST_COLLECTIONS=1 || true
systemctl is-active --quiet career-dashboard-rotation-balance.timer && ROTATION_BALANCE=1 || true
systemctl is-active --quiet career-dashboard-scheduler.timer && SCHEDULE=1 || true
systemctl is-active --quiet career-dashboard-watchdog.timer && WATCHDOG=1 || true
systemctl is-active --quiet career-dashboard-acquisition.service && ACQUISITION=1 || true
# Weekly board review, including the guarded liveness write arm. Stop it so a
# deploy never interrupts a pass mid-scan, then restore its previous timer state.
systemctl is-active --quiet career-dashboard-board-pruning.timer && PRUNING=1 || true
# Weekly Common Crawl sweep. A pass can run for hours, so it is stopped with the
# rest and restored only if it was running beforehand.
systemctl is-active --quiet career-dashboard-discovery.timer && DISCOVERY=1 || true
# The licensed browser is a single serial worker. Preserve its timer state and
# let an in-flight batch finish before changing the release underneath it.
systemctl is-active --quiet career-dashboard-canonical-resolver.timer && CANONICAL_RESOLVER=1 || true
systemctl is-active --quiet career-dashboard-gusto.timer && GUSTO=1 || true
systemctl is-active --quiet career-dashboard-stats-warm.timer && STATS_WARM=1 || true
# The exhaustive audit is a direct, durable worker. Its database run is the
# recovery authority: a transient failure can put systemd between restart
# attempts exactly when a deployment begins, even though the audit still has
# committed work to finish.
if systemctl is-active --quiet career-dashboard-discovery-audit.service; then
 DISCOVERY_AUDIT=1
elif runuser -u career-dashboard -- node "$STAGE/scripts/with-env.mjs" node "$STAGE/scripts/deployment/discovery-audit-resume-needed.cjs"; then
 DISCOVERY_AUDIT=1
else
 AUDIT_RESUME_RESULT=$?
 (( AUDIT_RESUME_RESULT == 1 )) || { echo 'Could not establish discovery-audit recovery state.' >&2; exit "$AUDIT_RESUME_RESULT"; }
fi
[[ $MODE != maintenance ]] || { SCHEDULE=0; WATCHDOG=0; ACQUISITION=0; PRUNING=0; DISCOVERY=0; DISCOVERY_AUDIT=0; CANONICAL_RESOLVER=0; GUSTO=0; }
[[ $MODE != maintenance ]] || STATS_WARM=0
[[ $MODE != maintenance ]] || ROTATION_BALANCE=0
[[ $MODE != maintenance ]] || FIRST_COLLECTIONS=0
[[ $MODE != maintenance ]] || CANONICAL_API=0
[[ $MODE != maintenance ]] || PUBLIC_BOARDS=0
[[ $MODE != maintenance ]] || PUBLIC_HTTP=0
[[ $MODE != maintenance ]] || WEB_DISCOVERY=0
resume_discovery_audit() {
 (( DISCOVERY_AUDIT == 0 )) && return
 if runuser -u career-dashboard -- node "$STAGE/scripts/with-env.mjs" node "$STAGE/scripts/deployment/discovery-audit-resume-needed.cjs"; then
  systemctl start career-dashboard-discovery-audit.service
  return
 else
  AUDIT_RESUME_RESULT=$?
  (( AUDIT_RESUME_RESULT == 1 )) || { echo 'Could not confirm the discovery audit still needs recovery.' >&2; return "$AUDIT_RESUME_RESULT"; }
 fi
}
restart_background() {
 (( ACQUISITION == 0 )) || systemctl start career-dashboard-acquisition.service
 (( SCHEDULE == 0 )) || systemctl start career-dashboard-scheduler.timer
 (( WATCHDOG == 0 )) || systemctl start career-dashboard-watchdog.timer
 (( PRUNING == 0 )) || systemctl start career-dashboard-board-pruning.timer
 (( DISCOVERY == 0 )) || systemctl start career-dashboard-discovery.timer
 (( CANONICAL_RESOLVER == 0 )) || systemctl start career-dashboard-canonical-resolver.timer
 (( CANONICAL_API == 0 )) || systemctl start career-dashboard-canonical-api.timer
 (( GUSTO == 0 )) || systemctl start career-dashboard-gusto.timer
 (( PUBLIC_BOARDS == 0 )) || systemctl start career-dashboard-public-boards.timer
 (( PUBLIC_HTTP == 0 )) || systemctl start career-dashboard-public-http.timer
 (( WEB_DISCOVERY == 0 )) || systemctl start career-dashboard-web-discovery.timer
 (( STATS_WARM == 0 )) || systemctl start career-dashboard-stats-warm.timer
 (( FIRST_COLLECTIONS == 0 )) || systemctl start career-dashboard-first-collections.timer
 (( ROTATION_BALANCE == 0 )) || systemctl start career-dashboard-rotation-balance.timer
 resume_discovery_audit
}
SWAPPED=0
recover() {
 echo 'Release failed; preserving the database and restoring prior application routing.' >&2
 systemctl stop career-dashboard-web-discovery.timer career-dashboard-web-discovery.service 2>/dev/null || true
 if [[ ! -f $OLD/scripts/deployment/m70/career-dashboard-web-discovery.timer ]]; then
  WEB_DISCOVERY=0
  systemctl disable career-dashboard-web-discovery.timer 2>/dev/null || true
  rm -f /etc/systemd/system/career-dashboard-web-discovery.timer /etc/systemd/system/career-dashboard-web-discovery.service
 fi
 systemctl stop career-dashboard-public-http.timer career-dashboard-public-http.service 2>/dev/null || true
 if [[ ! -f $OLD/scripts/deployment/m70/career-dashboard-public-http.timer ]]; then
  systemctl disable career-dashboard-public-http.timer 2>/dev/null || true
  rm -f /etc/systemd/system/career-dashboard-public-http.timer /etc/systemd/system/career-dashboard-public-http.service
 fi
 systemctl stop career-dashboard-public-boards.timer career-dashboard-public-boards.service 2>/dev/null || true
 if [[ ! -f $OLD/scripts/deployment/m70/career-dashboard-public-boards.timer ]]; then
  systemctl disable career-dashboard-public-boards.timer 2>/dev/null || true
  rm -f /etc/systemd/system/career-dashboard-public-boards.timer /etc/systemd/system/career-dashboard-public-boards.service
 fi
 systemctl stop career-dashboard-canonical-api.timer career-dashboard-canonical-api.service 2>/dev/null || true
 if [[ ! -f $OLD/scripts/deployment/m70/career-dashboard-canonical-api.timer ]]; then
  systemctl disable career-dashboard-canonical-api.timer 2>/dev/null || true
  rm -f /etc/systemd/system/career-dashboard-canonical-api.timer /etc/systemd/system/career-dashboard-canonical-api.service
 fi
 systemctl stop career-dashboard-first-collections.timer career-dashboard-first-collections.service 2>/dev/null || true
 (( FIRST_COLLECTIONS != 0 )) || systemctl disable career-dashboard-first-collections.timer 2>/dev/null || true
 systemctl stop career-dashboard-rotation-balance.timer career-dashboard-rotation-balance.service 2>/dev/null || true
 (( ROTATION_BALANCE != 0 )) || systemctl disable career-dashboard-rotation-balance.timer 2>/dev/null || true
 systemctl stop career-dashboard-stats-warm.timer career-dashboard-stats-warm.service 2>/dev/null || true
 (( STATS_WARM != 0 )) || systemctl disable career-dashboard-stats-warm.timer 2>/dev/null || true
 if (( SWAPPED == 1 )); then
   systemctl stop career-dashboard.service
   ln -sfn "$OLD" "$APP.rollback"; mv -Tf "$APP.rollback" "$APP"
   cp /etc/career-dashboard/acquisition-release.env.previous /etc/career-dashboard/acquisition-release.env
 fi
 if [[ -d $OLD/scripts/deployment/m70 ]]; then
  install -o root -g root -m 644 "$OLD"/scripts/deployment/m70/* /etc/systemd/system/
  install -o root -g root -m 755 "$OLD/scripts/deployment/m70-backup.sh" /usr/local/sbin/career-m70-backup
  if [[ -f $OLD/scripts/deployment/install-m70-maintenance.sh ]]; then
   bash "$OLD/scripts/deployment/install-m70-maintenance.sh" --install-only
  fi
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
systemctl stop career-dashboard-first-collections.timer 2>/dev/null || true
systemctl stop career-dashboard-rotation-balance.timer 2>/dev/null || true
systemctl stop career-dashboard-discovery.timer 2>/dev/null || true
systemctl stop career-dashboard-canonical-resolver.timer 2>/dev/null || true
systemctl stop career-dashboard-canonical-api.timer 2>/dev/null || true
systemctl stop career-dashboard-gusto.timer 2>/dev/null || true
systemctl stop career-dashboard-public-boards.timer 2>/dev/null || true
systemctl stop career-dashboard-public-http.timer 2>/dev/null || true
systemctl stop career-dashboard-web-discovery.timer career-dashboard-web-discovery.service 2>/dev/null || true
systemctl stop career-dashboard-stats-warm.timer 2>/dev/null || true
systemctl stop career-dashboard-stats-warm.service 2>/dev/null || true
systemctl stop career-dashboard-discovery-audit.service 2>/dev/null || true
curl -fsS --max-time 15 -X POST http://100.107.116.123:3000/api/pipeline/stop?mode=quiesce
systemctl stop career-dashboard-acquisition.service
# Let a current watchdog/scheduler invocation finish rather than interrupting its DB work.
for unit in career-dashboard-first-collections.service career-dashboard-watchdog.service career-dashboard-scheduler.service career-dashboard-board-pruning.service career-dashboard-rotation-balance.service career-dashboard-discovery.service career-dashboard-discovery-audit.service career-dashboard-canonical-api.service career-dashboard-canonical-resolver.service career-dashboard-gusto.service career-dashboard-public-boards.service career-dashboard-public-http.service; do
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
cd "$STAGE"
BACKUP_REQUIRED=1
if (( FORCE_PREDEPLOY_BACKUP == 1 )); then
 echo 'A fresh pre-deployment database backup was explicitly requested.'
elif runuser -u career-dashboard -- node scripts/with-env.mjs npx prisma migrate status; then
 BACKUP_REQUIRED=0
 echo 'Database schema already matches this release; skipping the pre-deployment backup.'
else
 echo 'Migration status is pending or uncertain; requiring a fresh pre-deployment backup.'
fi
if (( BACKUP_REQUIRED == 1 )); then
 # Leave one full nightly reserve after creating the migration snapshot.
 python3 "$STAGE/scripts/deployment/m70-storage.py" check-capacity --extra-backup
fi
systemctl stop career-dashboard.service
# A fresh recovery point precedes every pending or uncertain schema migration.
# Failed migrations never restore old database data automatically.
if (( BACKUP_REQUIRED == 1 )); then
 runuser -u career-dashboard -- node scripts/with-env.mjs node scripts/deployment/backup-postgres.mjs "$SHARED/backups/predeploy-$(date -u +%Y%m%dT%H%M%SZ).dump"
fi
runuser -u career-dashboard -- node scripts/with-env.mjs npx prisma migrate deploy
cp /etc/career-dashboard/acquisition-release.env /etc/career-dashboard/acquisition-release.env.previous
printf 'ATS_WORKER_RELEASE_ID=%s\n' "$REV" > /etc/career-dashboard/acquisition-release.env
chown root:career-dashboard /etc/career-dashboard/acquisition-release.env
chmod 640 /etc/career-dashboard/acquisition-release.env
ln -sfn "$STAGE" "$APP.next"; mv -Tf "$APP.next" "$APP"
SWAPPED=1
install -o root -g root -m 644 "$STAGE"/scripts/deployment/m70/* /etc/systemd/system/
install -o root -g root -m 755 "$STAGE/scripts/deployment/m70-backup.sh" /usr/local/sbin/career-m70-backup
bash "$STAGE/scripts/deployment/install-m70-maintenance.sh" --install-only
systemctl daemon-reload
systemctl start career-dashboard.service
HEALTHY=0
for ((i=0;i<40;i++)); do
 if curl -fsS --max-time 10 http://100.107.116.123:3000/api/health > /dev/null; then HEALTHY=1; break; fi
 sleep 3
done
(( HEALTHY == 1 ))
# Populate the visitor-facing cache before resuming the acquisition workload.
# A successful health check alone does not exercise the expensive Stats reads.
systemctl start career-dashboard-stats-warm.service
curl -fsS --max-time 10 -D - -o /dev/null http://100.107.116.123:3000/api/stats \
 | grep -i '^x-career-stats-cache: hit' > /dev/null
restart_background
if [[ $MODE == normal ]]; then
 systemctl enable --now career-dashboard-stats-warm.timer
 # Enable the separated API resolver on its first installation; later releases
 # preserve an operator's stopped or disabled timer instead of re-enabling it.
 if (( CANONICAL_API_NEW == 1 )); then
  systemctl enable --now career-dashboard-canonical-api.timer
 fi
 # Initialize the release's workload reservations and bounded weekly review.
 # Maintenance failure must not roll back an otherwise healthy release.
 if ! systemctl start career-dashboard-rotation-balance.service; then
  echo 'ATS workload review failed; discovery retains deterministic assignment until the next daily review.' >&2
 fi
 systemctl enable --now career-dashboard-rotation-balance.timer
 systemctl enable --now career-dashboard-first-collections.timer
 if (( PUBLIC_BOARDS_NEW == 1 )); then
  systemctl enable --now career-dashboard-public-boards.timer
 fi
 # HTTP collection inherits the enabled browser lane only on first install.
 # Later releases preserve an operator's stopped timer, as maintenance does.
 if (( PUBLIC_HTTP_NEW == 1 && (PUBLIC_BOARDS == 1 || PUBLIC_BOARDS_NEW == 1) )); then
  systemctl enable --now career-dashboard-public-http.timer
 fi
fi
trap - ERR
touch "$STAGE/.m70-activation-complete"
python3 "$STAGE/scripts/deployment/m70-storage.py" cleanup --apply --deploy-lock-held --protect-release "$OLD" \
 || echo 'Release is healthy, but obsolete-release cleanup needs attention.' >&2
echo "Activated $REV on M70; preserved database, shared files and background-service ownership."
