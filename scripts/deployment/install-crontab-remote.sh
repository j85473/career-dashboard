#!/usr/bin/env bash
set -Eeuo pipefail

if (( $# < 1 || $# > 4 )); then
  echo "Usage: install-crontab-remote.sh <absolute-app-directory> [dashboard-base-url] [service-name] [enable|disable]" >&2
  exit 2
fi

DEST_DIR="$1"
DASHBOARD_BASE_URL_OVERRIDE="${2:-}"
SERVICE_NAME="${3:-career-dashboard}"
CRON_MODE="${4:-enable}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_URL_HELPER="$SCRIPT_DIR/service-url.sh"

if [[ ! "$DEST_DIR" =~ ^/[a-zA-Z0-9._/-]+$ ]] || [[ "$DEST_DIR" == *"//"* ]] || [[ "$DEST_DIR" == *"/../"* ]] || [[ "$DEST_DIR" == */.. ]]; then
  echo "Unsafe application directory for cron installation." >&2
  exit 1
fi
if [[ "$CRON_MODE" != "enable" && "$CRON_MODE" != "disable" ]]; then
  echo "Cron mode must be 'enable' or 'disable'." >&2
  exit 2
fi

if [[ "$CRON_MODE" == "enable" && ! -f "$DEST_DIR/.env" && ! -f "$DEST_DIR/.env.production" && ! -f "$DEST_DIR/.env.local" && ! -f "$DEST_DIR/.env.production.local" ]]; then
  echo "Missing a supported dotenv file in $DEST_DIR" >&2
  exit 1
fi
if [[ ! -f "$SERVICE_URL_HELPER" ]]; then
  echo "Missing service URL helper: $SERVICE_URL_HELPER" >&2
  exit 1
fi

FLOCK_BIN=''
NPM_BIN=''
DASHBOARD_BASE_URL=''
if [[ "$CRON_MODE" == "enable" ]]; then
  source "$SERVICE_URL_HELPER"
  DASHBOARD_BASE_URL="$(resolve_service_base_url "$SERVICE_NAME" "$DASHBOARD_BASE_URL_OVERRIDE")"
  FLOCK_BIN="$(command -v flock || true)"
  NPM_BIN="$(command -v npm || true)"
  NODE_BIN="$(command -v node || true)"
  if [[ -z "$FLOCK_BIN" || ! -x "$FLOCK_BIN" ]]; then
    echo "flock is required to serialize Career Dashboard cron jobs." >&2
    exit 1
  fi
  if [[ -z "$NPM_BIN" || ! -x "$NPM_BIN" ]]; then
    echo "npm is required to run Career Dashboard cron jobs." >&2
    exit 1
  fi
  if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" || ! -f "$DEST_DIR/package.json" ]]; then
    echo "node and package.json are required to validate Career Dashboard cron jobs." >&2
    exit 1
  fi

  "$NODE_BIN" -e '
  const packageJson = require(process.argv[1]);
  const required = ["cron:pipeline"];
  const missing = required.filter((name) => typeof packageJson.scripts?.[name] !== "string");
  if (missing.length > 0) {
    console.error(`Missing required package scripts: ${missing.join(", ")}`);
    process.exit(1);
  }
  if (typeof packageJson.dependencies?.tsx !== "string") {
    console.error("tsx must be a production dependency because cron:pipeline runs after npm ci --omit=dev.");
    process.exit(1);
  }
' "$DEST_DIR/package.json"

  if [[ ! -x "$DEST_DIR/node_modules/.bin/tsx" ]]; then
    echo "Missing production cron runtime: $DEST_DIR/node_modules/.bin/tsx" >&2
    exit 1
  fi
fi

ORIGINAL_FILE="$(mktemp)"
ORIGINAL_ERROR_FILE="$(mktemp)"
FILTERED_FILE="$(mktemp)"
CANDIDATE_FILE="$(mktemp)"
INSTALLED_FILE="$(mktemp)"
HAD_CRONTAB=false
INSTALL_ATTEMPTED=false
cleanup() {
  rm -f "$ORIGINAL_FILE" "$ORIGINAL_ERROR_FILE" "$FILTERED_FILE" "$CANDIDATE_FILE" "$INSTALLED_FILE"
}
trap cleanup EXIT

if crontab -l > "$ORIGINAL_FILE" 2> "$ORIGINAL_ERROR_FILE"; then
  HAD_CRONTAB=true
elif ! grep -qi 'no crontab' "$ORIGINAL_ERROR_FILE"; then
  echo "Unable to read the current crontab; refusing to replace it." >&2
  cat "$ORIGINAL_ERROR_FILE" >&2
  exit 1
fi

# Remove both the current managed block and every form emitted by the legacy
# installer. Unbalanced markers are rejected so unrelated entries cannot be
# swallowed by a partially edited block.
awk -v dest="$DEST_DIR" '
  /^# BEGIN CAREER DASHBOARD$/ {
    if (managed || legacy) invalid=1
    managed=1
    next
  }
  /^# END CAREER DASHBOARD$/ {
    if (!managed || legacy) invalid=1
    managed=0
    next
  }
  /^# --- CAREER DASHBOARD PIPELINE ---$/ {
    if (managed || legacy) invalid=1
    legacy=1
    next
  }
  legacy && /^# ---------------------------------$/ {
    legacy=0
    next
  }
  managed || legacy { next }
  (index($0, dest) || $0 ~ /career-dashboard/) && $0 ~ /scripts\/cron\// { next }
  $0 ~ /localhost:3000\/api\/jobs\/batch-(af|context)/ { next }
  { print }
  END {
    if (managed || legacy || invalid) {
      print "Unbalanced Career Dashboard cron markers; refusing to modify crontab." > "/dev/stderr"
      exit 42
    }
  }
