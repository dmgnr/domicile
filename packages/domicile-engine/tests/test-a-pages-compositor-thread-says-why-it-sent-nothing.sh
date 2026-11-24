#!/usr/bin/env bash
# Whether a page's compositor thread says why it sent nothing at a new size.
#
# See patch 0248. After 0245 showed a page's main thread committing its new
# surface while no frame at that size went out, LayerTreeHostImpl must log at
# ERROR what its thread did in the 2 s since the target surface arrived.
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

impl="$(added_to cc/trees/layer_tree_host_impl.cc)"

fails=0
want() {
  if grep -qF -- "$2" <<<"$1"; then return; fi
  echo "    missing: $2"
  fails=$((fails + 1))
}

want "$impl" 'DomicileWatchTarget();'
want "$impl" '++domicile_begin_frames_;'
want "$impl" '++domicile_skipped_for_target_;'
want "$impl" '++domicile_frames_sent_;'
want "$impl" '--domicile_unacked_;'
want "$impl" '<< " thread has sent no frame at its new surface "'
want "$impl" 'domicile_target_timer_.Stop();'

if [ "$fails" -gt 0 ]; then
  echo "FAIL: $fails of the compositor thread's logs for a page stuck before its new size are missing"
  exit 1
fi
echo "ok: a page's compositor thread says why it sent nothing at a new size"
