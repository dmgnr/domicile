#!/usr/bin/env bash
# Whether the raster queue offers every tile activation waits on.
#
# See patch 0250. 0079 makes activation wait, on the active tree, on any
# tiling whose pending twin is a monitor's; TilingSetRasterQueueAll must offer
# those tilings too, or a page whose active tree moved off a monitor froze at
# its old size. DomicileMonitorTwinActivationTest runs it in
# domicile_unittests; this reads the series, so it runs on every push.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
PATCHES="$ROOT/packages/domicile-engine/patches"
[ -d "$PATCHES" ] || { echo "no patch series at $PATCHES" >&2; exit 1; }

# The lines the series adds to one file.
added_to() {
  awk -v want="$1" '
    FNR == 1 { in_file = 0 }
    /^diff --git a\// { in_file = (index($0, want) > 0); next }
    !in_file { next }
    /^(\+\+\+|---) / { next }
    /^\+/ { print substr($0, 2) }
  ' "$PATCHES"/*.patch
}

queue="$(added_to cc/tiles/tiling_set_raster_queue_all.cc)"

fails=0
want() {
  if grep -qF -- "$2" <<<"$1"; then return; fi
  echo "    missing: $2"
  fails=$((fails + 1))
}

want "$queue" 'twin && twin->domicile_display_ratio() != 0.f;'
want "$queue" '(tiling->domicile_display_ratio() != 0.f || required_through_twin) &&'
want "$queue" 'const size_t required = domicile_display_tilings.size();'
want "$queue" '" monitors'"'"' tilings that activation waits on, but only "'
grep -qF '"monitor_twin_activation_unittest.cc",' \
  "$ROOT/packages/domicile-engine/src/cc/domicile/BUILD.gn" ||
  { echo "    missing: monitor_twin_activation_unittest.cc in cc/domicile's tests"; fails=$((fails + 1)); }

if [ "$fails" -gt 0 ]; then
  echo "FAIL: $fails of the lines that make the raster queue offer what activation waits on are missing"
  exit 1
fi
echo "ok: the raster queue offers every tile activation waits on"
