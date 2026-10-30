#!/usr/bin/env bash
set -euo pipefail

task_repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$task_repo_root"

# Scoring needs the TypeScript result builder, not a running Next.js app or DB.
node -e 'if (Number(process.versions.node.split(".")[0]) !== 24) throw new Error("Install Node.js 24 before running scoring setup")'
python3 -c 'import sys; assert sys.version_info >= (3, 9), "Python 3.9+ is required"'
npm ci --ignore-scripts --no-audit --no-fund

# Keep a provided cloud CLI. Its compatibility is checked before scoring.
if ! command -v codex >/dev/null 2>&1; then
  npm install --global --ignore-scripts --no-audit --no-fund @openai/codex@0.146.0
fi

python3 scripts/cloud/check_scoring_environment.py
