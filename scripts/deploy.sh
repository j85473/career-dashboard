#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

PI_USER="${PI_USER:-j85473}"
PI_HOST="${PI_HOST:-192.168.1.208}"
DEST_DIR="${DEST_DIR:-/opt/career-dashboard}"
SERVICE_NAME="${SERVICE_NAME:-career-dashboard}"
APP_BACKUP_RETENTION="${APP_BACKUP_RETENTION:-3}"
DB_BACKUP_RETENTION="${DB_BACKUP_RETENTION:-7}"
FAILED_RELEASE_RETENTION="${FAILED_RELEASE_RETENTION:-2}"
HEALTHCHECK_URL_OVERRIDE="${HEALTHCHECK_URL:-}"
RELEASE_ID="$(date -u +%Y%m%dT%H%M%SZ)"
STAGE_DIR="${DEST_DIR}.stage-${RELEASE_ID}"
BACKUP_DIR="${DEST_DIR}.backup-${RELEASE_ID}"
DB_BACKUP_DIR="${DEST_DIR}.db-backups"
DB_BACKUP_PATH="${DB_BACKUP_DIR}/career-dashboard-${RELEASE_ID}.dump"
REMOTE="${PI_USER}@${PI_HOST}"

if [[ ! -t 0 || ! -t 2 ]] && [[ -z "${PI_SUDO_PASSWORD:-}" ]]; then
  echo "Run this deployment from an interactive terminal so remote sudo can prompt safely, or provide PI_SUDO_PASSWORD." >&2
  exit 1
fi

if [[ ! "$PI_USER" =~ ^[a-zA-Z0-9._-]+$ ]] || [[ ! "$PI_HOST" =~ ^[a-zA-Z0-9.:-]+$ ]] || [[ ! "$DEST_DIR" =~ ^/[a-zA-Z0-9._/-]+$ ]] || [[ ! "$SERVICE_NAME" =~ ^[a-zA-Z0-9@._-]+$ ]] || [[ "$DEST_DIR" == *"//"* ]] || [[ "$DEST_DIR" == *"/../"* ]] || [[ "$DEST_DIR" == */.. ]]; then
  echo "Unsafe deployment configuration." >&2
  exit 1
