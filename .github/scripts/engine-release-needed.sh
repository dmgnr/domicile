#!/usr/bin/env bash
# Decide what this run must do for the engine release, and write it to
# $GITHUB_OUTPUT.
#
#   .github/scripts/engine-release-needed.sh
#
#   build=true|false     the release configuration has to be compiled
#   write=true|false     engine-release.nix has to be regenerated and pushed
#   tag=engine-sXXXXXXX  the release this series belongs under
#   identity=<sha256>    the series, in full
#
# This lets an engine change build, publish and pin its release in one pull
# request. Releases are named after the series (a content hash of the pin,
# `patches/` and `src/`), so the name is known before merge. The tarball hash
# is written back to the branch; see engine-release-publish.sh.
#
# A needless `build=true` costs hours on `crux`. A wrong `build=false` is
# caught later by packages/ci/tests/test-the-pinned-engine-is-this-series.sh.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
IDENTITY="$("$ROOT/.github/scripts/engine-series-stamp.sh" identity)"
TAG="engine-s${IDENTITY:0:12}"

say() { [ -z "${GITHUB_OUTPUT:-}" ] || printf '%s\n' "$1" >>"$GITHUB_OUTPUT"; }
say "identity=$IDENTITY"
say "tag=$TAG"

# Reuse the check that fails the pull request, so the two cannot disagree.
if "$ROOT/packages/ci/tests/test-the-pinned-engine-is-this-series.sh" >/dev/null 2>&1; then
  echo "engine-release.nix already names this series ($TAG); nothing to build and nothing to write"
  say "build=false"
  say "write=false"
  exit 0
fi

say "write=true"

# Skip the build if this series is already published. Chromium builds are not
# reproducible, and the publisher never replaces an existing release, so a
# rebuild would produce a tarball nothing uses. Published in the builds
# repository; see engine-release-publish.sh.
BUILDS_REPO="${DOMICILE_BUILDS_REPO:-cprussin/domicile-builds}"
: "${GITHUB_TOKEN:?a token is needed to ask whether this series is published}"
if curl -sS -f -o /dev/null \
     -H "Authorization: Bearer $GITHUB_TOKEN" \
     -H "Accept: application/vnd.github+json" \
     -H "X-GitHub-Api-Version: 2022-11-28" \
     "https://api.github.com/repos/$BUILDS_REPO/releases/tags/$TAG"; then
  echo "$TAG is already published; this run only has to write engine-release.nix onto it"
  say "build=false"
  exit 0
fi

echo "$TAG is not published; this run builds the release configuration and publishes it"
say "build=true"
