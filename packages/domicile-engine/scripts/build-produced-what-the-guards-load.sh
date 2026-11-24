#!/usr/bin/env bash
# Checks that the build produced the files and symbols the guards load.
#
# `autoninja` can succeed without relinking, and a stale
# `libdomicile_engine.so` then shows up as a guard failure (no client window)
# rather than a build error. Runs between the build and the guards.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
. "$ROOT/packages/domicile-engine/scripts/lib-engine-guard.sh"
require_engine_out

ARTIFACTS=(
  chrome
  libdomicile_engine.so
  domicile_unittests
  ozone_unittests
  domicile_css_parity
  domicile_color_probe
  domicile_capture_probe
  domicile_desk_probe
  node
)

# The entry points the compositor looks up by name. Matched as bytes because
# `nm` is not on the runner's PATH; a missing name is certainly not exported.
SYMBOLS=(
  domicile_engine_connect
  domicile_engine_spike_sample_window_center
  domicile_engine_spike_sample_pixel
  domicile_engine_spike_find_color
  domicile_display_capture_start
)

for artifact in "${ARTIFACTS[@]}"; do
  [ -e "$ENGINE_OUT/$artifact" ] || {
    annotate "the build produced no $artifact in $ENGINE_OUT"
    exit 1
  }
done
ls -l "$ENGINE_OUT/chrome" "$ENGINE_OUT/libdomicile_engine.so"

# The spelling dictionaries, which the release tarball needs too.
ls "$ENGINE_OUT"/dictionaries/*.bdic >/dev/null 2>&1 || {
  annotate "the build produced no dictionaries/*.bdic in $ENGINE_OUT;" \
    "domicile_dictionaries did not run"
  exit 1
}

missing=""
for symbol in "${SYMBOLS[@]}"; do
  grep -qa "$symbol" "$ENGINE_OUT/libdomicile_engine.so" ||
    missing="$missing $symbol"
done
[ -z "$missing" ] || {
  annotate "libdomicile_engine.so is missing:$missing — it is older than the" \
    "source. The build did not fail loudly enough."
  exit 1
}
echo "libdomicile_engine.so exports what the compositor looks up"