fi
if [[ -n "$HEALTHCHECK_URL_OVERRIDE" && ! "$HEALTHCHECK_URL_OVERRIDE" =~ ^http://[a-zA-Z0-9.:-]+/api/health$ ]]; then
  echo "HEALTHCHECK_URL must be an HTTP URL ending in /api/health without credentials or query parameters." >&2
  exit 1
fi
for retention in "$APP_BACKUP_RETENTION" "$DB_BACKUP_RETENTION" "$FAILED_RELEASE_RETENTION"; do
  if [[ ! "$retention" =~ ^[1-9][0-9]*$ ]] || (( retention > 50 )); then
    echo "Backup retention values must be integers between 1 and 50." >&2
    exit 1
  fi
done

for required_file in \
  scripts/deployment/activate-release.sh \
  scripts/deployment/install-crontab-remote.sh \
  scripts/deployment/service-url.sh; do
  if [[ ! -f "$required_file" ]]; then
    echo "Missing required deployment helper: $required_file" >&2
    exit 1
  fi
done

STAGE_CREATED=false
cleanup_failed_stage() {
  local exit_code=$?
  trap - ERR
  if [[ "$STAGE_CREATED" == true ]]; then
    echo "Cleaning failed staging directory $STAGE_DIR..." >&2
    echo "The Pi may ask for your sudo password to remove the failed stage." >&2
    if [[ -n "${PI_SUDO_PASSWORD:-}" ]]; then
      ssh "$REMOTE" "if [[ -d '$STAGE_DIR' ]]; then echo '${PI_SUDO_PASSWORD}' | sudo -S -- rm -rf -- '$STAGE_DIR'; fi" || true
    else
      ssh -tt "$REMOTE" "if [[ -d '$STAGE_DIR' ]]; then sudo -- rm -rf -- '$STAGE_DIR'; fi" || true
    fi
  fi
  echo "Deployment failed. The production database was not automatically restored." >&2
  echo "If it was created, the pre-migration PostgreSQL backup is: $DB_BACKUP_PATH" >&2
  echo "Review writes made after that backup before performing any manual database recovery." >&2
  exit "$exit_code"
}
trap cleanup_failed_stage ERR

echo "Staging release $RELEASE_ID on $PI_HOST..."
echo "The Pi may ask for your sudo password to prepare the release directories."
if [[ -n "${PI_SUDO_PASSWORD:-}" ]]; then
  ssh "$REMOTE" \
    "echo '${PI_SUDO_PASSWORD}' | sudo -S -- install -d -m 0755 -o '$PI_USER' -g '$PI_USER' '$STAGE_DIR' && echo '${PI_SUDO_PASSWORD}' | sudo -S -- install -d -m 0700 -o '$PI_USER' -g '$PI_USER' '$DB_BACKUP_DIR'"
else
  ssh -tt "$REMOTE" \
    "sudo -- install -d -m 0755 -o '$PI_USER' -g '$PI_USER' '$STAGE_DIR' && sudo -- install -d -m 0700 -o '$PI_USER' -g '$PI_USER' '$DB_BACKUP_DIR'"
fi
STAGE_CREATED=true

rsync -az --delete \
  --exclude 'node_modules' \
  --exclude '.next' \
  --exclude '.git' \
  --exclude '.env*' \
  --exclude 'data/runtime' \
  --exclude 'data/resumes' \
  --exclude '*.db' \
  --exclude '*.backup*' \
  --exclude 'prisma/generated' \
  ./ "$REMOTE:$STAGE_DIR/"

ssh "$REMOTE" bash -s -- "$DEST_DIR" "$STAGE_DIR" "$DB_BACKUP_PATH" "$DB_BACKUP_DIR" "$DB_BACKUP_RETENTION" <<'BUILD_SCRIPT'
set -Eeuo pipefail
DEST_DIR="$1"
STAGE_DIR="$2"
DB_BACKUP_PATH="$3"
DB_BACKUP_DIR="$4"
DB_BACKUP_RETENTION="$5"

found_environment=false
for env_file in .env .env.production .env.local .env.production.local; do
  if [[ -f "$DEST_DIR/$env_file" ]]; then
    found_environment=true
    cp "$DEST_DIR/$env_file" "$STAGE_DIR/$env_file"
    chmod 600 "$STAGE_DIR/$env_file"
  fi
done
if [[ "$found_environment" != true ]]; then
  echo "An existing production .env, .env.production, .env.local, or .env.production.local file is required." >&2
  exit 1
fi

if [[ -d "$DEST_DIR/data/resumes" ]]; then
  mkdir -p "$STAGE_DIR/data"
  cp -a "$DEST_DIR/data/resumes" "$STAGE_DIR/data/resumes"
fi
mkdir -p "$STAGE_DIR/data/runtime"
if [[ -f "$DEST_DIR/data/runtime/cron.log" ]]; then
  cp "$DEST_DIR/data/runtime/cron.log" "$STAGE_DIR/data/runtime/cron.log"
fi

cd "$STAGE_DIR"
npm ci --include=dev
node scripts/with-env.mjs node scripts/deployment/require-env.mjs
node scripts/deployment/check-expand-only.mjs prisma/migrations
node scripts/with-env.mjs npx prisma generate --schema prisma/schema.prisma

# Compile and type-check the release before making any production database change.
node scripts/with-env.mjs npm run build

# Keep a verified, out-of-release backup before Prisma touches migration state.
node scripts/with-env.mjs node scripts/deployment/backup-postgres.mjs "$DB_BACKUP_PATH"
echo "Database recovery is manual; backup retained at $DB_BACKUP_PATH"

# Bound database backup growth even when a later deployment step fails.
mapfile -t database_backups < <(
  find "$DB_BACKUP_DIR" -maxdepth 1 -type f -name 'career-dashboard-*.dump' -printf '%T@ %p\n' \
    | sort -rn | cut -d' ' -f2-
)
for ((index=DB_BACKUP_RETENTION; index<${#database_backups[@]}; index++)); do
  rm -f -- "${database_backups[$index]}"
done

set +e
MIGRATION_OUTPUT="$(node scripts/with-env.mjs npx prisma migrate deploy --schema prisma/schema.prisma 2>&1)"
MIGRATION_STATUS=$?
set -e
printf '%s\n' "$MIGRATION_OUTPUT"

if [[ $MIGRATION_STATUS -ne 0 ]]; then
  if [[ "$MIGRATION_OUTPUT" != *"P3005"* ]]; then
    echo "Migration deployment failed before activation. No migration was resolved automatically." >&2
    echo "Inspect 'prisma migrate status' and the output above. Backup: $DB_BACKUP_PATH" >&2
    exit "$MIGRATION_STATUS"
  fi

  echo "Legacy db-push database detected. Verifying exact baseline compatibility before resolving migration history..."
  set +e
  BASELINE_DIFF="$(node scripts/with-env.mjs npx prisma migrate diff \
    --from-schema-datasource prisma/schema.baseline.prisma \
    --to-schema-datamodel prisma/schema.baseline.prisma \
    --exit-code 2>&1)"
  BASELINE_STATUS=$?
  set -e

  if [[ $BASELINE_STATUS -eq 2 ]]; then
    echo "Legacy database does not exactly match the expected baseline. Refusing to mark it applied." >&2
    printf '%s\n' "$BASELINE_DIFF" >&2
    echo "Backup: $DB_BACKUP_PATH" >&2
    exit 1
  elif [[ $BASELINE_STATUS -ne 0 ]]; then
    echo "Unable to verify the legacy database baseline. Refusing to continue." >&2
    printf '%s\n' "$BASELINE_DIFF" >&2
    echo "Backup: $DB_BACKUP_PATH" >&2
    exit "$BASELINE_STATUS"
  fi

  node scripts/with-env.mjs npx prisma migrate resolve \
    --schema prisma/schema.prisma \
    --applied 20260715160000_baseline

  set +e
  MIGRATION_OUTPUT="$(node scripts/with-env.mjs npx prisma migrate deploy --schema prisma/schema.prisma 2>&1)"
  MIGRATION_STATUS=$?
  set -e
  printf '%s\n' "$MIGRATION_OUTPUT"
  if [[ $MIGRATION_STATUS -ne 0 ]]; then
    echo "Hardening migration failed after baselining. Do not restore automatically." >&2
    echo "Inspect 'prisma migrate status' and recover deliberately from backup: $DB_BACKUP_PATH" >&2
    exit "$MIGRATION_STATUS"
  fi
fi

node scripts/with-env.mjs npx prisma migrate status --schema prisma/schema.prisma
BUILD_SCRIPT

echo "Activating staged release..."
echo "The Pi may ask for your sudo password again to activate the healthy release."
if [[ -n "${PI_SUDO_PASSWORD:-}" ]]; then
  ssh "$REMOTE" \
    "echo '${PI_SUDO_PASSWORD}' | sudo -S -- bash '$STAGE_DIR/scripts/deployment/activate-release.sh' \
    '$DEST_DIR' '$STAGE_DIR' '$BACKUP_DIR' '$SERVICE_NAME' '$DB_BACKUP_PATH' \
    '$APP_BACKUP_RETENTION' '$DB_BACKUP_RETENTION' '$FAILED_RELEASE_RETENTION' '$PI_USER' '$HEALTHCHECK_URL_OVERRIDE'"
else
  ssh -tt "$REMOTE" \
    "sudo -- bash '$STAGE_DIR/scripts/deployment/activate-release.sh' \
    '$DEST_DIR' '$STAGE_DIR' '$BACKUP_DIR' '$SERVICE_NAME' '$DB_BACKUP_PATH' \
    '$APP_BACKUP_RETENTION' '$DB_BACKUP_RETENTION' '$FAILED_RELEASE_RETENTION' '$PI_USER' '$HEALTHCHECK_URL_OVERRIDE'"
fi

STAGE_CREATED=false
trap - ERR
echo "Deployment complete."
