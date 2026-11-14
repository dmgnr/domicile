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

if "$SCRIPT" --root "$TMP/chromium" --series "$TMP/patches" --overrides "$TMP/patches" >"$TMP/apply.log" 2>&1; then
  :
else
  fail "Domicile port did not apply after an unstaged Thorium patch: $(cat "$TMP/apply.log")"
fi
grep -q '^thorium$' "$TMP/chromium/shared.cc" || fail "Thorium change was lost"
grep -q '^domicile$' "$TMP/chromium/shared.cc" || fail "Domicile change was lost"

# A port series replaces matching upstream patches and keeps every other patch.
mkdir -p "$TMP/source-patches" "$TMP/overrides"
mkdir -p "$TMP/series-chromium"
git -C "$TMP/series-chromium" init -q
git -C "$TMP/series-chromium" config user.email fixture@example.invalid
git -C "$TMP/series-chromium" config user.name Fixture
printf 'base\n' > "$TMP/series-chromium/override.txt"
printf 'base\n' > "$TMP/series-chromium/fallback.txt"
git -C "$TMP/series-chromium" add .
git -C "$TMP/series-chromium" commit -qm base
SERIES_BASE="$(git -C "$TMP/series-chromium" rev-parse HEAD)"

printf 'upstream\n' > "$TMP/series-chromium/override.txt"
git -C "$TMP/series-chromium" add override.txt
git -C "$TMP/series-chromium" commit -qm upstream-override
git -C "$TMP/series-chromium" format-patch -1 --stdout > "$TMP/source-patches/0001.patch"
UPSTREAM_OVERRIDE="$(git -C "$TMP/series-chromium" rev-parse HEAD)"
git -C "$TMP/series-chromium" reset --hard -q "$SERIES_BASE"
printf 'ported\n' > "$TMP/series-chromium/override.txt"
git -C "$TMP/series-chromium" add override.txt
git -C "$TMP/series-chromium" commit -qm ported-override
git -C "$TMP/series-chromium" format-patch -1 --stdout > "$TMP/overrides/0001.patch"
git -C "$TMP/series-chromium" reset --hard -q "$SERIES_BASE"

printf 'fallback-applied\n' > "$TMP/series-chromium/fallback.txt"
git -C "$TMP/series-chromium" add fallback.txt
git -C "$TMP/series-chromium" commit -qm upstream-fallback
git -C "$TMP/series-chromium" format-patch -1 --stdout > "$TMP/source-patches/0002.patch"
git -C "$TMP/series-chromium" reset --hard -q "$SERIES_BASE"

if "$SCRIPT" --root "$TMP/series-chromium" --series "$TMP/source-patches" --overrides "$TMP/overrides" >"$TMP/series.log" 2>&1; then
  :
else
  fail "ported series did not apply: $(cat "$TMP/series.log")"
fi
grep -q '^ported$' "$TMP/series-chromium/override.txt" || fail "matching override was not selected"
grep -q '^fallback-applied$' "$TMP/series-chromium/fallback.txt" || fail "unported original patch was skipped"

echo "Domicile port application tests passed"
