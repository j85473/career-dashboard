#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

MODE="${1:---check}"
ENV_FILE="${RAPIDAPI_ENV_FILE:-$PROJECT_ROOT/.env}"
PI_USER="${PI_USER:-j85473}"
PI_HOST="${PI_HOST:-100.80.154.113}"
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
  echo "Unsafe Pi synchronization configuration." >&2
  exit 1
fi

remote_fingerprint() {
  ssh "$REMOTE" "node --input-type=module - fingerprint '$DEST_DIR/.env'" < "$HELPER"
}

if [[ "$MODE" != "--check" ]]; then
  node "$HELPER" normalize "$ENV_FILE" >/dev/null
fi
local_fingerprint="$(node "$HELPER" fingerprint "$ENV_FILE")"

if [[ "$MODE" == "--check" ]]; then
  pi_fingerprint="$(remote_fingerprint)"
  printf 'Mac: %s\nPi:  %s\n' "$local_fingerprint" "$pi_fingerprint"
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

echo "Atomically replacing the Pi RapidAPI key family..."
ssh "$REMOTE" "
  set -Eeuo pipefail
  env_file='$DEST_DIR/.env'
  keys=\$(cat)
  [[ -n \"\$keys\" ]]
  tmp=\$(mktemp \"\$env_file.rapidapi.XXXXXX\")
  trap 'rm -f -- \"\$tmp\"' EXIT
  chmod 600 \"\$tmp\"
  grep -Ev '^RAPIDAPI_KEY(S|_[0-9]+)?=' \"\$env_file\" > \"\$tmp\" || true
  printf 'RAPIDAPI_KEYS=%s\n' \"\$keys\" >> \"\$tmp\"
  mv \"\$tmp\" \"\$env_file\"
  chmod 600 \"\$env_file\"
  trap - EXIT
" < "$secret_file"

pi_fingerprint="$(remote_fingerprint)"
printf 'Mac: %s\nPi:  %s\n' "$local_fingerprint" "$pi_fingerprint"
if [[ "$local_fingerprint" != "$pi_fingerprint" ]]; then
  echo "Pi verification failed after synchronization." >&2
  exit 1
fi

if [[ "$MODE" == "--apply-and-restart" ]]; then
  echo "Restarting $SERVICE_NAME so the synchronized keys become active..."
  ssh -tt "$REMOTE" "sudo -- systemctl restart '$SERVICE_NAME' && systemctl is-active --quiet '$SERVICE_NAME'"
else
  echo "Keys are synchronized on disk. Restart the service or deploy before expecting the running process to use them."
fi
echo "RapidAPI keys synchronized without printing secret values."
