#!/usr/bin/env bash
# Whether a page that never activates says where its tiles' raster tasks are.
#
# See patch 0254. 0249's line counted required tiles "being rastered" but not
# where their tasks were; a frozen page in the CI VM repro had tiles being
# rastered for good. The line must count the tasks by state and by unfinished
# image decodes, and name each listed tile's task state.
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

fails=0
want() {
  if grep -qF -- "$2" <<<"$1"; then return; fi
  echo "    missing: $2"
  fails=$((fails + 1))
}

want "$tiles" 'const char* DomicileTaskStateName(TaskState& state) {'
want "$tiles" 'TaskState& task_state = tile->raster_task_->state();'
want "$tiles" 'tasks_waiting_on_decodes += !dependency->state().IsFinished();'
want "$tiles" 'finished but not collected '
want "$tiles" 'did_check_for_completed_tasks_since_last_schedule_tasks_ ? "yes" : "no",'

if [ "$fails" -gt 0 ]; then
  echo "FAIL: $fails of the lines saying where a frozen page's raster tasks are are missing"
  exit 1
fi
echo "ok: a page that never activates says where its tiles' raster tasks are"
