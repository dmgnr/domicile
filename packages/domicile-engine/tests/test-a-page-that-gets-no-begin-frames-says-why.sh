#!/usr/bin/env bash
# Whether a page that gets no begin frames says why.
#
# See patch 0255. A window in the CI VM repro froze with its compositor
# getting no begin frames, and nothing said whether the page stopped asking
# or viz stopped sending. The compositor-thread line must add the scheduler's
# state, and viz must log a frame sink that wants begin frames and gets none.
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

machine="$(added_to cc/scheduler/scheduler_state_machine.cc)"
scheduler="$(added_to cc/scheduler/scheduler.cc)"
proxy="$(added_to cc/trees/proxy_impl.cc)"
host="$(added_to cc/trees/layer_tree_host_impl.cc)"
sink="$(added_to components/viz/service/frame_sinks/compositor_frame_sink_support.cc)"

fails=0
want() {
  if grep -qF -- "$2" <<<"$1"; then return; fi
  echo "    missing: $2"
  fails=$((fails + 1))
}

want "$machine" '{"begin frames needed ", yn(BeginFrameNeeded()), ", visible ",'
want "$machine" '", needs begin main frame ", yn(needs_begin_main_frame_),'
want "$scheduler" '", observing it ", observing_begin_frame_source_ ? "yes" : "no",'
want "$proxy" '*out = scheduler_ ? scheduler_->DomicileState() : std::string("none");'
want "$host" 'delegate_->DomicileSchedulerState(&scheduler_state);'
want "$host" 'cannot_draw = " (empty viewport)";'
want "$sink" 'g_domicile_last_send_decision = reason;'
want "$sink" '<< " has wanted begin frames for "'
want "$sink" 'domicile_last_sent_ = base::TimeTicks::Now();'
want "$sink" 'domicile_source_paused_ = paused;'

if [ "$fails" -gt 0 ]; then
  echo "FAIL: $fails of the lines saying why a page gets no begin frames are missing"
  exit 1
fi
echo "ok: a page that gets no begin frames says why"
