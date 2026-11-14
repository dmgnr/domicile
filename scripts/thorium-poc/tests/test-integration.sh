#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SCRIPT="$ROOT/scripts/thorium-poc/integrate.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "$*" >&2; exit 1; }

make_repo() {
  local path="$1"
  mkdir -p "$path"
  git -C "$path" init -q
  git -C "$path" config user.email fixture@example.invalid
  git -C "$path" config user.name Fixture
}

make_repo "$TMP/chromium"
mkdir -p "$TMP/chromium/chrome/browser" "$TMP/thorium/src/chrome/browser" "$TMP/thorium/patch_scripts/series"
for component in components content third_party ui; do mkdir -p "$TMP/chromium/$component" "$TMP/thorium/src/$component"; done
printf 'base\n' > "$TMP/chromium/chrome/browser/shared.cc"
cp "$TMP/chromium/chrome/browser/shared.cc" "$TMP/thorium/src/chrome/browser/shared.cc"
git -C "$TMP/chromium" add .
git -C "$TMP/chromium" commit -qm base
BASE_COMMIT="$(git -C "$TMP/chromium" rev-parse HEAD)"
git -C "$TMP/thorium" init -q
git -C "$TMP/thorium" config user.email fixture@example.invalid
git -C "$TMP/thorium" config user.name Fixture
printf 'thorium overlay\n' > "$TMP/thorium/src/chrome/browser/overlay.cc"
git -C "$TMP/thorium" add .
git -C "$TMP/thorium" commit -qm thorium
THORIUM_PIN="$(git -C "$TMP/thorium" rev-parse HEAD)"

# Thorium's patch changes the shared source first.
printf 'base\nthorium patch\n' > "$TMP/chromium/chrome/browser/shared.cc"
git -C "$TMP/chromium" add .
git -C "$TMP/chromium" commit -qm thorium-patch
git -C "$TMP/chromium" format-patch -1 --stdout > "$TMP/thorium/patch_scripts/series/first.patch"
cat > "$TMP/thorium/patch_scripts/series/series" <<'SERIES'
patch_scripts/series/first.patch
other/allow-insecure-downloads.patch
other/disable-download-quarantine.patch
other/disable-encryption.patch
SERIES
git -C "$TMP/chromium" reset --hard -q HEAD~
git -C "$TMP/chromium" apply "$TMP/thorium/patch_scripts/series/first.patch"
git -C "$TMP/chromium" add .
git -C "$TMP/chromium" commit -qm thorium-applied

mkdir -p "$TMP/domicile" "$TMP/domicile-source/components/domicile/browser"
printf 'shell-origin overlay\n' > "$TMP/domicile-source/components/domicile/browser/shell_origin.cc"
printf 'base\nthorium patch\ndomicile patch\n' > "$TMP/chromium/chrome/browser/shared.cc"
git -C "$TMP/chromium" add .
git -C "$TMP/chromium" commit -qm domicile-port
git -C "$TMP/chromium" format-patch -1 --stdout > "$TMP/domicile/0001.patch"
git -C "$TMP/chromium" reset --hard -q "$BASE_COMMIT"
cp -a "$TMP/chromium" "$TMP/chromium-pristine"

make_repo "$TMP/domicile-source-patch"
mkdir -p "$TMP/domicile-source-patch/components/domicile/browser"
printf 'shell-origin overlay\n' > "$TMP/domicile-source-patch/components/domicile/browser/shell_origin.cc"
git -C "$TMP/domicile-source-patch" add .
git -C "$TMP/domicile-source-patch" commit -qm domicile-source-base
printf 'shell-origin overlay\nDomicile patch\n' > "$TMP/domicile-source-patch/components/domicile/browser/shell_origin.cc"
git -C "$TMP/domicile-source-patch" add .
git -C "$TMP/domicile-source-patch" commit -qm domicile-source-patch
git -C "$TMP/domicile-source-patch" format-patch -1 --stdout > "$TMP/domicile/0002.patch"

if "$SCRIPT" --fixture --thorium-root "$TMP/thorium" --chromium-src "$TMP/chromium" --domicile-patches "$TMP/domicile" --domicile-series "$TMP/domicile" --domicile-source "$TMP/domicile-source" --pin "$THORIUM_PIN" >"$TMP/order.log" 2>&1; then
  :
