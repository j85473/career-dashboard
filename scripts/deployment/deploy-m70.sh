#!/bin/bash
set -euo pipefail
# Run from the CI checkout after tests/build. No Pi password is used on M70.
ACTIVATION_MODE="${ACTIVATION_MODE:-normal}"
[[ $ACTIVATION_MODE == normal || $ACTIVATION_MODE == maintenance ]] || { echo "ACTIVATION_MODE must be 'normal' or 'maintenance'" >&2; exit 2; }
REMOTE=j85473@100.107.116.123
REV=$(git rev-parse HEAD)
[[ $REV =~ ^[a-f0-9]{40}$ ]]
[[ -z $(git status --porcelain --untracked-files=no) ]]
STAGE=/opt/career-dashboard-releases/$REV
ssh "$REMOTE" "sudo -n install -d -o j85473 -g career-dashboard -m 750 '$STAGE'"
git archive HEAD | ssh "$REMOTE" "sudo -n tar -xf - -C '$STAGE'"
if [[ -n ${RAPIDAPI_KEYS:-} ]]; then
 printf '%s' "$RAPIDAPI_KEYS" | ssh "$REMOTE" "sudo -n /usr/local/bin/node '$STAGE/scripts/deployment/rapidapi-key-env.mjs' apply /etc/career-dashboard/runtime.env && sudo -n chown root:career-dashboard /etc/career-dashboard/runtime.env && sudo -n chmod 640 /etc/career-dashboard/runtime.env"
fi
ssh "$REMOTE" "sudo -n bash '$STAGE/scripts/deployment/activate-m70.sh' '$REV' '$ACTIVATION_MODE'"
