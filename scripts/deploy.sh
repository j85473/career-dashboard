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
ACTIVATION_MODE="${ACTIVATION_MODE:-normal}"
RELEASE_ID="$(date -u +%Y%m%dT%H%M%SZ)"
STAGE_DIR="${DEST_DIR}.stage-${RELEASE_ID}"
BACKUP_DIR="${DEST_DIR}.backup-${RELEASE_ID}"
DB_BACKUP_DIR="${DB_BACKUP_DIR:-${DEST_DIR}.db-backups}"
DB_BACKUP_PATH="${DB_BACKUP_DIR}/career-dashboard-${RELEASE_ID}.dump"
REMOTE="${PI_USER}@${PI_HOST}"

if ! git -c core.fsmonitor=false rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Deployment must run from a Git worktree." >&2
  exit 1
fi
DEPLOY_COMMIT="$(git -c core.fsmonitor=false rev-parse --verify HEAD)"
DEPLOY_STATUS="$(git -c core.fsmonitor=false status --porcelain=v1 --untracked-files=all)"
if [[ -n "$DEPLOY_STATUS" ]]; then
  echo "Deployment blocked: commit or remove every tracked modification and untracked file first." >&2
  printf '%s\n' "$DEPLOY_STATUS" >&2
  exit 1
fi

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
if [[ "$ACTIVATION_MODE" != "normal" && "$ACTIVATION_MODE" != "maintenance" ]]; then
  echo "ACTIVATION_MODE must be 'normal' or 'maintenance'." >&2
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
MAINTENANCE_CRON_DISABLED=false
MAINTENANCE_SERVICE_STOPPED=false
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
  if [[ "$MAINTENANCE_CRON_DISABLED" == true ]]; then
    echo "Career Dashboard cron remains disabled for repair safety." >&2
    echo "After resolving the failure, re-enable the prior release explicitly with:" >&2
    echo "sudo -- runuser -u '$PI_USER' -- bash '$DEST_DIR/scripts/deployment/install-crontab-remote.sh' '$DEST_DIR' '' '$SERVICE_NAME'" >&2
  fi
  if [[ "$MAINTENANCE_SERVICE_STOPPED" == true ]]; then
    echo "Restarting the prior application release with its pipeline cron still disabled..." >&2
    if [[ -n "${PI_SUDO_PASSWORD:-}" ]]; then
      ssh "$REMOTE" "echo '${PI_SUDO_PASSWORD}' | sudo -S -- systemctl start '$SERVICE_NAME'" || \
        echo "Warning: unable to restart $SERVICE_NAME automatically." >&2
    else
      ssh -tt "$REMOTE" "sudo -- systemctl start '$SERVICE_NAME'" || \
        echo "Warning: unable to restart $SERVICE_NAME automatically." >&2
    fi
  fi
  echo "If it was created, the pre-migration PostgreSQL backup is: $DB_BACKUP_PATH" >&2
  echo "Review writes made after that backup before performing any manual database recovery." >&2
  exit "$exit_code"
}
trap cleanup_failed_stage ERR

