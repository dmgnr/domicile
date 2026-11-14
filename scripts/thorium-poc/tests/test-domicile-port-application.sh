#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SCRIPT="$ROOT/scripts/thorium-poc/apply-domicile-ports.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "$*" >&2; exit 1; }

mkdir -p "$TMP/chromium"
git -C "$TMP/chromium" init -q
git -C "$TMP/chromium" config user.email fixture@example.invalid
git -C "$TMP/chromium" config user.name Fixture
printf 'header\nbase\nkeep1\nkeep2\nkeep3\nkeep4\nkeep5\ntail\n' > "$TMP/chromium/shared.cc"
git -C "$TMP/chromium" add shared.cc
git -C "$TMP/chromium" commit -qm base

mkdir -p "$TMP/patches"
printf 'header\nthorium\nkeep1\nkeep2\nkeep3\nkeep4\nkeep5\ntail\n' > "$TMP/chromium/shared.cc"
git -C "$TMP/chromium" add shared.cc
git -C "$TMP/chromium" commit -qm thorium
THORIUM_COMMIT="$(git -C "$TMP/chromium" rev-parse HEAD)"
git -C "$TMP/chromium" reset --hard -q HEAD~1
printf 'header\nbase\nkeep1\nkeep2\nkeep3\nkeep4\nkeep5\ndomicile\n' > "$TMP/chromium/shared.cc"
git -C "$TMP/chromium" add shared.cc
git -C "$TMP/chromium" commit -qm domicile-port
git -C "$TMP/chromium" format-patch -1 --stdout > "$TMP/patches/0001-domicile.patch"
git -C "$TMP/chromium" reset --hard -q "$THORIUM_COMMIT"
git -C "$TMP/chromium" reset --hard -q HEAD~1

# Match Thorium's canonical `git apply --reject`: source changes are unstaged.
printf 'header\nthorium\nkeep1\nkeep2\nkeep3\nkeep4\nkeep5\ntail\n' > "$TMP/chromium/shared.cc"

if "$SCRIPT" --root "$TMP/chromium" --patches "$TMP/patches" >"$TMP/apply.log" 2>&1; then
  :
else
  fail "Domicile port did not apply after an unstaged Thorium patch: $(cat "$TMP/apply.log")"
fi
grep -q '^thorium$' "$TMP/chromium/shared.cc" || fail "Thorium change was lost"
grep -q '^domicile$' "$TMP/chromium/shared.cc" || fail "Domicile change was lost"

echo "Domicile port application tests passed"
