#!/usr/bin/env bash
# Whether a page that never draws at its new size says why.
#
# See patch 0245. A page told a new size draws nothing until a tree at the new
# surface activates. Its LayerTreeHost must log at ERROR a wait past 2 s.
#
# See patch 0260. On lyra the line fired for one page whose own pipeline was
# fine. It must name the page (pid, URL), count frames the display dropped
# undrawn, and say when the page last showed a frame.
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

host="$(added_to cc/trees/layer_tree_host.cc)"

fails=0
want() {
  if grep -qF -- "$2" <<<"$1"; then return; fi
  echo "    missing: $2"
  fails=$((fails + 1))
}

want "$host" 'DomicileWatchTarget(local_surface_id_from_parent);'
want "$host" 'domicile_target_committed_ = true;'
want "$host" '++domicile_frames_presented_since_target_;'
want "$host" '<< " has drawn nothing at its new surface "'
want "$host" 'if (domicile_frames_presented_since_target_ > 0 || !visible_) {'
want "$host" 'domicile_source_url_ = url.possibly_invalid_spec().substr(0, 200);'
want "$host" '<< base::GetCurrentProcId() << ", page at "'
want "$host" '++domicile_frames_undrawn_since_target_;'
want "$host" 'domicile_last_presented_at_ = base::TimeTicks::Now();'

if [ "$fails" -gt 0 ]; then
  echo "FAIL: $fails of the logs for a page stuck before its new size are missing"
  exit 1
fi
echo "ok: a page that never draws at its new size says why"
