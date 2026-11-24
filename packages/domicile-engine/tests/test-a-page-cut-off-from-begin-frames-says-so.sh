#!/usr/bin/env bash
# Whether a page cut off from begin frames is logged.
#
# See patch 0237. viz must log, once per stop, a sink it stops sending begin
# frames to for leaving them unanswered. A client's ExternalBeginFrameSource
# must log a run of begin frames it, or an observer, drops as older than the
# last one taken or used.
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

support="$(added_to components/viz/service/frame_sinks/compositor_frame_sink_support.cc)"
source="$(added_to components/viz/common/frame_sinks/begin_frame_source.cc)"

fails=0
want() {
  if grep -qF -- "$2" <<<"$1"; then return; fi
  echo "    missing: $2"
  fails=$((fails + 1))
}

want "$support" 'if (!domicile_reported_stop_) {'
want "$support" 'LOG(ERROR) << "domicile: frame sink " << frame_sink_id_.ToString()'
want "$support" 'domicile_reported_stop_ = false;'
want "$source" 'if (++domicile_dropped_in_a_row_ == kDomicileDroppedRunToReport) {'
want "$source" 'LOG(ERROR) << "domicile: dropped " << domicile_dropped_in_a_row_'
want "$source" 'domicile_dropped_in_a_row_ = 0;'
want "$source" '} else if (++domicile_observer_dropped_in_a_row_ =='
want "$source" 'domicile_dropped_last_used = obs->LastUsedBeginFrameArgs();'
want "$source" 'domicile_observer_dropped_in_a_row_ = 0;'

# The stop flag resets before the stop branch, so a recovered sink re-arms.
reset_line="$(grep -nF 'domicile_reported_stop_ = false;' <<<"$support" | cut -d: -f1)"
check_line="$(grep -nF 'if (!domicile_reported_stop_) {' <<<"$support" | cut -d: -f1)"
if ! [[ "$reset_line" =~ ^[0-9]+$ && "$check_line" =~ ^[0-9]+$ ]] ||
  [ "$reset_line" -ge "$check_line" ]; then
  echo "    want one stop flag reset, before the one stop branch"
  fails=$((fails + 1))
fi

if [ "$fails" -eq 0 ]; then
  echo "  ok    a page cut off from begin frames says so"
else
  echo "  FAIL  a page cut off from begin frames says so"
  exit 1
fi
