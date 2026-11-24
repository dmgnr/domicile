#!/usr/bin/env bash
# An `<app>` sends its client what lands on it, in the client's own surface
# coordinates, with nothing on the page routing it.
#
#   nix develop .#full --command \
#     ./packages/domicile-engine/scripts/guard-app-routes-input.sh /build/chromium/src
#
# WHY THIS EXISTS. Input over an `<app>` used to be routed by page script: the
# SDK's `registerElements` measured the element's box and transform in script,
# inverted them, and called `pointerMotion`, `pointerButton`, `key` and the
# rest itself. The engine does it now -- the element maps through its own
# layout box and every transform above it, and the desktop forwards -- so a
# shell calls nothing. This page calls nothing and has no pointer listener of
# its own. See packages/chrome-sdk/docs/ELEMENTS.md.
#
# WHAT IT ASSERTS. The stand-in records every line the engine writes, and the
# pointer, wheel, key and focus lines must be exactly, in order:
#
#   pointer_motion  term 100,50     the move: `term` is turned and scaled, so
#                                    only the whole transform inverted lands
#                                    450,150 on the client's 100,50
#   focus_app       term            the press asks, and nothing cancels
#   pointer_motion  term 100,50
#   pointer_button  term 272 down   BTN_LEFT
#   pointer_button  term 272 up
#   pointer_axis    term 0,100 / 0,120  a 100px wheel is one detent
#   key             term 30 down    the keyboard follows the press
#   key             term 30 up
#   pointer_leave   term            the pointer went off every window
#   focus_app       term            a press on `menu` asks for its window
#   pointer_motion  menu 20,20
#   pointer_button  menu 272 down
#   pointer_button  menu 272 up
#   pointer_leave   menu
#   pointer_motion  term 100,50
#   focus_app       term            a press dragged off the window
#   pointer_motion  term 100,50
#   pointer_button  term 272 down
#   pointer_motion  term 550,-200   the press keeps the pointer: 700,600 is
#                                    off `term`, mapped through its transform
#   pointer_button  term 272 up     the release off the window still reaches
#                                    the client that had the press
#   pointer_leave   term
#
# and the page heard `domicile-focus-requested`, cancelable and bubbling, for
# `term` three times, and `domicile-key-delivered`, bubbling, for `term` once:
# the key, not its release.
#
# HOW IT CAN FAIL. NEGATIVE=1 draws the same two boxes as `<div>`s and drives
# the same input. The page hears the press -- it says so -- and not one of the
# lines above may reach the compositor: a run where they do is a run where they
# did not come from the element under test. A key's release with no window is
# allowed through: a release is sent for every key the page hears, because the
# compositor's seat may hold the press.
set -u

SCRIPTS="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=packages/domicile-engine/scripts/lib-annotate.sh
. "$SCRIPTS/lib-annotate.sh"
# shellcheck source=packages/domicile-engine/scripts/lib-ports.sh
. "$SCRIPTS/lib-ports.sh"
# shellcheck source=packages/domicile-engine/scripts/lib-profile.sh
. "$SCRIPTS/lib-profile.sh"
# shellcheck source=packages/domicile-engine/scripts/lib-broker.sh
. "$SCRIPTS/lib-broker.sh"

CHROMIUM="${1:-}"
if [ -z "$CHROMIUM" ]; then
  annotate "guard-app-routes-input: no path to chromium/src was given"
  exit 1
fi

# NEGATIVE=1 draws `<div>`s where the `<app>`s go. See the header.
NEGATIVE="${NEGATIVE:-0}"
KIND="app"
[ "$NEGATIVE" = "1" ] && KIND="div"

OUT="${OUT:-out/Domicile}"
WHICH=""
[ "$NEGATIVE" = "1" ] && WHICH="-negative"
# Not any other guard's paths: CI runs the guards in one job.
BROKER="${BROKER:-/tmp/domicile-app-routes-input-broker}"
CONTROL="${CONTROL:-/tmp/domicile-app-routes-input-control}"
PROFILE="${PROFILE:-/tmp/domicile-app-routes-input-profile}"
ENGINE_LOG="${ENGINE_LOG:-/tmp/domicile-app-routes-input$WHICH-engine.log}"
SOCKET_LOG="${SOCKET_LOG:-/tmp/domicile-app-routes-input$WHICH-socket.log}"
DRIVE_LOG="${DRIVE_LOG:-/tmp/domicile-app-routes-input$WHICH-drive.log}"
FOR_SECONDS="${FOR_SECONDS:-60}"

