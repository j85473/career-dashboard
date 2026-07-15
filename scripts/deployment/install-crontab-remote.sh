#!/usr/bin/env bash
set -Eeuo pipefail

if (( $# < 1 || $# > 3 )); then
  echo "Usage: install-crontab-remote.sh <absolute-app-directory> [dashboard-base-url] [service-name]" >&2
  exit 2
fi

DEST_DIR="$1"
DASHBOARD_BASE_URL_OVERRIDE="${2:-}"
SERVICE_NAME="${3:-career-dashboard}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_URL_HELPER="$SCRIPT_DIR/service-url.sh"

if [[ ! "$DEST_DIR" =~ ^/[a-zA-Z0-9._/-]+$ ]] || [[ "$DEST_DIR" == *"//"* ]] || [[ "$DEST_DIR" == *"/../"* ]] || [[ "$DEST_DIR" == */.. ]]; then
  echo "Unsafe application directory for cron installation." >&2
  exit 1
fi

if [[ ! -f "$DEST_DIR/.env" && ! -f "$DEST_DIR/.env.production" && ! -f "$DEST_DIR/.env.local" && ! -f "$DEST_DIR/.env.production.local" ]]; then
  echo "Missing a supported dotenv file in $DEST_DIR" >&2
  exit 1
fi
if [[ ! -f "$SERVICE_URL_HELPER" ]]; then
  echo "Missing service URL helper: $SERVICE_URL_HELPER" >&2
  exit 1
fi

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
  const required = ["cron:discovery", "cron:pipeline", "cron:linkedin", "cron:reconcile"];
  const missing = required.filter((name) => typeof packageJson.scripts?.[name] !== "string");
  if (missing.length > 0) {
    console.error(`Missing required package scripts: ${missing.join(", ")}`);
    process.exit(1);
  }
' "$DEST_DIR/package.json"

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

mkdir -p "$DEST_DIR/data/runtime"
LOCK_FILE="$DEST_DIR/data/runtime/schedule.lock"
LOG_FILE="$DEST_DIR/data/runtime/cron.log"

{
  cat "$FILTERED_FILE"
  echo '# BEGIN CAREER DASHBOARD'
  echo "30 0 * * * cd $DEST_DIR && $FLOCK_BIN -w 43200 $LOCK_FILE env DASHBOARD_URL=$DASHBOARD_BASE_URL $NPM_BIN run cron:discovery >> $LOG_FILE 2>&1"
  echo "0 1 * * * cd $DEST_DIR && $FLOCK_BIN -w 43200 $LOCK_FILE env DASHBOARD_URL=$DASHBOARD_BASE_URL $NPM_BIN run cron:pipeline >> $LOG_FILE 2>&1"
  echo "30 4 * * * cd $DEST_DIR && $FLOCK_BIN -w 43200 $LOCK_FILE env DASHBOARD_URL=$DASHBOARD_BASE_URL $NPM_BIN run cron:linkedin >> $LOG_FILE 2>&1"
  echo "15 6 * * * cd $DEST_DIR && $FLOCK_BIN -w 43200 $LOCK_FILE env DASHBOARD_URL=$DASHBOARD_BASE_URL $NPM_BIN run cron:reconcile >> $LOG_FILE 2>&1"
  echo '# END CAREER DASHBOARD'
} > "$CANDIDATE_FILE"

if [[ "$(grep -c '^# BEGIN CAREER DASHBOARD$' "$CANDIDATE_FILE")" -ne 1 \
  || "$(grep -c '^# END CAREER DASHBOARD$' "$CANDIDATE_FILE")" -ne 1 \
  || "$(grep -c ' run cron:' "$CANDIDATE_FILE")" -ne 4 ]]; then
  echo "Generated cron schedule failed structural validation." >&2
  exit 1
fi
for script_name in discovery pipeline linkedin reconcile; do
  if [[ "$(grep -F -c "$NPM_BIN run cron:$script_name" "$CANDIDATE_FILE")" -ne 1 ]]; then
    echo "Generated cron schedule is missing cron:$script_name." >&2
    exit 1
  fi
done

echo "Installing Career Dashboard cron entries:"
sed -n '/# BEGIN CAREER DASHBOARD/,/# END CAREER DASHBOARD/p' "$CANDIDATE_FILE"

restore_original_crontab() {
  local exit_code=$?
  trap - ERR
  if [[ "$INSTALL_ATTEMPTED" == true ]]; then
    echo "Cron installation failed verification; restoring the previous crontab." >&2
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
echo "Career Dashboard cron schedule installed and verified." || true
exit 0
