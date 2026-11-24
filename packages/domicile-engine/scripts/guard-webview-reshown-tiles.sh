#!/usr/bin/env bash
# A browser window hidden and shown again draws from the tiles it kept: its
# page is not rastered again.
#
#   nix develop .#full --command \
#     ./packages/domicile-engine/scripts/guard-webview-reshown-tiles.sh /build/chromium/src
#
# Headless and software-composited like the other <webview> guards. It counts
# the page's tile rasters in a cc trace, so it needs no pixels and no client.
#
# Why: manganese hides the windows of other workspaces and other tabs with
# `display: none`, which hides their pages. A page shown again without its
# tiles rasters its whole viewport, which stalls the desk's frames on a
# laptop's GPU in the middle of a workspace slide. A hidden page keeps the
# tiles its viewport draws, as a hidden native window keeps its buffer
# (patch 0252).
#
# The shell (guard-webview-reshown-tiles.js) shows a page of text, hides its
# box, and shows it again. Asserted:
#
#   the shell page ran    or nothing was set up
#   the page attached     a window was opened and its <webview> reported it
#   it was hidden         the page's last state before the reshow is `hidden`
#   it was shown again    the page said `visible` after the reshow
#   the trace saw it      the shell's `done` came before the trace ended
#   few rasters           the page rastered at most MAX_RASTERS tiles after
#                         the reshow
#   a kept viewport       the page's compositor viewport never went to 0x0.
#                         A hidden <webview>'s did, which threw its tiles
#                         away on a laptop's GPU; this small software-rastered
#                         page hides that from the raster count (patch 0265)
#
# Control: NEGATIVE=1 shows the box again at half its scale, set while it was
# hidden. No kept tile fits a new scale, so the page must raster again, and
# the count sees rasters.
set -u

SCRIPTS="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=packages/domicile-engine/scripts/lib-annotate.sh
. "$SCRIPTS/lib-annotate.sh"
# shellcheck source=packages/domicile-engine/scripts/lib-last-words.sh
. "$SCRIPTS/lib-last-words.sh"
# shellcheck source=packages/domicile-engine/scripts/lib-ports.sh
. "$SCRIPTS/lib-ports.sh"
# shellcheck source=packages/domicile-engine/scripts/lib-profile.sh
. "$SCRIPTS/lib-profile.sh"
# shellcheck source=packages/domicile-engine/scripts/lib-broker.sh
. "$SCRIPTS/lib-broker.sh"

CHROMIUM="${1:-}"
if [ -z "$CHROMIUM" ]; then
  annotate "guard-webview-reshown-tiles: no path to chromium/src was given"
  exit 1
fi

# NEGATIVE=1 reshows at a new scale. See the header.
NEGATIVE="${NEGATIVE:-0}"
MODE="claim"
WHICH=""
if [ "$NEGATIVE" = "1" ]; then
  MODE="control"
  WHICH="-negative"
fi

OUT="${OUT:-out/Domicile}"
BROKER="${BROKER:-/tmp/domicile-webview-reshown-tiles$WHICH-broker}"
PROFILE="${PROFILE:-/tmp/domicile-webview-reshown-tiles$WHICH-profile}"
ENGINE_LOG="${ENGINE_LOG:-/tmp/domicile-webview-reshown-tiles$WHICH-engine.log}"
HTTP_LOG="${HTTP_LOG:-/tmp/domicile-webview-reshown-tiles$WHICH-http.log}"
TRACE="${TRACE:-/tmp/domicile-webview-reshown-tiles$WHICH-trace.json}"
# How long the engine traces. Covers the page's load, the 2s wait, the hide
# and the reshow, with room for a loaded runner.
TRACE_SECONDS="${TRACE_SECONDS:-20}"
# A reshown page may raster a tile or two that changed. One that dropped its
# tiles rasters every tile in its viewport, a dozen or more.
MAX_RASTERS="${MAX_RASTERS:-2}"