STARTED=()
cleanup() {
  if [ ${#STARTED[@]} -gt 0 ]; then
    kill "${STARTED[@]}" 2>/dev/null
  fi
  remove_profile "$PROFILE"
}
trap cleanup EXIT

[ -x "$CHROMIUM/$OUT/chrome" ] || {
  annotate "guard-app-routes-input: no engine at $CHROMIUM/$OUT/chrome; build it with ./packages/domicile-engine/scripts/build.sh"
  exit 1
}
command -v python3 >/dev/null || {
  skip "guard-app-routes-input: no python3, and the compositor's end of the control socket and the input are both driven by one"
  exit 77
}

fresh_broker
rm -f "$CONTROL"; rm -rf "$PROFILE"; mkdir -p "$PROFILE"

wait_for_line() { # $1 tries, $2 pattern, $3 file
  for _ in $(seq 1 "$1"); do
    grep -qF "$2" "$3" 2>/dev/null && return 0
    sleep 0.25
  done
  return 1
}

rm -f "$SOCKET_LOG"
python3 "$SCRIPTS/guard-app-routes-input-compositor.py" --socket "$CONTROL" \
  >"$SOCKET_LOG" 2>&1 &
STARTED+=($!)
wait_for_line 240 "listening on" "$SOCKET_LOG" || {
  annotate_from "guard-app-routes-input: the compositor stand-in never listened on $CONTROL" "$SOCKET_LOG"
  exit 1
}

rm -f "$ENGINE_LOG"
"$CHROMIUM/$OUT/chrome" \
  --ozone-platform=headless \
  --disable-gpu \
  --app="domicile://shell/?kind=$KIND" \
  --domicile-shell-root="$SCRIPTS" \
  --domicile-shell-module="guard-app-routes-input.js" \
  --domicile-control-socket="$CONTROL" \
  --remote-debugging-port=0 \
  --no-sandbox --password-store=basic --no-first-run --disable-component-update \
  --user-data-dir="$PROFILE" \
  --window-size=1024,768 \
  --enable-logging=stderr --log-level=0 \
  --domicile-broker-socket="$BROKER" >"$ENGINE_LOG" 2>&1 &
STARTED+=($!)

TRIES=$((FOR_SECONDS * 4))
wait_for_line "$TRIES" "GUARD ready" "$ENGINE_LOG" || {
  annotate_from "guard-app-routes-input: the shell never saw both windows, so nothing was laid out to drive at" "$ENGINE_LOG"
  tail -40 "$ENGINE_LOG" >&2
  exit 1
}
DEBUG_PORT="$(devtools_port "$PROFILE" "$TRIES")" || {
  annotate_from "guard-app-routes-input: the engine never said which debugging port it took" "$ENGINE_LOG"
  exit 1
}

rm -f "$DRIVE_LOG"
python3 "$SCRIPTS/guard-app-routes-input-drive.py" --port "$DEBUG_PORT" \
  >"$DRIVE_LOG" 2>&1 || {
  annotate_from "guard-app-routes-input: the input could not be driven" "$DRIVE_LOG"
  exit 1
}
sleep 2

# The closing quote is Chromium's and keeps each match on the message: see
# guard-windows-state.sh.
PAGE=$(grep -oE '"GUARD [a-z-]+ [^"]*"' "$ENGINE_LOG" | tr '\n' ' ')

FAILURE=$(KIND="$KIND" PAGE="$PAGE" SOCKET_LOG="$SOCKET_LOG" python3 - <<'PY'
import json, os

ROUTED = {"pointer_motion", "pointer_button", "pointer_axis", "pointer_leave", "key", "focus_app"}

said = []
with open(os.environ["SOCKET_LOG"], encoding="utf-8") as log:
    for line in log:
        if line.startswith("said: "):
            try:
                message = json.loads(line[len("said: "):])
            except ValueError:
                continue
            if message.get("type") in ROUTED:
                said.append(message)

def short(message):
    kind = message["type"]
    app = message.get("app_id")
    if kind == "pointer_motion":
        return "%s %s %.1f,%.1f" % (kind, app, message["x"], message["y"])
    if kind == "pointer_button":
        return "%s %s %d %s" % (kind, app, message["button"], "down" if message["pressed"] else "up")
    if kind == "pointer_axis":
        return "%s %s %g,%g/%d,%d" % (kind, app, message["dx"], message["dy"], message["v120_x"], message["v120_y"])
    if kind == "key":
        return "%s %s %d %s" % (kind, app, message["keycode"], "down" if message["pressed"] else "up")
    return "%s %s" % (kind, app)

# A move Blink repeats at one place is one move.
heard = []
for line in map(short, said):
    if not heard or heard[-1] != line or not line.startswith("pointer_motion"):
        heard.append(line)

page = os.environ["PAGE"]
if os.environ["KIND"] == "div":
    if '"GUARD pressed div"' not in page:
        print("the control's page never heard the press (%s), so the input never arrived and the control says nothing" % page)
    else:
        forwarded = [line for line in heard if not (line.startswith("key ") and line.endswith(" up"))]
        if forwarded:
            print("with `<div>`s in place of the `<app>`s the compositor was still sent %s, so what the guard reads did not come from the element" % forwarded)
        elif "GUARD key-delivered" in page:
            print("with `<div>`s in place of the `<app>`s the page still heard `domicile-key-delivered` (%s), so what the guard reads did not come from the element" % page)
    raise SystemExit

wanted = [
    "pointer_motion term 100.0,50.0",
    "focus_app term",
    "pointer_motion term 100.0,50.0",
    "pointer_button term 272 down",
    "pointer_button term 272 up",
    "pointer_axis term 0,100/0,120",
    "key term 30 down",
    "key term 30 up",
    "pointer_leave term",
    # The move onto the popup, before the press there.
    "pointer_motion menu 20.0,20.0",
    "focus_app term",
    "pointer_motion menu 20.0,20.0",
    "pointer_button menu 272 down",
    "pointer_button menu 272 up",
    "pointer_leave menu",
    "pointer_motion term 100.0,50.0",
    "focus_app term",
    "pointer_motion term 100.0,50.0",
    "pointer_button term 272 down",
    # Off `term`: the press captured the pointer for it.
    "pointer_motion term 550.0,-200.0",
    "pointer_button term 272 up",
    "pointer_leave term",
]
asked = page.count('"GUARD focus-requested term bubbles=true cancelable=true"')
if '"GUARD keydown KeyA"' not in page:
    print("the page never heard the key (%s), so the harness delivered no key event and the key lines decide nothing" % page)
elif asked != 3:
    print("the page heard %d cancelable, bubbling `domicile-focus-requested` for term where the three presses owed three (%s)" % (asked, page))
elif page.count('"GUARD key-delivered') != 1 or '"GUARD key-delivered term bubbles=true"' not in page:
    print("the page heard `domicile-key-delivered` other than once, bubbling, for term, where the one key owed one (%s)" % page)
elif heard != wanted:
    print("the compositor was sent %s where %s was owed" % (heard, wanted))
PY
)

echo "page: $PAGE"

if [ -n "$FAILURE" ]; then
  annotate_from "guard-app-routes-input: $FAILURE" "$ENGINE_LOG"
  echo "guard-app-routes-input: $FAILURE" >&2
  echo "the compositor stand-in said:" >&2
  tail -40 "$SOCKET_LOG" >&2
  echo "the engine said:" >&2
  tail -40 "$ENGINE_LOG" >&2
  exit 1
fi
if [ "$NEGATIVE" = "1" ]; then
  echo "PASS (control): a <div> in an <app>'s place sends its client nothing"
else
  echo "PASS: an <app> routes its own input, in its client's surface coordinates"
fi
