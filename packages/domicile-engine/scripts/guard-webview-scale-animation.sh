#!/usr/bin/env bash
# A browser window whose box an animation scales keeps its page's raster
# scale: the page is not rastered again each frame.
#
#   nix develop .#full --command \
#     ./packages/domicile-engine/scripts/guard-webview-scale-animation.sh /build/chromium/src
#
# Headless and software-composited like the other <webview> guards. It counts
# the page's surfaces in a viz trace, so it needs no pixels and no client.
#
# Why: a <webview>'s page took a new raster scale on every main frame of an
# animation that scales its window (open, close, a tab closing into its
# strip, a settle). Each new scale is a new surface and a raster of the whole
# page, so a heavy page rastered again every frame and stalled the desk's
# frames on the GPU (patch 0233).
#
# The shell (guard-webview-scale-animation.js) shrinks the window's box to
# half its size with a CSS animation while it runs a main frame each frame.
# Asserted:
#
#   the shell page ran    or nothing was set up
#   the page was shown    a window was opened and its <webview> reported it
#   the shrink ended      the shell logged its end
#   the trace saw it      the shrink ended before the trace did
#   few page surfaces     no frame sink took more than MAX_SURFACES surfaces
#                         over the run, not one a frame
#
# Control: NEGATIVE=1 shrinks the box in STEPS static steps instead, with no
# animation running. Each step must still reach the page as a new surface, so
# the count sees scale changes and a page at rest takes its new scale.
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
  annotate "guard-webview-scale-animation: no path to chromium/src was given"
  exit 1
fi

# NEGATIVE=1 scales in static steps. See the header.
NEGATIVE="${NEGATIVE:-0}"
MODE="claim"
WHICH=""
if [ "$NEGATIVE" = "1" ]; then
  MODE="control"
  WHICH="-negative"
fi

OUT="${OUT:-out/Domicile}"
BROKER="${BROKER:-/tmp/domicile-webview-scale-animation$WHICH-broker}"
PROFILE="${PROFILE:-/tmp/domicile-webview-scale-animation$WHICH-profile}"
ENGINE_LOG="${ENGINE_LOG:-/tmp/domicile-webview-scale-animation$WHICH-engine.log}"
HTTP_LOG="${HTTP_LOG:-/tmp/domicile-webview-scale-animation$WHICH-http.log}"
TRACE="${TRACE:-/tmp/domicile-webview-scale-animation$WHICH-trace.json}"
# How long the engine traces. Covers the page's load, the 2s wait and the
# shrink, with room for a loaded runner.
TRACE_SECONDS="${TRACE_SECONDS:-20}"
# The control's steps.
STEPS="${STEPS:-30}"
# A page's load takes a few surfaces. A page rastered each frame of a one
# second animation takes one a frame.
MAX_SURFACES="${MAX_SURFACES:-10}"