STARTED=()
cleanup() {
  if [ ${#STARTED[@]} -gt 0 ]; then
    kill "${STARTED[@]}" 2>/dev/null
  fi
  remove_profile "$PROFILE"
}
trap cleanup EXIT

[ -x "$CHROMIUM/$OUT/chrome" ] || {
  annotate "guard-webview-reshown-tiles: no engine at $CHROMIUM/$OUT/chrome; build it with ./packages/domicile-engine/scripts/build.sh"
  exit 1
}
command -v python3 >/dev/null || {
  skip "guard-webview-reshown-tiles: no python3, which serves the page and reads the trace"
  exit 77
}

fresh_broker
rm -rf "$PROFILE"; mkdir -p "$PROFILE"

wait_for_line() { # $1 tries, $2 pattern, $3 file
  for _ in $(seq 1 "$1"); do
    grep -qF -- "$2" "$3" 2>/dev/null && return 0
    sleep 0.25
  done
  return 1
}

# 1. The page, on its own server like every <webview> guard's: `crux` reaches
#    no arbitrary host.
rm -f "$HTTP_LOG"
python3 "$SCRIPTS/guard-webview-reshown-tiles-server.py" --port 0 >"$HTTP_LOG" 2>&1 &
STARTED+=($!)
wait_for_line 240 "serving" "$HTTP_LOG" || {
  annotate_from "guard-webview-reshown-tiles: its page server never came up" "$HTTP_LOG"
  exit 1
}
PORT="$(served_port "$HTTP_LOG")" || {
  annotate_from "guard-webview-reshown-tiles: its page server never said which port it took" "$HTTP_LOG"
  exit 1
}
SUBJECT="http://127.0.0.1:$PORT/page"

# 2. The engine, tracing cc for the rasters and devtools.timeline for the
#    shell's TimeStamp. `src` goes last: it is a URL.
rm -f "$ENGINE_LOG" "$TRACE"
"$CHROMIUM/$OUT/chrome" \
  --ozone-platform=headless \
  --disable-gpu \
  --window-size=1024,768 \
  --app="domicile://shell/?mode=$MODE&src=$SUBJECT" \
  --domicile-shell-root="$SCRIPTS" \
  --domicile-shell-module="guard-webview-reshown-tiles.js" \
  --no-sandbox --password-store=basic --no-first-run --disable-component-update \
  --user-data-dir="$PROFILE" \
  --enable-logging=stderr --log-level=0 \
  --trace-startup=cc,devtools.timeline \
  --trace-startup-duration="$TRACE_SECONDS" \
  --trace-startup-file="$TRACE" \
  --trace-startup-format=json \
  --domicile-broker-socket="$BROKER" >"$ENGINE_LOG" 2>&1 &
STARTED+=($!)

# 3. Wait for the reshow, then for the trace, written when it ends.
wait_for_line $((TRACE_SECONDS * 4)) "GUARD done" "$ENGINE_LOG" ||
  echo "the shell never finished; the verdict below says what that means" >&2

# The tiles rastered after the shell's `GUARD reshowing` TimeStamp, outside
# the shell's own process, or `none` when the trace was never written, does
# not parse or holds no TimeStamp.
rasters() {
  python3 -I - "$TRACE" <<'EOF' 2>/dev/null || echo none
import json
import sys

with open(sys.argv[1], encoding="utf-8") as trace:
    events = json.load(trace)["traceEvents"]
marks = [
    event
    for event in events
    if event.get("name") == "TimeStamp"
    and "GUARD reshowing" in json.dumps(event.get("args", {}))
]
if not marks:
    sys.exit(1)
shell, since = marks[0]["pid"], marks[0]["ts"]
print(
    sum(
        1
        for event in events
        if event.get("name") == "RasterizerTaskImpl::RunOnWorkerThread"
        and event.get("ph") in ("X", "B")
        and event.get("pid") != shell
        and event.get("ts", 0) > since
    )
)
EOF
}
RASTERS="none"
for _ in $(seq 1 $((TRACE_SECONDS * 4))); do
  RASTERS="$(rasters)"
  [ "$RASTERS" != "none" ] && break
  sleep 0.25
done

# "<sizes> <emptied>": how many compositor viewport sizes the trace holds
# outside the shell's process, and how many went from a real size to 0x0.
# `none none` when the trace does not parse or holds no TimeStamp.
viewports() {
  python3 -I - "$TRACE" <<'EOF' 2>/dev/null || echo "none none"
import json
import sys

with open(sys.argv[1], encoding="utf-8") as trace:
    events = json.load(trace)["traceEvents"]
marks = [
    event
    for event in events
    if event.get("name") == "TimeStamp"
    and "GUARD reshowing" in json.dumps(event.get("args", {}))
]
if not marks:
    sys.exit(1)
shell = marks[0]["pid"]
sizes = [
    event["args"]
    for event in events
    if "ResourcePool::NotifyOfViewportSizeChange" in event.get("name", "")
    and event.get("pid") != shell
]
emptied = sum(
    1 for size in sizes if size["new_size"] == "0x0" and size["old_size"] != "0x0"
)
print(len(sizes), emptied)
EOF
}
VIEWPORTS="$(viewports)"

saw() { # $1 pattern
  grep -qF -- "$1" "$ENGINE_LOG" && echo 1 || echo 0
}

# The page's last state before the reshow, and whether it said `visible`
# after it.
STATES="$(awk '
  /GUARD reshowing/ { reshown = 1; next }
  match($0, /GUARD state=[a-z]+/) {
    state = substr($0, RSTART + 12, RLENGTH - 12)
    if (!reshown) { before = state } else if (state == "visible") { after = 1 }
  }
  END { printf "%s %d", (before == "" ? "none" : before), after }
' "$ENGINE_LOG")"
read -r BEFORE AFTER <<<"$STATES"
HIDDEN=0
[ "$BEFORE" = "hidden" ] && HIDDEN=1

# 1 when the reshow's two seconds ended before the trace did, so the trace
# holds all of them. The browser process logs both lines, in order.
covered() {
  local ended traced
  ended="$(grep -nF "GUARD done" "$ENGINE_LOG" | head -1 | cut -d: -f1)"
  traced="$(grep -nF "Completed startup tracing" "$ENGINE_LOG" | head -1 | cut -d: -f1)"
  if [ -n "$ended" ] && [ -n "$traced" ] && [ "$ended" -lt "$traced" ]; then
    echo 1
  else
    echo 0
  fi
}

MEASURED="$MODE $(saw "GUARD shell-loaded") $(saw "GUARD attached") $HIDDEN $AFTER $(covered) $RASTERS $VIEWPORTS"
echo
echo "measured: $MEASURED (max $MAX_RASTERS)"
echo "  (mode shell attached hidden shown-again traced rasters-after-reshow"
echo "   viewport-sizes viewports-emptied)"

# Which end to blame. `packages/domicile-engine/tests/test-webview-reshown-tiles-guard.sh`
# runs this block directly. MEASURED is "<mode> <shell> <attached> <hidden>
# <shown-again> <traced> <rasters> <sizes> <emptied>"; MAX_RASTERS is the bar.
FAILURE=""
PASSED=""
read -r M_MODE M_SHELL M_ATTACHED M_HIDDEN M_SHOWN M_TRACED M_RASTERS M_SIZES M_EMPTIED <<<"$MEASURED"
if [ "$M_SHELL" != "1" ]; then
  FAILURE="the shell page never ran, so nothing here was set up: the module \
did not load, or it threw, and the engine log has its console"
elif [ "$M_ATTACHED" != "1" ]; then
  FAILURE="the page was never shown: openBrowserWindow opened no window, the \
list never reached the shell, or the <webview> never reported its page"
elif [ "$M_HIDDEN" != "1" ]; then
  FAILURE="the page was not hidden when the shell showed its box again, so \
there was nothing to keep: a <webview> that is not rendered no longer hides \
its page (guard-webview-hidden)"
elif [ "$M_SHOWN" != "1" ]; then
  FAILURE="the page never said it was visible again after the reshow, so \
nothing was drawn to count"
elif [ "$M_TRACED" != "1" ]; then
  FAILURE="the trace ended before the reshow's two seconds did, so it does \
not hold them: raise TRACE_SECONDS for a slow runner"
elif [ "$M_RASTERS" = "none" ]; then
  FAILURE="the cc trace was never written, does not parse or holds no \
'GUARD reshowing' TimeStamp, so there is nothing to count: the engine died \
before --trace-startup-duration ended, or console.timeStamp no longer \
reaches devtools.timeline"
elif [ "$M_SIZES" = "0" ]; then
  FAILURE="the trace holds no compositor viewport size for the page, so it \
could not see one go to 0x0: cc no longer traces \
ResourcePool::NotifyOfViewportSizeChange, or it was renamed"
elif [ "$M_EMPTIED" -gt 0 ]; then
  FAILURE="a hidden page's compositor viewport went to 0x0 $M_EMPTIED time(s). \
An empty viewport throws away its tiles, so the page rasters its whole \
viewport when it is shown again. A hidden <webview> keeps its compositing \
rect (RemoteFrameView::UpdateCompositingRect, patch 0265)"
elif [ "$M_MODE" = "claim" ] && [ "$M_RASTERS" -gt "$MAX_RASTERS" ]; then
  FAILURE="a page shown again rastered $M_RASTERS tiles, over $MAX_RASTERS: \
it dropped its tiles while hidden and rastered its whole viewport again. A \
hidden page keeps the tiles its viewport draws \
(LayerTreeHostImpl::UpdateTileManagerMemoryPolicy, patch 0252)"
elif [ "$M_MODE" = "claim" ]; then
  PASSED="a page shown again drew from the tiles it kept ($M_RASTERS rasters)"
elif [ "$M_RASTERS" -gt "$MAX_RASTERS" ]; then
  PASSED="the control is sharp: a page shown again at a new scale rastered \
$M_RASTERS tiles, so the claim's few are the build's doing"
else
  FAILURE="the control showed the page again at a new scale and it rastered \
only $M_RASTERS tiles, so a low count in the claim says nothing: the count \
misses rasters, or the page never took the new scale"
fi

if [ -n "$PASSED" ]; then
  echo "PASS: $PASSED"
  exit 0
fi

annotate_from "guard-webview-reshown-tiles: $FAILURE" "$ENGINE_LOG"
echo "the steps, in order:" >&2
grep -E "GUARD (state=|shell-loaded|attached|hiding|reshowing|done|threw)" "$ENGINE_LOG" >&2
echo "the engine's last words:" >&2
last_words "$ENGINE_LOG" >&2
exit 1