' "$ORIGINAL_FILE" > "$FILTERED_FILE"

if [[ "$CRON_MODE" == "enable" ]]; then
  mkdir -p "$DEST_DIR/data/runtime"
  LOCK_FILE="$DEST_DIR/data/runtime/schedule.lock"
  LOG_DIR="$DEST_DIR/data/runtime"
  # One file per day, kept for 30. The previous single cron.log had no
  # timestamps on any line, so nothing could be aged out of it — it simply grew
  # (14 MB and climbing) and was copied into every release.
  LOG_RETENTION_DAYS="${LOG_RETENTION_DAYS:-30}"

  # A deploy now backs up only when a migration is pending, so it can no
  # longer be relied on to also produce Joseph's routine backup. This runs
  # daily independent of deploys, into the same directory and under the same
  # retention deploy.sh already prunes to. The "daily-" filename infix keeps
  # it from ever colliding with a deploy's own $DB_BACKUP_PATH.
  DB_BACKUP_DIR="${DB_BACKUP_DIR:-${DEST_DIR}.db-backups}"
  DB_BACKUP_RETENTION="${DB_BACKUP_RETENTION:-7}"
  BACKUP_LOCK_FILE="$DEST_DIR/data/runtime/backup.lock"
  BACKUP_KEEP_LINES=$((DB_BACKUP_RETENTION + 1))

  {
    cat "$FILTERED_FILE"
    echo '# BEGIN CAREER DASHBOARD'
    echo "* * * * * cd $DEST_DIR && $FLOCK_BIN -n $LOCK_FILE env DASHBOARD_URL=$DASHBOARD_BASE_URL $NPM_BIN run cron:pipeline >> $LOG_DIR/cron-\$(date +\\%Y\\%m\\%d).log 2>&1"
    echo "5 0 * * * find $LOG_DIR -maxdepth 1 \\( -name 'cron-*.log' -o -name 'backup-*.log' \\) -mtime +$LOG_RETENTION_DAYS -delete"
    echo "15 3 * * * cd $DEST_DIR && $FLOCK_BIN -n $BACKUP_LOCK_FILE $NODE_BIN scripts/with-env.mjs $NODE_BIN scripts/deployment/backup-postgres.mjs $DB_BACKUP_DIR/career-dashboard-daily-\$(date -u +\\%Y\\%m\\%dT\\%H\\%M\\%SZ).dump >> $LOG_DIR/backup-\$(date +\\%Y\\%m\\%d).log 2>&1"
    echo "25 3 * * * find $DB_BACKUP_DIR -maxdepth 1 -type f -name 'career-dashboard-*.dump' -printf '\\%T@ \\%p\\n' 2>/dev/null | sort -rn | tail -n +$BACKUP_KEEP_LINES | cut -d' ' -f2- | xargs -r rm -f --"
    echo '# END CAREER DASHBOARD'
  } > "$CANDIDATE_FILE"

  if [[ "$(grep -c '^# BEGIN CAREER DASHBOARD$' "$CANDIDATE_FILE")" -ne 1 \
    || "$(grep -c '^# END CAREER DASHBOARD$' "$CANDIDATE_FILE")" -ne 1 \
    || "$(grep -c ' run cron:' "$CANDIDATE_FILE")" -ne 1 \
    || "$(grep -c 'backup-postgres\.mjs' "$CANDIDATE_FILE")" -ne 1 ]]; then
    echo "Generated cron schedule failed structural validation." >&2
    exit 1
  fi
  if [[ "$(grep -F -c "$NPM_BIN run cron:pipeline" "$CANDIDATE_FILE")" -ne 1 ]]; then
    echo "Generated cron schedule is missing cron:pipeline." >&2
    exit 1
  fi
  echo "Installing Career Dashboard cron entries:"
  sed -n '/# BEGIN CAREER DASHBOARD/,/# END CAREER DASHBOARD/p' "$CANDIDATE_FILE"
else
  cp "$FILTERED_FILE" "$CANDIDATE_FILE"
  if grep -qE '^# (BEGIN|END) CAREER DASHBOARD$' "$CANDIDATE_FILE" \
    || awk -v dest="$DEST_DIR" '
      (index($0, dest) || $0 ~ /career-dashboard/) && ($0 ~ /run cron:pipeline/ || $0 ~ /scripts\/cron\//) { found=1 }
      END { exit(found ? 0 : 1) }
    ' "$CANDIDATE_FILE"; then
    echo "Generated maintenance crontab still contains a Career Dashboard trigger." >&2
    exit 1
  fi
  echo "Disabling Career Dashboard cron entries; unrelated entries are preserved."
fi

restore_original_crontab() {
  local exit_code=$?
  trap - ERR
  if [[ "$INSTALL_ATTEMPTED" == true ]]; then
    echo "Cron update failed verification; restoring the previous crontab." >&2
    if [[ "$HAD_CRONTAB" == true ]]; then
      crontab "$ORIGINAL_FILE" || true
    else
      crontab -r 2>/dev/null || true
    fi
  fi
  exit "$exit_code"
}
trap restore_original_crontab ERR

INSTALL_ATTEMPTED=true
crontab "$CANDIDATE_FILE"
crontab -l > "$INSTALLED_FILE"
if ! cmp -s "$CANDIDATE_FILE" "$INSTALLED_FILE"; then
  echo "Installed crontab did not match the validated schedule." >&2
  false
fi

trap - ERR
if [[ "$CRON_MODE" == "enable" ]]; then
  echo "Career Dashboard cron schedule installed and verified." || true
else
  echo "Career Dashboard cron schedule disabled and verified." || true
fi
exit 0