STARTED=()
cleanup() {
  if [ ${#STARTED[@]} -gt 0 ]; then
    kill "${STARTED[@]}" 2>/dev/null
  fi
  remove_profile "$PROFILE"
}
trap cleanup EXIT

[ -x "$CHROMIUM/$OUT/chrome" ] || {
  annotate "guard-webview-scale-animation: no engine at $CHROMIUM/$OUT/chrome; build it with ./packages/domicile-engine/scripts/build.sh"
  exit 1
}
command -v python3 >/dev/null || {
  skip "guard-webview-scale-animation: no python3, which serves the page and reads the trace"
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
python3 "$SCRIPTS/guard-webview-guest-page.py" --port 0 >"$HTTP_LOG" 2>&1 &
STARTED+=($!)
wait_for_line 240 "serving" "$HTTP_LOG" || {
  annotate_from "guard-webview-scale-animation: its page server never came up" "$HTTP_LOG"
  exit 1
}
PORT="$(served_port "$HTTP_LOG")" || {
  annotate_from "guard-webview-scale-animation: its page server never said which port it took" "$HTTP_LOG"
  exit 1
}
SUBJECT="http://127.0.0.1:$PORT/page"

# 2. The engine, tracing viz. `src` goes last: it is a URL.
rm -f "$ENGINE_LOG" "$TRACE"
"$CHROMIUM/$OUT/chrome" \
  --ozone-platform=headless \
  --disable-gpu \
  --window-size=1024,768 \
  --app="domicile://shell/?mode=$MODE&steps=$STEPS&src=$SUBJECT" \
  --domicile-shell-root="$SCRIPTS" \
  --domicile-shell-module="guard-webview-scale-animation.js" \
  --no-sandbox --password-store=basic --no-first-run --disable-component-update \
  --user-data-dir="$PROFILE" \
  --enable-logging=stderr --log-level=0 \
  --trace-startup=viz \
  --trace-startup-duration="$TRACE_SECONDS" \
  --trace-startup-file="$TRACE" \
  --trace-startup-format=json \
  --domicile-broker-socket="$BROKER" >"$ENGINE_LOG" 2>&1 &
STARTED+=($!)

# 3. Wait for the shrink, then for the trace, written when it ends.
wait_for_line $((TRACE_SECONDS * 4)) "GUARD done" "$ENGINE_LOG" ||
  echo "the shell never finished; the verdict below says what that means" >&2

# The most surfaces any frame sink took over the run, or `none` when the trace
# was never written or does not parse.
surfaces() {
  python3 -I - "$TRACE" <<'EOF' 2>/dev/null || echo none
import json
import re
import sys

with open(sys.argv[1], encoding="utf-8") as trace:
    events = json.load(trace)["traceEvents"]
ids = {}
for event in events:
    if event.get("name") == "Surface::CommitFrame":
        surface = event["args"]["SurfaceId"]
        sink = re.match(r"SurfaceId\((FrameSinkId\([^)]*\))", surface).group(1)
        ids.setdefault(sink, set()).add(surface)
print(max(len(seen) for seen in ids.values()))
EOF
}
SURFACES="none"
for _ in $(seq 1 $((TRACE_SECONDS * 4))); do
  SURFACES="$(surfaces)"
  [ "$SURFACES" != "none" ] && break
  sleep 0.25
done

saw() { # $1 pattern
  grep -qF -- "$1" "$ENGINE_LOG" && echo 1 || echo 0
}

# 1 when the shrink ended before the trace did, so the trace holds all of it.
# The browser process logs both lines, in order.
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

MEASURED="$MODE $(saw "GUARD shell-loaded") $(saw "GUARD page-shown") $(saw "GUARD done") $(covered) $SURFACES"
echo
echo "measured: $MEASURED (max $MAX_SURFACES)"
echo "  (mode shell page-shown done traced most-surfaces-of-a-frame-sink)"

# Which end to blame. `packages/domicile-engine/tests/test-webview-scale-animation-guard.sh`
# runs this block directly. MEASURED is "<mode> <shell> <page> <done>
# <traced> <surfaces>"; MAX_SURFACES is the bar.
FAILURE=""
PASSED=""
read -r M_MODE M_SHELL M_PAGE M_DONE M_TRACED M_SURFACES <<<"$MEASURED"
if [ "$M_SHELL" != "1" ]; then
  FAILURE="the shell page never ran, so nothing here was set up: the module \
did not load, or it threw, and the engine log has its console"
elif [ "$M_PAGE" != "1" ]; then
  FAILURE="the page was never shown: openBrowserWindow opened no window, the \
list never reached the shell, or the <webview> never reported its page"
elif [ "$M_DONE" != "1" ]; then
  FAILURE="the shrink never ended, so it was never measured: the shell threw \
or its animation never finished"
elif [ "$M_TRACED" != "1" ]; then
  FAILURE="the trace ended before the shrink did, so it does not hold the \
shrink to count: raise TRACE_SECONDS for a slow runner"
elif [ "$M_SURFACES" = "none" ]; then
  FAILURE="the viz trace was never written or does not parse, so there is \
nothing to count: the engine died before --trace-startup-duration ended"
elif [ "$M_MODE" = "claim" ] && [ "$M_SURFACES" -gt "$MAX_SURFACES" ]; then
  FAILURE="a page took $M_SURFACES surfaces while an animation scaled its \
window, over $MAX_SURFACES: it took a new raster scale each frame and \
rastered the whole page again. A <webview> keeps its raster scale while a \
transform animation runs on it or a box around it \
(RemoteFrameView::UpdateCompositingScaleFactor, patch 0233)"
elif [ "$M_MODE" = "claim" ]; then
  PASSED="a page kept its raster scale while an animation scaled its window \
($M_SURFACES surfaces at most)"
elif [ "$M_SURFACES" -gt "$MAX_SURFACES" ]; then
  PASSED="the control is sharp: a window scaled in static steps took \
$M_SURFACES surfaces, so the claim's few are the build's doing, and a page at \
rest still takes its new scale"
else
  FAILURE="the control scaled the window in static steps and its page took \
only $M_SURFACES surfaces, so a low count in the claim says nothing, or a \
page at rest no longer takes its new scale"
fi

if [ -n "$PASSED" ]; then
  echo "PASS: $PASSED"
  exit 0
fi

annotate_from "guard-webview-scale-animation: $FAILURE" "$ENGINE_LOG"
echo "the shell's steps, in order:" >&2
grep -F "GUARD" "$ENGINE_LOG" >&2
echo "the engine's last words:" >&2
last_words "$ENGINE_LOG" >&2
exit 1
