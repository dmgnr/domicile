#!/usr/bin/env bash
# Whether a page that never activates its new size says what its tiles wait on.
#
# See patch 0249. After 0248 showed a frozen page's pending tree at its new
# surface never activating, the 0248 line must end with what TileManager's
# activation waits on: required tiles not ready, where they are, and whether
# the raster queue ever offers them.
#
# Reads the series rather than a build, so it runs on every push.
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

tiles="$(added_to cc/tiles/tile_manager.cc)"
impl="$(added_to cc/trees/layer_tree_host_impl.cc)"

fails=0
want() {
  if grep -qF -- "$2" <<<"$1"; then return; fi
  echo "    missing: $2"
  fails=$((fails + 1))
}

want "$tiles" 'std::string TileManager::DomicileWhyNotReadyToActivate() const {'
want "$tiles" 'RasterTilePriorityQueue::Type::REQUIRED_FOR_ACTIVATION);'
want "$tiles" '} else if (!is_offered) {'
want "$tiles" 'never offered for raster %d'
want "$tiles" 'first tiles to raster [%s]'
want "$tiles" 'BasicStateAsValueInto(&state);'
want "$impl" 'tile_manager_.DomicileWhyNotReadyToActivate()'

if [ "$fails" -gt 0 ]; then
  echo "FAIL: $fails of the lines saying what a page's activation waits on are missing"
  exit 1
fi
echo "ok: a page that never activates its new size says what its tiles wait on"
