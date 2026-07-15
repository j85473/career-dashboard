#!/usr/bin/env bash
set -euo pipefail

PI_USER="${PI_USER:-j85473}"
PI_HOST="${PI_HOST:-192.168.1.208}"
DEST_DIR="${DEST_DIR:-/opt/career-dashboard}"
SERVICE_NAME="${SERVICE_NAME:-career-dashboard}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REMOTE_INSTALLER="$SCRIPT_DIR/deployment/install-crontab-remote.sh"

if [[ ! "$PI_USER" =~ ^[a-zA-Z0-9._-]+$ ]] || [[ ! "$PI_HOST" =~ ^[a-zA-Z0-9.:-]+$ ]] || [[ ! "$DEST_DIR" =~ ^/[a-zA-Z0-9._/-]+$ ]] || [[ ! "$SERVICE_NAME" =~ ^[a-zA-Z0-9@._-]+$ ]] || [[ "$DEST_DIR" == *"//"* ]] || [[ "$DEST_DIR" == *"/../"* ]] || [[ "$DEST_DIR" == */.. ]]; then
  echo "Unsafe PI_USER, PI_HOST, DEST_DIR, or SERVICE_NAME value." >&2
  exit 1
fi

if [[ ! -f "$REMOTE_INSTALLER" ]]; then
  echo "Missing local cron installer reference: $REMOTE_INSTALLER" >&2
  exit 1
fi

ssh "${PI_USER}@${PI_HOST}" \
  "bash '$DEST_DIR/scripts/deployment/install-crontab-remote.sh' '$DEST_DIR' '' '$SERVICE_NAME'"
