#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

MODE="${1:---check}"
ENV_FILE="${RAPIDAPI_ENV_FILE:-$PROJECT_ROOT/.env}"
PI_USER="${PI_USER:-j85473}"
PI_HOST="${PI_HOST:-100.107.116.123}"
DEST_DIR="${DEST_DIR:-/opt/career-dashboard}"
SERVICE_NAME="${SERVICE_NAME:-career-dashboard}"
REMOTE="$PI_USER@$PI_HOST"
HELPER="$PROJECT_ROOT/scripts/deployment/rapidapi-key-env.mjs"

if [[ "$MODE" != "--check" && "$MODE" != "--apply" && "$MODE" != "--apply-and-restart" ]]; then
  echo "Usage: $0 [--check|--apply|--apply-and-restart]" >&2
  exit 2
fi
if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing Mac environment file: $ENV_FILE" >&2
  exit 1
fi
if [[ ! "$PI_USER" =~ ^[a-zA-Z0-9._-]+$ || ! "$PI_HOST" =~ ^[a-zA-Z0-9.:-]+$ || ! "$DEST_DIR" =~ ^/[a-zA-Z0-9._/-]+$ ]]; then
  echo "Unsafe server synchronization configuration." >&2
  exit 1
fi

remote_fingerprint() {
  ssh "$REMOTE" "sudo -n /usr/local/bin/node '$DEST_DIR/scripts/deployment/rapidapi-key-env.mjs' fingerprint /etc/career-dashboard/runtime.env"
}

if [[ "$MODE" != "--check" ]]; then
  node "$HELPER" normalize "$ENV_FILE" >/dev/null
fi
local_fingerprint="$(node "$HELPER" fingerprint "$ENV_FILE")"

if [[ "$MODE" == "--check" ]]; then
  pi_fingerprint="$(remote_fingerprint)"
  printf 'Mac: %s\nM70: %s\n' "$local_fingerprint" "$pi_fingerprint"
  if [[ "$local_fingerprint" != "$pi_fingerprint" ]]; then
    echo "RapidAPI key drift detected. Run: npm run keys:sync" >&2
    exit 1
  fi
  echo "RapidAPI key sets match."
  exit 0
fi

for command in gh ssh; do
  command -v "$command" >/dev/null || { echo "Missing required command: $command" >&2; exit 1; }
done

secret_file="$(mktemp "${TMPDIR:-/tmp}/career-dashboard-rapidapi.XXXXXX")"
chmod 600 "$secret_file"
cleanup() { rm -f -- "$secret_file"; }
trap cleanup EXIT
node "$HELPER" export "$ENV_FILE" > "$secret_file"

echo "Updating the repository RAPIDAPI_KEYS secret from the canonical Mac list..."
gh secret set RAPIDAPI_KEYS < "$secret_file"

echo "Atomically replacing the M70 RapidAPI key family..."
ssh "$REMOTE" "sudo -n /usr/local/bin/node '$DEST_DIR/scripts/deployment/rapidapi-key-env.mjs' apply /etc/career-dashboard/runtime.env && sudo -n chown root:career-dashboard /etc/career-dashboard/runtime.env && sudo -n chmod 640 /etc/career-dashboard/runtime.env" < "$secret_file"

pi_fingerprint="$(remote_fingerprint)"
printf 'Mac: %s\nM70: %s\n' "$local_fingerprint" "$pi_fingerprint"
if [[ "$local_fingerprint" != "$pi_fingerprint" ]]; then
  echo "M70 verification failed after synchronization." >&2
  exit 1
fi

if [[ "$MODE" == "--apply-and-restart" ]]; then
  echo "Restarting $SERVICE_NAME so the synchronized keys become active..."
  ssh "$REMOTE" "sudo -n systemctl restart '$SERVICE_NAME' career-dashboard-acquisition.service && systemctl is-active --quiet '$SERVICE_NAME'"
else
  echo "Keys are synchronized on disk. Restart the service or deploy before expecting the running process to use them."
fi
echo "RapidAPI keys synchronized without printing secret values."
