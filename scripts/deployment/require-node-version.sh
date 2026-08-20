#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="${1:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
NODE_BIN="${2:-$(command -v node || true)}"
VERSION_FILE="$PROJECT_ROOT/.nvmrc"

if [[ ! -f "$VERSION_FILE" ]]; then
  echo "Node runtime check failed: missing $VERSION_FILE." >&2
  exit 1
fi

EXPECTED_NODE_VERSION="$(tr -d '[:space:]' < "$VERSION_FILE")"
if [[ ! "$EXPECTED_NODE_VERSION" =~ ^[0-9]+([.][0-9]+){0,2}$ ]]; then
  echo "Node runtime check failed: $VERSION_FILE must contain a numeric Node version." >&2
  exit 1
fi
EXPECTED_NODE_MAJOR="${EXPECTED_NODE_VERSION%%.*}"

if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  echo "Node runtime check failed: no executable Node binary was found." >&2
  exit 1
fi

ACTUAL_NODE_VERSION="$($NODE_BIN --version)"
if [[ ! "$ACTUAL_NODE_VERSION" =~ ^v([0-9]+)([.][0-9]+){1,2}$ ]]; then
  echo "Node runtime check failed: unexpected version from $NODE_BIN: $ACTUAL_NODE_VERSION" >&2
  exit 1
fi
ACTUAL_NODE_MAJOR="${BASH_REMATCH[1]}"

if [[ "$ACTUAL_NODE_MAJOR" != "$EXPECTED_NODE_MAJOR" ]]; then
  echo "Node runtime mismatch: $VERSION_FILE requires Node $EXPECTED_NODE_MAJOR, but $NODE_BIN reports $ACTUAL_NODE_VERSION." >&2
  echo "Select the repository runtime (for example, run 'nvm use') before continuing." >&2
  exit 1
fi

echo "Node runtime aligned: $ACTUAL_NODE_VERSION ($NODE_BIN; $VERSION_FILE requires $EXPECTED_NODE_VERSION)."
