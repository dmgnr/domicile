#!/usr/bin/env bash
# Checks that CHROMIUM_VERSION is the version of the revision CHROMIUM_PIN
# names, by reading that revision's chrome/VERSION from GitHub's mirror. The
# website shows both, so a repin that forgets the version fails here.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
ENGINE="$ROOT/packages/domicile-engine"
PIN="$(tail -1 "$ENGINE/CHROMIUM_PIN")"
URL="https://raw.githubusercontent.com/chromium/chromium/$PIN/chrome/VERSION"

# GitHub rate-limits reads of chromium/chromium, from Actions runners above
# all. When the mirror refuses, the same file comes from Chromium's own Gitiles
# (base64, as ?format=TEXT serves it), then through the API with CI's token.
GITILES="https://chromium.googlesource.com/chromium/src/+/$PIN/chrome/VERSION?format=TEXT"
API="https://api.github.com/repos/chromium/chromium/contents/chrome/VERSION?ref=$PIN"
read_upstream() {
  local version
  curl -fsS --max-time 30 --retry 2 --retry-all-errors --retry-delay 5 "$URL" && return
  if version="$(curl -fsS --max-time 30 --retry 2 --retry-all-errors --retry-delay 5 "$GITILES")"; then
    printf '%s' "$version" | base64 -d && return
  fi
  [ -n "${GITHUB_TOKEN:-}" ] || return 1
  curl -fsS --max-time 30 --retry 2 --retry-all-errors --retry-delay 5 \
    -H "Authorization: Bearer $GITHUB_TOKEN" \
    -H "Accept: application/vnd.github.raw" "$API"
}

ERRORS="$(mktemp)"
trap 'rm -f "$ERRORS"' EXIT
if ! UPSTREAM="$(read_upstream 2>"$ERRORS")"; then
  # What curl said, so a refusal in CI says whose and why.
  SAID="$(sort -u "$ERRORS" | tr '\n' ' ')"
  TOKEN="no token"
  [ -n "${GITHUB_TOKEN:-}" ] && TOKEN="token tried"
  echo "SKIP: could not read $URL ($TOKEN; $SAID)"
  exit 77
fi
EXPECTED="$(printf '%s\n' "$UPSTREAM" | sed -n 's/^[A-Z]*=//p' | paste -sd.)"
ACTUAL="$(cat "$ENGINE/CHROMIUM_VERSION" 2>/dev/null)"

if [ "$ACTUAL" = "$EXPECTED" ]; then
  echo "PASS: CHROMIUM_VERSION is $EXPECTED, the pin's"
else
  echo "FAIL: CHROMIUM_VERSION is '$ACTUAL', but $PIN is Chromium $EXPECTED. Write $EXPECTED to packages/domicile-engine/CHROMIUM_VERSION."
  exit 1
fi
