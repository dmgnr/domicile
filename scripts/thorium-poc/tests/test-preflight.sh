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
printf 'second\n' > "$TMP/base/file.txt"
git -C "$TMP/base" add file.txt
git -C "$TMP/base" commit -qm second
git -C "$TMP/base" format-patch -1 --stdout > "$TMP/series/patches/0002.patch"
sed -e 's/^-second$/-after/' -e 's/^+second$/+ported/' "$TMP/series/patches/0002.patch" > "$TMP/overrides-0002.patch"
mkdir -p "$TMP/overrides"
cp "$TMP/overrides-0002.patch" "$TMP/overrides/0002.patch"
git -C "$TMP/base" checkout -q "$BASE"
git -C "$TMP/base" config --unset user.email
git -C "$TMP/base" config --unset user.name
if HOME="$TMP/home" GIT_CONFIG_NOSYSTEM=1 "$SCRIPT" --fixture "$TMP/series" "$TMP/base" "$TMP/overrides" >"$TMP/ok.log" 2>&1; then
  :
else
  fail "applicable fixture patch failed"
fi
grep -q '^ported$' "$TMP/base/file.txt" || fail "named patch override was not applied"

# A failing first patch exits nonzero and leaves actionable diagnostics.
git -C "$TMP/base" reset --hard -q "$BASE"
sed 's/-before/-missing/' "$TMP/series/patches/0001.patch" > "$TMP/series/patches/0001-bad.patch"
rm "$TMP/series/patches/0001.patch"
if "$SCRIPT" --fixture "$TMP/series" "$TMP/base" >"$TMP/fail.log" 2>&1; then fail "conflicting patch unexpectedly passed"; fi
grep -q '0001-bad.patch' "$TMP/fail.log" || fail "failure diagnostics omitted patch name"
grep -q 'does not apply' "$TMP/fail.log" || fail "failure diagnostics omitted git error"

if "$SCRIPT" --fixture "$TMP/series" "$TMP/missing" >"$TMP/missing.log" 2>&1; then fail "missing checkout unexpectedly passed"; fi
grep -q 'not a git checkout' "$TMP/missing.log" || fail "missing checkout diagnostic absent"

# The upstream patch's Chromium 156 GN contexts fail; the isolated port applies.
mkdir -p "$TMP/chromium156/components" "$TMP/chromium156/content/browser"
cat > "$TMP/chromium156/components/BUILD.gn" <<'EOF'
test("components_unittests") {
  deps = [
    "//components/device_event_log:unit_tests",
    "//components/device_reauth:unit_tests",
    "//components/device_signals/core:unit_tests",
    "//components/dom_distiller/core:unit_tests",
    "//components/download:unit_tests",
    "//components/encrypted_messages:unit_tests",
  ]
}
EOF
cat > "$TMP/chromium156/content/browser/BUILD.gn" <<'EOF'
source_set("browser") {
  deps = [
    "//components/discardable_memory/common",
    "//components/discardable_memory/service",
    "//components/download/database",
    "//components/download/public/common:public",
    "//components/embedder_support",
    "//components/embedder_support:user_agent",
  ]
  sources = [
    "dom_storage/dom_storage_context_wrapper.h",
    "dom_storage/session_storage_namespace_handle_impl.cc",
    "dom_storage/session_storage_namespace_handle_impl.h",
    "download/data_url_blob_reader.cc",
    "download/data_url_blob_reader.h",
    "download/download_item_utils.cc",
    "download/download_manager_impl.cc",
    "download/download_manager_impl.h",
  ]
}
EOF
git -C "$TMP/chromium156" init -q
git -C "$TMP/chromium156" add .
git -C "$TMP/chromium156" -c user.email=test@example.invalid -c user.name=Test commit -qm chromium156-fixture
if git -C "$TMP/chromium156" apply --check "$ROOT/packages/domicile-engine/patches/0001-domicile-build-the-non-renderer-frame-sink-broker.patch" >"$TMP/original.log" 2>&1; then
  fail "original Chromium GN contexts unexpectedly apply to the 156 fixture"
fi
grep -q 'does not apply' "$TMP/original.log" || fail "original patch failed for a reason other than its Chromium 156 contexts"
PORT_PATCH_DIR="$ROOT/scripts/thorium-poc/patches"
mkdir -p "$TMP/series156/patches"
cp "$ROOT/packages/domicile-engine/patches/0001-domicile-build-the-non-renderer-frame-sink-broker.patch" "$TMP/series156/patches/"
HOME="$TMP/home" GIT_CONFIG_NOSYSTEM=1 "$SCRIPT" --fixture "$TMP/series156" "$TMP/chromium156" "$PORT_PATCH_DIR" >"$TMP/port-check.log" 2>&1 || fail "Chromium 156 GN port does not apply"
grep -q '"//components/domicile:unit_tests",' "$TMP/chromium156/components/BUILD.gn" || fail "port omitted domicile unit test target"
grep -q '"//components/domicile:browser",' "$TMP/chromium156/content/browser/BUILD.gn" || fail "port omitted domicile browser target"
grep -q '"domicile/domicile_frame_sink_broker.cc",' "$TMP/chromium156/content/browser/BUILD.gn" || fail "port omitted frame sink broker source"
grep -q '"domicile/domicile_frame_sink_broker.h",' "$TMP/chromium156/content/browser/BUILD.gn" || fail "port omitted frame sink broker header"
echo "thorium preflight fixture tests passed"