run_remote_quiescence_gate() {
  local app_dir="$1"
  local schedule_dir="$2"
  ssh "$REMOTE" bash -s -- "$app_dir" "$schedule_dir" <<'QUIESCENCE_GATE'
set -Eeuo pipefail
APP_DIR="$1"
SCHEDULE_DIR="$2"
cd "$APP_DIR"

if [[ ! -f scripts/with-env.mjs || ! -d node_modules/@prisma/client ]]; then
  echo "Maintenance quiescence gate requires the installed application and Prisma Client in $APP_DIR." >&2
  exit 1
fi

node scripts/with-env.mjs node <<'QUIESCENCE_QUERY'
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

function count(row) {
  return Number(row?.count || 0);
}

async function main() {
  const [pipelineRows, jobRows, contextRows, schemaRows] = await Promise.all([
    prisma.$queryRawUnsafe(`
      SELECT COUNT(*)::bigint AS count
      FROM "PipelineState"
      WHERE "isRunning" = true OR "lockToken" IS NOT NULL
    `),
    prisma.$queryRawUnsafe(`
      SELECT COUNT(*)::bigint AS count
      FROM "Job"
      WHERE "batchJobId" IS NOT NULL
         OR "jdBatchId" IS NOT NULL
         OR "afBatchId" IS NOT NULL
         OR "contextBatchId" IS NOT NULL
         OR "scoringStatus" = 'scoring'
    `),
    prisma.$queryRawUnsafe(`
      SELECT COUNT(*)::bigint AS count
      FROM "ContextProfile"
      WHERE "batchJobId" IS NOT NULL OR "linkedinBatchId" IS NOT NULL
    `),
    prisma.$queryRawUnsafe(`
      SELECT
        to_regclass('"IngestionTask"') IS NOT NULL AS "ingestionTask",
        to_regclass('"ScoringBatch"') IS NOT NULL AS "scoringBatch"
    `),
  ]);
  const ingestionRows = schemaRows[0]?.ingestionTask
    ? await prisma.$queryRawUnsafe(`
        SELECT COUNT(*)::bigint AS count
        FROM "IngestionTask"
        WHERE "leaseToken" IS NOT NULL OR status = 'running'
      `)
    : [{ count: 0 }];
  const scoringRows = schemaRows[0]?.scoringBatch
    ? await prisma.$queryRawUnsafe(`
        SELECT COUNT(*)::bigint AS count
        FROM "ScoringBatch" b
        WHERE b.status IN ('exported', 'superseded')
           OR EXISTS (SELECT 1 FROM "ScoringBatchItem" i WHERE i."batchId" = b.id AND i.status = 'leased')
      `)
    : [{ count: 0 }];
  const active = {
    pipelineStates: count(pipelineRows[0]),
    manualScoringBatches: count(scoringRows[0]),
    jobLeases: count(jobRows[0]),
    contextLeases: count(contextRows[0]),
    ingestionLeases: count(ingestionRows[0]),
  };
  process.stdout.write(`${JSON.stringify(active)}\n`);
  if (Object.values(active).some((value) => value !== 0)) {
    throw new Error('Maintenance quiescence gate failed: active database work remains');
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
QUIESCENCE_QUERY

FLOCK_BIN="$(command -v flock || true)"
if [[ -z "$FLOCK_BIN" || ! -x "$FLOCK_BIN" ]]; then
  echo "Maintenance quiescence gate requires flock." >&2
  exit 1
fi
mkdir -p "$SCHEDULE_DIR/data/runtime"
if ! "$FLOCK_BIN" -n "$SCHEDULE_DIR/data/runtime/schedule.lock" true; then
  echo "Maintenance quiescence gate failed: the current cron process still holds schedule.lock." >&2
  exit 1
fi
echo "Maintenance quiescence gate passed: database leases and the cron process lock are idle."
QUIESCENCE_GATE
}

echo "Staging clean Git release $DEPLOY_COMMIT as $RELEASE_ID on $PI_HOST..."
echo "The Pi may ask for your sudo password to prepare the release directories."
if [[ -n "${PI_SUDO_PASSWORD:-}" ]]; then
  ssh "$REMOTE" \
    "if [[ -e '$STAGE_DIR' ]]; then echo 'Release stage already exists: $STAGE_DIR' >&2; exit 1; fi; echo '${PI_SUDO_PASSWORD}' | sudo -S -- install -d -m 0755 -o '$PI_USER' -g '$PI_USER' '$STAGE_DIR' && echo '${PI_SUDO_PASSWORD}' | sudo -S -- install -d -m 0700 -o '$PI_USER' -g '$PI_USER' '$DB_BACKUP_DIR'"
else
  ssh -tt "$REMOTE" \
    "if [[ -e '$STAGE_DIR' ]]; then echo 'Release stage already exists: $STAGE_DIR' >&2; exit 1; fi; sudo -- install -d -m 0755 -o '$PI_USER' -g '$PI_USER' '$STAGE_DIR' && sudo -- install -d -m 0700 -o '$PI_USER' -g '$PI_USER' '$DB_BACKUP_DIR'"
fi
STAGE_CREATED=true

# The stage starts empty, and Git's NUL-delimited manifest is the only transfer
# authority. Ignored build output, eval runs, archives, and scratch files can
# never enter the release merely because they exist on the workstation.
rsync -az --from0 \
  --files-from=<(git -c core.fsmonitor=false ls-files -z) \
  ./ "$REMOTE:$STAGE_DIR/"

if [[ "$ACTIVATION_MODE" == "maintenance" ]]; then
  echo "Disabling the production pipeline cron before backup, migration, and activation..."
  if [[ -n "${PI_SUDO_PASSWORD:-}" ]]; then
    ssh "$REMOTE" \
      "echo '${PI_SUDO_PASSWORD}' | sudo -S -- runuser -u '$PI_USER' -- bash '$STAGE_DIR/scripts/deployment/install-crontab-remote.sh' '$DEST_DIR' '' '$SERVICE_NAME' disable"
  else
    ssh -tt "$REMOTE" \
      "sudo -- runuser -u '$PI_USER' -- bash '$STAGE_DIR/scripts/deployment/install-crontab-remote.sh' '$DEST_DIR' '' '$SERVICE_NAME' disable"
  fi
  MAINTENANCE_CRON_DISABLED=true

  echo "Verifying maintenance quiescence before stopping the production service..."
  run_remote_quiescence_gate "$DEST_DIR" "$DEST_DIR"

  echo "Stopping $SERVICE_NAME so no new application work can race the migration..."
  # Set this before sudo so the error trap also repairs the case where systemd
  # stops the service but the SSH command fails during readback verification.
  MAINTENANCE_SERVICE_STOPPED=true
  if [[ -n "${PI_SUDO_PASSWORD:-}" ]]; then
    ssh "$REMOTE" \
      "set -Eeuo pipefail; echo '${PI_SUDO_PASSWORD}' | sudo -S -- systemctl stop '$SERVICE_NAME'; if systemctl is-active --quiet '$SERVICE_NAME'; then echo '$SERVICE_NAME remained active after stop.' >&2; exit 1; fi"
  else
    ssh -tt "$REMOTE" \
      "set -Eeuo pipefail; sudo -- systemctl stop '$SERVICE_NAME'; if systemctl is-active --quiet '$SERVICE_NAME'; then echo '$SERVICE_NAME remained active after stop.' >&2; exit 1; fi"
  fi
fi

ssh "$REMOTE" bash -s -- "$DEST_DIR" "$STAGE_DIR" <<'BUILD_SCRIPT'
set -Eeuo pipefail
DEST_DIR="$1"
STAGE_DIR="$2"

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

# data/resumes now ships with the release. It must NOT be copied back from the
# previous deployment — the evaluator prompt is byte-bound to the baseline
# resume, so an older copy here would break scoring at runtime.
mkdir -p "$STAGE_DIR/data/runtime"
if [[ -f "$DEST_DIR/data/runtime/cron.log" ]]; then
  cp "$DEST_DIR/data/runtime/cron.log" "$STAGE_DIR/data/runtime/cron.log"
fi

cd "$STAGE_DIR"
npm ci
node scripts/with-env.mjs node scripts/deployment/require-env.mjs
node scripts/deployment/check-expand-only.mjs prisma/migrations
PRISMA_BIN="$STAGE_DIR/node_modules/.bin/prisma"
if [[ ! -x "$PRISMA_BIN" ]]; then
  echo "The pinned Prisma CLI is missing after npm ci: $PRISMA_BIN" >&2
  exit 1
fi
node scripts/with-env.mjs "$PRISMA_BIN" generate --schema prisma/schema.prisma
node scripts/with-env.mjs npm run build
BUILD_SCRIPT

if [[ "$ACTIVATION_MODE" == "maintenance" ]]; then
  echo "Re-verifying maintenance quiescence after the service stop and Pi build..."
  run_remote_quiescence_gate "$STAGE_DIR" "$DEST_DIR"
fi

ssh "$REMOTE" bash -s -- "$STAGE_DIR" "$DB_BACKUP_PATH" "$DB_BACKUP_DIR" "$DB_BACKUP_RETENTION" <<'MIGRATION_SCRIPT'
set -Eeuo pipefail
STAGE_DIR="$1"
DB_BACKUP_PATH="$2"
DB_BACKUP_DIR="$3"
DB_BACKUP_RETENTION="$4"
cd "$STAGE_DIR"
PRISMA_BIN="$STAGE_DIR/node_modules/.bin/prisma"
if [[ ! -x "$PRISMA_BIN" ]]; then
  echo "The pinned Prisma CLI disappeared before migration: $PRISMA_BIN" >&2
  exit 1
fi

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
MIGRATION_OUTPUT="$(node scripts/with-env.mjs "$PRISMA_BIN" migrate deploy --schema prisma/schema.prisma 2>&1)"
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
  BASELINE_DIFF="$(node scripts/with-env.mjs "$PRISMA_BIN" migrate diff \
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

  node scripts/with-env.mjs "$PRISMA_BIN" migrate resolve \
    --schema prisma/schema.prisma \
    --applied 20260715160000_baseline

  set +e
  MIGRATION_OUTPUT="$(node scripts/with-env.mjs "$PRISMA_BIN" migrate deploy --schema prisma/schema.prisma 2>&1)"
  MIGRATION_STATUS=$?
  set -e
  printf '%s\n' "$MIGRATION_OUTPUT"
  if [[ $MIGRATION_STATUS -ne 0 ]]; then
    echo "Hardening migration failed after baselining. Do not restore automatically." >&2
    echo "Inspect 'prisma migrate status' and recover deliberately from backup: $DB_BACKUP_PATH" >&2
    exit "$MIGRATION_STATUS"
  fi
fi

node scripts/with-env.mjs "$PRISMA_BIN" migrate status --schema prisma/schema.prisma
MIGRATION_SCRIPT

# The Pi keeps its own .env — deploys never rsync one — so RapidAPI keys used to
# be edited by hand there and drifted from the ones on the workstation. When the
# secret is present it becomes the source of truth for that single line.
#
# The value travels on stdin. Passing it as an argument would expose every key in
# the Pi's process list for the life of the command.
if [[ -n "${RAPIDAPI_KEYS:-}" ]]; then
  echo "Injecting RapidAPI keys into the staged environment..."
  printf '%s' "$RAPIDAPI_KEYS" | ssh "$REMOTE" "
    set -Eeuo pipefail
    env_file='$STAGE_DIR/.env'
    keys=\$(cat)
    if [[ -z \"\$keys\" ]]; then
      echo 'RAPIDAPI_KEYS secret resolved to an empty value; leaving the existing keys alone.' >&2
      exit 0
    fi
    # Written beside the target so the replacement is an atomic rename on the
    # same filesystem, and never world-readable in between.
    tmp=\$(mktemp \"\$env_file.XXXXXX\")
    chmod 600 \"\$tmp\"
    grep -v '^RAPIDAPI_KEYS=' \"\$env_file\" > \"\$tmp\" || true
    printf 'RAPIDAPI_KEYS=%s\n' \"\$keys\" >> \"\$tmp\"
    mv \"\$tmp\" \"\$env_file\"
    chmod 600 \"\$env_file\"
    echo \"Staged environment now carries \$(printf '%s' \"\$keys\" | tr ',' '\n' | grep -c .) RapidAPI key(s).\"
  "
else
  echo "No RAPIDAPI_KEYS secret provided; the Pi keeps whatever keys it already has."
fi

echo "Activating staged release..."
echo "The Pi may ask for your sudo password again to activate the healthy release."
if [[ -n "${PI_SUDO_PASSWORD:-}" ]]; then
  ssh "$REMOTE" \
    "echo '${PI_SUDO_PASSWORD}' | sudo -S -- bash '$STAGE_DIR/scripts/deployment/activate-release.sh' \
    '$DEST_DIR' '$STAGE_DIR' '$BACKUP_DIR' '$SERVICE_NAME' '$DB_BACKUP_PATH' \
    '$APP_BACKUP_RETENTION' '$DB_BACKUP_RETENTION' '$FAILED_RELEASE_RETENTION' '$PI_USER' '$HEALTHCHECK_URL_OVERRIDE' '$ACTIVATION_MODE'"
else
  ssh -tt "$REMOTE" \
    "sudo -- bash '$STAGE_DIR/scripts/deployment/activate-release.sh' \
    '$DEST_DIR' '$STAGE_DIR' '$BACKUP_DIR' '$SERVICE_NAME' '$DB_BACKUP_PATH' \
    '$APP_BACKUP_RETENTION' '$DB_BACKUP_RETENTION' '$FAILED_RELEASE_RETENTION' '$PI_USER' '$HEALTHCHECK_URL_OVERRIDE' '$ACTIVATION_MODE'"
fi

STAGE_CREATED=false
MAINTENANCE_SERVICE_STOPPED=false
trap - ERR
echo "Deployment complete."
