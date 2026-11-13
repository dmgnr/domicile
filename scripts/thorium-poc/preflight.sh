#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PATCH_DIR="$(cd "$ROOT/packages/domicile-engine/patches" && pwd)"
CHROMIUM_REF="fb096c0011f9d50f0a264a9376420cdea9c421e3"
CHROMIUM_URL="https://github.com/chromium/chromium.git"

if [[ "${1:-}" == "--fixture" ]]; then
  SERIES="$2"
  CHECKOUT="$3"
  OVERRIDE_PATCH="${4:-}"
else
  SERIES="$ROOT/packages/domicile-engine"
  CHECKOUT="${RUNNER_TEMP:-/tmp}/thorium-poc-chromium"
  OVERRIDE_PATCH="$ROOT/scripts/thorium-poc/patches/0001-domicile-build-the-non-renderer-frame-sink-broker.patch"
  rm -rf "$CHECKOUT"
  paths_file="${RUNNER_TEMP:-/tmp}/thorium-poc-paths"
  if grep -hE '^(rename from|rename to|deleted file mode) ' "$PATCH_DIR"/*.patch >/dev/null; then
    echo "renamed or deleted files are unsupported by this preflight" >&2
    exit 1
  fi
  grep -h '^diff --git ' "$PATCH_DIR"/*.patch | awk '{print $3; print $4}' | sed -E 's#^[ab]/##' | sort -u > "$paths_file"
  git clone --depth 1 --filter=blob:none --no-checkout "$CHROMIUM_URL" "$CHECKOUT"
  git -C "$CHECKOUT" sparse-checkout init --no-cone
  git -C "$CHECKOUT" sparse-checkout set --no-cone --stdin < "$paths_file"
  git -C "$CHECKOUT" fetch --depth 1 origin "$CHROMIUM_REF"
  git -C "$CHECKOUT" checkout --detach FETCH_HEAD
  actual="$(git -C "$CHECKOUT" rev-parse HEAD)"
  if [[ "$actual" != "$CHROMIUM_REF" ]]; then
    echo "Chromium checkout is $actual, expected $CHROMIUM_REF" >&2
    exit 1
  fi
fi

if ! git -C "$CHECKOUT" rev-parse --git-dir >/dev/null 2>&1; then
  echo "$CHECKOUT is not a git checkout" >&2
  exit 1
fi

shopt -s nullglob
patches=("$SERIES"/patches/*.patch)
if ((${#patches[@]} == 0)); then
  echo "no patch files found in $SERIES/patches" >&2
  exit 1
fi
git -C "$CHECKOUT" config user.name "Domicile Thorium POC"
git -C "$CHECKOUT" config user.email "domicile-thorium-poc@invalid.example"
for patch in "${patches[@]}"; do
  if [[ "$(basename "$patch")" == "0001-domicile-build-the-non-renderer-frame-sink-broker.patch" && -n "$OVERRIDE_PATCH" ]]; then
    patch="$OVERRIDE_PATCH"
    echo "Using isolated Chromium 156 POC override"
  fi
  echo "Applying $(basename "$patch")"
  if ! git -C "$CHECKOUT" am --keep-non-patch "$patch"; then
    echo "FAILED: $(basename "$patch")" >&2
    git -C "$CHECKOUT" am --abort
    exit 1
  fi
done
echo "PASS: all Domicile patches applied to Chromium $CHROMIUM_REF."
echo "This preflight does not test Thorium overlays, compilation, or runtime compatibility."
