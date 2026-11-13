#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SCRIPT="$ROOT/scripts/thorium-poc/preflight.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "$*" >&2; exit 1; }

# A single patch applies cleanly to a synthetic pinned checkout.
mkdir -p "$TMP/series/patches" "$TMP/base"
printf 'before\n' > "$TMP/base/file.txt"
git -C "$TMP/base" init -q
git -C "$TMP/base" config user.email test@example.invalid
git -C "$TMP/base" config user.name Test
git -C "$TMP/base" add file.txt
git -C "$TMP/base" commit -qm base
BASE="$(git -C "$TMP/base" rev-parse HEAD)"
git -C "$TMP/base" checkout -qb change
printf 'after\n' > "$TMP/base/file.txt"
git -C "$TMP/base" add file.txt
git -C "$TMP/base" commit -qm change
git -C "$TMP/base" format-patch -1 --stdout > "$TMP/series/patches/0001.patch"
git -C "$TMP/base" checkout -q "$BASE"
"$SCRIPT" --fixture "$TMP/series" "$TMP/base" >"$TMP/ok.log" 2>&1 || fail "applicable fixture patch failed"
grep -q '^after$' "$TMP/base/file.txt" || fail "fixture patch did not apply"

# A failing first patch exits nonzero and leaves actionable diagnostics.
git -C "$TMP/base" reset --hard -q "$BASE"
sed 's/-before/-missing/' "$TMP/series/patches/0001.patch" > "$TMP/series/patches/0001-bad.patch"
rm "$TMP/series/patches/0001.patch"
if "$SCRIPT" --fixture "$TMP/series" "$TMP/base" >"$TMP/fail.log" 2>&1; then fail "conflicting patch unexpectedly passed"; fi
grep -q '0001-bad.patch' "$TMP/fail.log" || fail "failure diagnostics omitted patch name"
grep -q 'does not apply' "$TMP/fail.log" || fail "failure diagnostics omitted git error"

if "$SCRIPT" --fixture "$TMP/series" "$TMP/missing" >"$TMP/missing.log" 2>&1; then fail "missing checkout unexpectedly passed"; fi
grep -q 'not a git checkout' "$TMP/missing.log" || fail "missing checkout diagnostic absent"
echo "thorium preflight fixture tests passed"
