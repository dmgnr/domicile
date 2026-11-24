#!/usr/bin/env bash
# Fails while a Chromium pin roll is open: an open pull request that changes
# `packages/domicile-engine/CHROMIUM_PIN`. Nothing else merges during a roll,
# so Renovate, which automerges only on green checks, waits.
#
#   GH_TOKEN=... GITHUB_REPOSITORY=owner/repo .github/scripts/no-pin-roll-open.sh
#
# Each pull request's files are paged through: a roll touches hundreds.
set -euo pipefail

[ "$#" -eq 0 ] || {
  echo "usage: no-pin-roll-open.sh" >&2
  exit 2
}
REPO="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY names the repository}"

# Each answer is captured first, so a failed call fails the check.
open="$(gh api --paginate "repos/$REPO/pulls?state=open&per_page=100" --jq '.[].number')"
status=0
for number in $open; do
  files="$(gh api --paginate "repos/$REPO/pulls/$number/files?per_page=100" --jq '.[].filename')"
  if printf '%s\n' "$files" | grep -qx packages/domicile-engine/CHROMIUM_PIN; then
    echo "#$number rolls the Chromium pin; nothing merges until it lands"
    status=1
  fi
done
exit "$status"