else
  fail "integration fixture did not apply ordered patches: $(cat "$TMP/order.log")"
fi
grep -q 'thorium patch' "$TMP/chromium/chrome/browser/shared.cc" || fail "Thorium overlap was lost"
grep -q 'domicile patch' "$TMP/chromium/chrome/browser/shared.cc" || fail "Domicile overlap was lost"
[[ -f "$TMP/chromium/chrome/browser/overlay.cc" ]] || fail "Thorium overlay was not copied"
grep -Fxq 'shell-origin overlay' "$TMP/chromium/components/domicile/browser/shell_origin.cc" || fail "Domicile source overlay was not copied before patches"
grep -Fxq 'Domicile patch' "$TMP/chromium/components/domicile/browser/shell_origin.cc" || fail "Domicile patch did not apply after the source overlay"
grep -q 'fixture mode: GRD/XTB stage not executed' "$TMP/order.log" || fail "fixture falsely claimed GRD execution"
for patch in allow-insecure-downloads disable-download-quarantine disable-encryption; do
  grep -Fq "Excluded Thorium patch by security policy: other/$patch.patch" "$TMP/order.log" || fail "security exclusion was not reported: $patch"
done

cp -a "$TMP/chromium-pristine" "$TMP/chromium-pin"
if "$SCRIPT" --fixture --thorium-root "$TMP/thorium" --chromium-src "$TMP/chromium-pin" --domicile-patches "$TMP/domicile" --domicile-series "$TMP/domicile" --domicile-source "$TMP/domicile-source" --pin wrong >"$TMP/pin.log" 2>&1; then fail "pin mismatch unexpectedly passed"; fi
grep -q 'pin verification failed' "$TMP/pin.log" || fail "pin mismatch diagnostic missing"

cp -a "$TMP/chromium-pristine" "$TMP/chromium-domicile-source"
if "$SCRIPT" --fixture --thorium-root "$TMP/thorium" --chromium-src "$TMP/chromium-domicile-source" --domicile-patches "$TMP/domicile" --domicile-series "$TMP/domicile" --domicile-source "$TMP/missing-domicile-source" --pin "$THORIUM_PIN" >"$TMP/domicile-source.log" 2>&1; then fail "missing Domicile source overlay unexpectedly passed"; fi
grep -q 'required Domicile source overlay is missing' "$TMP/domicile-source.log" || fail "Domicile source overlay failure diagnostic missing: $(cat "$TMP/domicile-source.log")"

if "$SCRIPT" --fixture --thorium-root "$TMP/thorium" --chromium-src "$TMP/missing-chromium" --domicile-patches "$TMP/domicile" --domicile-series "$TMP/domicile" --pin "$THORIUM_PIN" >"$TMP/source.log" 2>&1; then fail "missing source checkout unexpectedly passed"; fi
grep -q 'Chromium source is not a Git checkout' "$TMP/source.log" || fail "source checkout failure diagnostic missing"

cp -a "$TMP/chromium-pristine" "$TMP/chromium-child"
if "$SCRIPT" --fixture --thorium-root "$TMP/thorium" --chromium-src "$TMP/chromium-child" --domicile-patches "$TMP/domicile" --domicile-series "$TMP/domicile" --domicile-source "$TMP/domicile-source" --pin "$THORIUM_PIN" --require-child "$TMP/missing-child" >"$TMP/child.log" 2>&1; then fail "missing child repo unexpectedly passed"; fi
grep -q 'required child repository' "$TMP/child.log" || fail "child repo failure diagnostic missing"

cp -a "$TMP/chromium-pristine" "$TMP/chromium-grd"
if "$SCRIPT" --fixture --thorium-root "$TMP/thorium" --chromium-src "$TMP/chromium-grd" --domicile-patches "$TMP/domicile" --domicile-series "$TMP/domicile" --domicile-source "$TMP/domicile-source" --pin "$THORIUM_PIN" --require-grd "$TMP/missing-grd" >"$TMP/grd.log" 2>&1; then fail "missing GRD stage unexpectedly passed"; fi
grep -q 'required GRD stage' "$TMP/grd.log" || fail "GRD failure diagnostic missing"

echo "Thorium integration fixture tests passed"
