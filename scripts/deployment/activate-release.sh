#!/usr/bin/env bash
set -Eeuo pipefail

if (( EUID != 0 )); then
  echo "activate-release.sh must be run through sudo." >&2
  exit 1
fi

if (( $# != 10 )); then
  echo "Usage: activate-release.sh <dest> <stage> <backup> <service> <db-backup> <app-retention> <db-retention> <failed-retention> <app-user> <healthcheck-url-or-empty>" >&2
  exit 2
fi

DEST_DIR="$1"
STAGE_DIR="$2"
BACKUP_DIR="$3"
SERVICE_NAME="$4"
DB_BACKUP_PATH="$5"
APP_BACKUP_RETENTION="$6"
DB_BACKUP_RETENTION="$7"
FAILED_RELEASE_RETENTION="$8"
APP_USER="$9"
HEALTHCHECK_URL_OVERRIDE="${10}"
DB_BACKUP_DIR="$(dirname "$DB_BACKUP_PATH")"
PARENT_DIR="$(dirname "$DEST_DIR")"
DEST_NAME="$(basename "$DEST_DIR")"
FAILED_DIR="${DEST_DIR}.failed-$(date -u +%Y%m%dT%H%M%SZ)"
CRON_INSTALLER="$STAGE_DIR/scripts/deployment/install-crontab-remote.sh"
SERVICE_URL_HELPER="$STAGE_DIR/scripts/deployment/service-url.sh"
RUNUSER_BIN="$(command -v runuser || true)"
CRONTAB_BIN="$(command -v crontab || true)"

if [[ ! "$APP_USER" =~ ^[a-zA-Z0-9._-]+$ ]] || [[ ! "$SERVICE_NAME" =~ ^[a-zA-Z0-9@._-]+$ ]]; then
  echo "Unsafe activation user or service name." >&2
  exit 1
fi
if [[ -n "$HEALTHCHECK_URL_OVERRIDE" && ! "$HEALTHCHECK_URL_OVERRIDE" =~ ^http://[a-zA-Z0-9.:-]+/api/health$ ]]; then
  echo "Unsafe health-check URL override." >&2
  exit 1
fi
for directory in "$DEST_DIR" "$STAGE_DIR" "$BACKUP_DIR" "$DB_BACKUP_DIR"; do
  if [[ ! "$directory" =~ ^/[a-zA-Z0-9._/-]+$ ]] || [[ "$directory" == *"//"* ]] || [[ "$directory" == *"/../"* ]] || [[ "$directory" == */.. ]]; then
    echo "Unsafe activation path: $directory" >&2
    exit 1
  fi
done
for retention in "$APP_BACKUP_RETENTION" "$DB_BACKUP_RETENTION" "$FAILED_RELEASE_RETENTION"; do
  if [[ ! "$retention" =~ ^[1-9][0-9]*$ ]] || (( retention > 50 )); then
    echo "Backup retention values must be integers between 1 and 50." >&2
    exit 1
  fi
done
if [[ ! -d "$DEST_DIR" || ! -d "$STAGE_DIR" || ! -f "$CRON_INSTALLER" || ! -f "$SERVICE_URL_HELPER" ]]; then
  echo "Production, staged release, cron installer, or service URL helper is missing." >&2
  exit 1
fi
if [[ "$STAGE_DIR" != "${DEST_DIR}.stage-"* \
  || "$BACKUP_DIR" != "${DEST_DIR}.backup-"* \
  || "$DB_BACKUP_DIR" != "${DEST_DIR}.db-backups" \
  || "$DB_BACKUP_PATH" != "$DB_BACKUP_DIR"/career-dashboard-*.dump ]]; then
  echo "Activation paths are not scoped to the expected release directories." >&2
  exit 1
fi
if [[ -z "$RUNUSER_BIN" || ! -x "$RUNUSER_BIN" || -z "$CRONTAB_BIN" || ! -x "$CRONTAB_BIN" ]] || ! id "$APP_USER" >/dev/null 2>&1; then
  echo "The activation user, runuser utility, or crontab utility is unavailable." >&2
  exit 1
fi

SERVICE_USER="$(systemctl show "$SERVICE_NAME" --property=User --value)"
SERVICE_WORKING_DIRECTORY="$(systemctl show "$SERVICE_NAME" --property=WorkingDirectory --value)"
if [[ "$SERVICE_USER" != "$APP_USER" ]]; then
  echo "The $SERVICE_NAME service runs as '$SERVICE_USER', not the expected application user '$APP_USER'." >&2
  exit 1
fi
if [[ "$SERVICE_WORKING_DIRECTORY" != "$DEST_DIR" ]]; then
  echo "The $SERVICE_NAME service uses '$SERVICE_WORKING_DIRECTORY', not the expected working directory '$DEST_DIR'." >&2
  exit 1
fi
for env_file in .env .env.production .env.local .env.production.local; do
  if [[ -f "$STAGE_DIR/$env_file" ]] && ! "$RUNUSER_BIN" -u "$APP_USER" -- test -r "$STAGE_DIR/$env_file"; then
    echo "The $SERVICE_NAME service user cannot read the staged $env_file file." >&2
    exit 1
  fi
done

source "$SERVICE_URL_HELPER"
HEALTHCHECK_BASE_URL="$(resolve_service_base_url "$SERVICE_NAME" "${HEALTHCHECK_URL_OVERRIDE%/api/health}")"
HEALTHCHECK_URL="${HEALTHCHECK_BASE_URL}/api/health"
echo "Activation health check target: $HEALTHCHECK_URL"

OLD_MOVED=false
NEW_MOVED=false
CRON_INSTALL_ATTEMPTED=false
CRON_HAD_ENTRIES=false
CRON_BACKUP_FILE="$(mktemp)"
CRON_ERROR_FILE="$(mktemp)"

cleanup() {
  rm -f "$CRON_BACKUP_FILE" "$CRON_ERROR_FILE" || true
}
trap cleanup EXIT

# The activation helper is already root, so use crontab's explicit user mode.
# Keeping the snapshot root-owned avoids protected /tmp permission failures and
# still lets rollback restore the exact file safely.
if "$CRONTAB_BIN" -u "$APP_USER" -l > "$CRON_BACKUP_FILE" 2> "$CRON_ERROR_FILE"; then
  CRON_HAD_ENTRIES=true
elif ! grep -qi 'no crontab' "$CRON_ERROR_FILE"; then
  echo "Unable to snapshot the existing application crontab; refusing to activate." >&2
  cat "$CRON_ERROR_FILE" >&2
  exit 1
fi

prune_directories() {
  local pattern="$1"
  local keep="$2"
  local status=0
  local -a directories=()
  mapfile -t directories < <(
    find "$PARENT_DIR" -maxdepth 1 -type d -name "$pattern" -printf '%T@ %p\n' \
      | sort -rn | cut -d' ' -f2-
  )
  for ((index=keep; index<${#directories[@]}; index++)); do
    rm -rf -- "${directories[$index]}" || status=1
  done
  return "$status"
}

prune_database_backups() {
  local status=0
  local -a backups=()
  mapfile -t backups < <(
    find "$DB_BACKUP_DIR" -maxdepth 1 -type f -name 'career-dashboard-*.dump' -printf '%T@ %p\n' \
      | sort -rn | cut -d' ' -f2-
  )
  for ((index=DB_BACKUP_RETENTION; index<${#backups[@]}; index++)); do
    rm -f -- "${backups[$index]}" || status=1
  done
  return "$status"
}

rollback() {
  local exit_code="${1:-1}"
  local failed_line="${2:-unknown}"
  local failed_command="${3:-unknown}"
  trap - ERR
  echo "Activation step failed at line $failed_line: $failed_command" >&2
  echo "Activation failed; rolling the application directory back." >&2
  systemctl stop "$SERVICE_NAME" || true
  if [[ "$NEW_MOVED" == true && -d "$DEST_DIR" ]]; then
    mv "$DEST_DIR" "$FAILED_DIR" || true
  fi
  if [[ "$OLD_MOVED" == true && -d "$BACKUP_DIR" ]]; then
    mv "$BACKUP_DIR" "$DEST_DIR" || true
  fi
  if [[ "$CRON_INSTALL_ATTEMPTED" == true ]]; then
    if [[ "$CRON_HAD_ENTRIES" == true ]]; then
      "$CRONTAB_BIN" -u "$APP_USER" "$CRON_BACKUP_FILE" || true
    else
      "$CRONTAB_BIN" -u "$APP_USER" -r 2>/dev/null || true
    fi
  fi
  if systemctl start "$SERVICE_NAME" && systemctl is-active --quiet "$SERVICE_NAME"; then
    echo "Previous application release restored and service is running." >&2
  else
    echo "Warning: the previous release was restored, but $SERVICE_NAME is not running." >&2
    systemctl status "$SERVICE_NAME" --no-pager --full -n 30 >&2 || true
  fi
  prune_directories "${DEST_NAME}.failed-*" "$FAILED_RELEASE_RETENTION" || true
  echo "The database was not auto-restored, preventing loss of writes made after the backup." >&2
  echo "Pre-migration database backup: $DB_BACKUP_PATH" >&2
  echo "Review database state and post-backup writes before any manual recovery." >&2
  exit "$exit_code"
}
trap 'rollback "$?" "$LINENO" "$BASH_COMMAND"' ERR

systemctl stop "$SERVICE_NAME"
mv "$DEST_DIR" "$BACKUP_DIR"
OLD_MOVED=true
mv "$STAGE_DIR" "$DEST_DIR"
NEW_MOVED=true

systemctl start "$SERVICE_NAME"
LAST_HEALTH_STATUS=0
LAST_HEALTH_OUTPUT=''
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if LAST_HEALTH_OUTPUT="$(curl --fail-with-body --silent --show-error --max-time 5 "$HEALTHCHECK_URL" 2>&1)"; then
    CRON_INSTALL_ATTEMPTED=true
    "$RUNUSER_BIN" -u "$APP_USER" -- bash "$DEST_DIR/scripts/deployment/install-crontab-remote.sh" \
      "$DEST_DIR" "$HEALTHCHECK_BASE_URL" "$SERVICE_NAME"

    # The healthy app and verified cron schedule are now committed together.
    trap - ERR

    if ! prune_directories "${DEST_NAME}.backup-*" "$APP_BACKUP_RETENTION"; then
      echo "Warning: unable to prune old application backups." >&2
    fi
    if ! prune_directories "${DEST_NAME}.failed-*" "$FAILED_RELEASE_RETENTION"; then
      echo "Warning: unable to prune failed releases." >&2
    fi
    if ! prune_directories "${DEST_NAME}.stage-*" 0; then
      echo "Warning: unable to prune stale staging directories." >&2
    fi
    if ! prune_database_backups; then
      echo "Warning: unable to prune old database backups." >&2
    fi

    echo "Deployment healthy. Application rollback copy retained at $BACKUP_DIR"
    echo "Pre-migration database backup retained at $DB_BACKUP_PATH"
    echo "Database recovery remains manual to protect writes made after the backup."
    exit 0
  else
    LAST_HEALTH_STATUS=$?
  fi
  sleep 3
done
echo "Health check did not succeed after 10 attempts: $HEALTHCHECK_URL" >&2
echo "Last health probe exited with status $LAST_HEALTH_STATUS." >&2
if [[ -n "$LAST_HEALTH_OUTPUT" ]]; then
  printf 'Last health response: %.1000s\n' "$LAST_HEALTH_OUTPUT" >&2
fi
systemctl status "$SERVICE_NAME" --no-pager --full -n 40 >&2 || true
journalctl -u "$SERVICE_NAME" -n 80 --no-pager >&2 || true
false
