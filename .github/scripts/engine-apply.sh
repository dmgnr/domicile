#!/usr/bin/env bash
# Apply the patch series over the pin, and assert that it went on. Then put
# Electron's Node in, with engine-node.sh.
#
#   .github/scripts/engine-apply.sh <path to chromium/src>
#
# Runs outside Chromium's shell. `apply.sh` needs only git, grep, cp and find,
# and the shell's sandbox hides the exit status and output. Shared by all three
# engine workflows.
#
# `git am` commits each patch, so a HEAD still at the pin means nothing applied.
set -euo pipefail

CHROMIUM="${1:-}"
[ -n "$CHROMIUM" ] || {
  echo "usage: engine-apply.sh <path to chromium/src>" >&2
  exit 2
}

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

pin="$(grep -v '^#' packages/domicile-engine/CHROMIUM_PIN | tr -d '[:space:]')"
# A failed apply leaves the tree for a person to finish, and a build after
# that would make the snapshot stale. See engine-keep-mtimes.sh.
packages/domicile-engine/scripts/apply.sh "$CHROMIUM" || {
  .github/scripts/engine-keep-mtimes.sh drop "$CHROMIUM"
  exit 1
}
[ "$(git -C "$CHROMIUM" rev-parse HEAD)" != "$pin" ] || {
  .github/scripts/engine-keep-mtimes.sh drop "$CHROMIUM"
  echo "::error::apply.sh succeeded but the checkout is still at the pin, so no patch was applied" >&2
  exit 1
}
# Unchanged files get the mtime they had before the reset, so ninja rebuilds
# only what this series changed.
.github/scripts/engine-keep-mtimes.sh restore "$CHROMIUM"
echo "series applied: $(git -C "$CHROMIUM" log --oneline "$pin..HEAD" | wc -l) patches"
# Electron's Node and its patches to V8 and BoringSSL, which the build reads
# from checkouts of their own.
.github/scripts/engine-node.sh "$CHROMIUM"
