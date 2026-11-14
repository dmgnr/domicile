#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
FILTER="$ROOT/scripts/thorium-poc/filter-thorium-series.py"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "$*" >&2; exit 1; }

cat > "$TMP/series" <<'SERIES'
# Default Thorium series order.
other/allow-insecure-downloads.patch
other/disable-download-quarantine.patch
other/keep-safe-default.patch
other/disable-encryption.patch
SERIES
cat > "$TMP/exclusions" <<'EXCLUSIONS'
# Preserve Chromium download safety and encryption defaults.
other/allow-insecure-downloads.patch
other/disable-download-quarantine.patch
other/disable-encryption.patch
EXCLUSIONS

if python3 "$FILTER" --series "$TMP/series" --exclusions "$TMP/exclusions" > "$TMP/filtered" 2> "$TMP/log"; then
  :
else
  fail "Thorium series policy rejected the fixture: $(cat "$TMP/log")"
fi
grep -Fxq 'other/keep-safe-default.patch' "$TMP/filtered" || fail "safe Thorium patch was omitted"
! grep -Eq 'allow-insecure-downloads|disable-download-quarantine|disable-encryption' "$TMP/filtered" || fail "unsafe Thorium security patch remained selected"

grep -Fq 'Excluded Thorium patch by security policy: other/allow-insecure-downloads.patch' "$TMP/log" || fail "insecure-download exclusion was not reported"
grep -Fq 'Excluded Thorium patch by security policy: other/disable-download-quarantine.patch' "$TMP/log" || fail "quarantine exclusion was not reported"
grep -Fq 'Excluded Thorium patch by security policy: other/disable-encryption.patch' "$TMP/log" || fail "encryption exclusion was not reported"

sed '/other\/disable-encryption.patch/d' "$TMP/series" > "$TMP/incomplete-series"
if python3 "$FILTER" --series "$TMP/incomplete-series" --exclusions "$TMP/exclusions" > "$TMP/ignored" 2> "$TMP/missing.log"; then
  fail "missing required security-policy patch unexpectedly passed"
fi
grep -Fq 'required Thorium patch is absent from series: other/disable-encryption.patch' "$TMP/missing.log" || fail "missing security-patch diagnostic is absent"

echo "Thorium series security policy tests passed"
