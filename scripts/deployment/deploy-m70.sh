#!/bin/bash
set -euo pipefail
# Run from the CI checkout after tests/build. No Pi password is used on M70.
REMOTE=j85473@100.107.116.123
REV=$(git rev-parse HEAD)
[[ $REV =~ ^[a-f0-9]{40}$ ]]
[[ -z $(git status --porcelain --untracked-files=no) ]]
STAGE=/opt/career-dashboard-releases/$REV
ssh "$REMOTE" "sudo -n install -d -o j85473 -g career-dashboard -m 750 '$STAGE'"
git archive HEAD | ssh "$REMOTE" "tar -xf - -C '$STAGE'"
ssh "$REMOTE" "sudo -n bash '$STAGE/scripts/deployment/activate-m70.sh' '$REV'"
