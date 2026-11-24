#!/usr/bin/env bash
# A page in a browser window can go fullscreen, as a video's fullscreen button
# makes it, and leaves on Escape or when the shell asks.
#
#   nix develop .#full --command \
#     ./packages/domicile-engine/scripts/guard-webview-fullscreen.sh /build/chromium/src
#
# Headless with software compositing, like guard-webview-click.sh: nothing here
# is measured in pixels.
#
# A page's `requestFullscreen()` reaches its WebContentsDelegate's
# `EnterFullscreenModeForTab`, which content's default ignores, so the page
# waits forever. `WebViewGuest` enters, tells the renderer through the widget's
# visual properties, and tells the element as `PageFullscreenChanged`, which
# fires `domicile-page-fullscreen-change`. Escape in the page and the element's
# `exitPageFullscreen()` both leave through `WebContents::ExitFullscreen`. A
# unit test cannot check this: happy-dom has no nested browsing context.
#
# The page is guard-webview-fullscreen-server.py's: a plain top half and a
# fullscreen button in the bottom half.
#
# Assertions, in order; each is meaningful only if the previous one holds:
#
#   the shell page ran               or nothing was set up
#   a press reached the shell's      the harness can deliver a press; without
#     document                        it, an absence below means nothing
#   there is a page in the window    a guest was made, attached and navigated
#   a press reached the page         the hit test crossed into the guest
#   the request was not refused      content let the page ask
#   the shell heard fullscreen       the element's `pageFullscreen` turned true
#   the page entered fullscreen      the page's own `fullscreenchange`, so the
#                                     renderer saw the grant
#   Escape left fullscreen           the element and the page both left, with
#                                     Escape typed on Caps Lock
#   the button entered again         a second request works after the first
#   exitPageFullscreen() left it     the shell's way out
#   no fault was reported            WebViewGuest's check that a page left
#                                     fullscreen raised no false alarm on a page
#                                     that did
#
# NEGATIVE=1 is the control: the press lands on the plain half, which asks for
# nothing. Nothing may be reported, or the positive run's report could come
# from the press or the load rather than the request.
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
  annotate "guard-webview-fullscreen: no path to chromium/src was given"
  exit 1
fi

# NEGATIVE=1 runs the control. See the header.
NEGATIVE="${NEGATIVE:-0}"

OUT="${OUT:-out/Domicile}"
BROKER="${BROKER:-/tmp/domicile-webview-fullscreen-broker}"
PROFILE="${PROFILE:-/tmp/domicile-webview-fullscreen-profile}"
WIDTH="${WIDTH:-1024}"
HEIGHT="${HEIGHT:-768}"

# Height of the shell's strip in CSS pixels. The press points derive from it.
#
# Not `STRIP`: `nix develop .#full` exports `STRIP=strip`, which breaks the
# arithmetic below under `set -u`. `packages/domicile-engine/tests/test-webview-guard-startup.sh`
# starts every guard in that environment to catch this.
STRIP_HEIGHT="${STRIP_HEIGHT:-64}"
CHROME_X=$((WIDTH / 2))
CHROME_Y=$((STRIP_HEIGHT / 2))
# The middles of the guest's two halves: the plain one and the button.
WINDOW_X=$((WIDTH / 2))
PLAIN_Y=$((STRIP_HEIGHT + (HEIGHT - STRIP_HEIGHT) / 4))
BUTTON_Y=$((STRIP_HEIGHT + 3 * (HEIGHT - STRIP_HEIGHT) / 4))

# Escape in every form the path needs; see guard-webview-escape.sh. Typed on
# Caps Lock, as `caps:swapescape` does: Escape is the key the layout makes, not
# the physical key.
ESCAPE_EVDEV=58
ESCAPE_CODE="CapsLock"
ESCAPE_KEY="Escape"
ESCAPE_VKEY=27

# Time for the shell to load and its guest to attach and navigate, and for
# each report the positive run waits on.
FOR_SECONDS="${FOR_SECONDS:-90}"

# The run and the control write separate logs, so both can be compared when
# they disagree.
WHICH=""
[ "$NEGATIVE" = "1" ] && WHICH="-negative"
ENGINE_LOG="${ENGINE_LOG:-/tmp/domicile-webview-fullscreen$WHICH-engine.log}"
HTTP_LOG="${HTTP_LOG:-/tmp/domicile-webview-fullscreen$WHICH-http.log}"
INPUT_LOG="${INPUT_LOG:-/tmp/domicile-webview-fullscreen$WHICH-input.log}"

STARTED=()
cleanup() {
  if [ ${#STARTED[@]} -gt 0 ]; then
    kill "${STARTED[@]}" 2>/dev/null
  fi
  remove_profile "$PROFILE"
}
trap cleanup EXIT

[ -x "$CHROMIUM/$OUT/chrome" ] || {
  annotate "guard-webview-fullscreen: no engine at $CHROMIUM/$OUT/chrome; build it with ./packages/domicile-engine/scripts/build.sh"
  exit 1
}
command -v python3 >/dev/null || {
  skip "guard-webview-fullscreen: no python3, and the page in the window, the pointer and the keys are all driven by one"
  exit 77
}

fresh_broker
rm -rf "$PROFILE"; mkdir -p "$PROFILE"

# Waits for `$2` to appear in `$3`, for `$1` quarter-seconds.
wait_for_line() { # $1 tries, $2 pattern, $3 file
  for _ in $(seq 1 "$1"); do
    grep -qF "$2" "$3" 2>/dev/null && return 0
    sleep 0.25
  done
  return 1
}

# Waits for `$3` to appear `$2` times in the engine log, for `$1`
# quarter-seconds.
wait_for_count() { # $1 tries, $2 count, $3 pattern
  for _ in $(seq 1 "$1"); do
    [ "$(grep -cF "$3" "$ENGINE_LOG" 2>/dev/null)" -ge "$2" ] && return 0
    sleep 0.25
  done
  return 1
}

# 1. The page: one local server, because `crux` cannot reach arbitrary hosts.
rm -f "$HTTP_LOG"
python3 "$SCRIPTS/guard-webview-fullscreen-server.py" --port 0 \
  >"$HTTP_LOG" 2>&1 &
STARTED+=($!)
wait_for_line 240 "serving" "$HTTP_LOG" || {
  annotate_from "guard-webview-fullscreen: its page server never came up" "$HTTP_LOG"
  echo "the server said:" >&2
  tail -20 "$HTTP_LOG" >&2
  exit 1
}
PORT="$(served_port "$HTTP_LOG")" || {
  annotate_from "guard-webview-fullscreen: its page server never said which port it took" "$HTTP_LOG"
  exit 1
}
SITE="http://127.0.0.1:$PORT"
echo "serving a page with a fullscreen button at $SITE/page"

# 2. The engine, on a domicile:// document, because the browser binds
#    WebViewGuestHost for that origin only.
rm -f "$ENGINE_LOG"
"$CHROMIUM/$OUT/chrome" \
  --ozone-platform=headless \
  --disable-gpu \
  --app="domicile://shell/?strip=$STRIP_HEIGHT&src=$SITE/page" \
  --domicile-shell-root="$SCRIPTS" \
  --domicile-shell-module="guard-webview-fullscreen.js" \
  --remote-debugging-port=0 \
  --no-sandbox --password-store=basic --no-first-run --disable-component-update \
  --user-data-dir="$PROFILE" \
  --window-size="$WIDTH,$HEIGHT" \
  --enable-logging=stderr --log-level=0 \
  --domicile-broker-socket="$BROKER" >"$ENGINE_LOG" 2>&1 &
STARTED+=($!)

TRIES=$((FOR_SECONDS * 4))
wait_for_line "$TRIES" "GUARD shell-loaded" "$ENGINE_LOG" || {
  annotate_from "guard-webview-fullscreen: the shell page never ran, so nothing here was ever set up" "$ENGINE_LOG"
  echo "the engine said:" >&2
  tail -40 "$ENGINE_LOG" >&2
  exit 1
}
DEBUG_PORT="$(devtools_port "$PROFILE" "$TRIES")" || {
  annotate_from "guard-webview-fullscreen: the engine never said which debugging port it took" "$ENGINE_LOG"
  exit 1
}
echo "the shell is up, with a <webview> under a ${STRIP_HEIGHT}px strip"

# 3. Wait for the guest's page before pressing on it.
wait_for_line "$TRIES" "GUARD page-loaded" "$ENGINE_LOG" ||
  echo "nothing ever loaded in the window" >&2

# Hit testing uses submitted compositor frames. The page running does not mean
# its first frame reached the browser, so wait before pressing.
sleep 3

click() { # $1 x, $2 y
  python3 "$SCRIPTS/guard-webview-click-mouse.py" \
    --port "$DEBUG_PORT" --x "$1" --y "$2" >>"$INPUT_LOG" 2>&1
}

# 4. A press on the shell's strip. It proves presses are delivered, so missing
#    readings below are real results.
: >"$INPUT_LOG"
click "$CHROME_X" "$CHROME_Y" ||
  echo "the first press could not be driven; see $INPUT_LOG" >&2
wait_for_line 20 "GUARD chrome-mousedown" "$ENGINE_LOG" ||
  echo "the shell's document never reported the first press" >&2

ENTERED_LINE="GUARD webview-fullscreen=true"
LEFT_LINE="GUARD webview-fullscreen=false"
PAGE_ENTERED_LINE="GUARD page-fullscreen element=yes"
PAGE_LEFT_LINE="GUARD page-fullscreen element=no"

# 5. The button, Escape, the button again, which the shell answers with
#    exitPageFullscreen(). Or the plain half, in the control.
if [ "$NEGATIVE" = "1" ]; then
  click "$WINDOW_X" "$PLAIN_Y" ||
    echo "the press on the page could not be driven; see $INPUT_LOG" >&2
  wait_for_line 20 "GUARD page-mousedown" "$ENGINE_LOG" ||
    echo "the page never reported the press" >&2
  # A fixed wait, not a poll, because the control expects an absence.
  sleep 5
else
  click "$WINDOW_X" "$BUTTON_Y" ||
    echo "the press on the button could not be driven; see $INPUT_LOG" >&2
  wait_for_line "$TRIES" "$PAGE_ENTERED_LINE" "$ENGINE_LOG" ||
    echo "the page never entered fullscreen" >&2
  wait_for_line 20 "$ENTERED_LINE" "$ENGINE_LOG" ||
    echo "the shell never heard the page enter fullscreen" >&2

  # The press on the button gave the guest the keyboard.
  python3 "$SCRIPTS/guard-webview-keyboard-key.py" \
    --port "$DEBUG_PORT" --code "$ESCAPE_CODE" --key "$ESCAPE_KEY" \
    --evdev "$ESCAPE_EVDEV" --windows-key-code "$ESCAPE_VKEY" \
    >>"$INPUT_LOG" 2>&1 ||
    echo "the Escape press could not be driven; see $INPUT_LOG" >&2
  wait_for_line "$TRIES" "$LEFT_LINE" "$ENGINE_LOG" ||
    echo "the shell never heard the page leave fullscreen on Escape" >&2
  wait_for_line 20 "$PAGE_LEFT_LINE" "$ENGINE_LOG" ||
    echo "the page never left fullscreen on Escape" >&2

  click "$WINDOW_X" "$BUTTON_Y" ||
    echo "the second press on the button could not be driven; see $INPUT_LOG" >&2
  wait_for_count "$TRIES" 2 "$ENTERED_LINE" ||
    echo "the shell never heard the page enter fullscreen again" >&2
  wait_for_count "$TRIES" 2 "$LEFT_LINE" ||
    echo "the shell never heard the page leave fullscreen when it asked" >&2
  # Past WebViewGuest's check that the page left, which must stay quiet.
  sleep 4
fi

saw() { # $1 pattern
  grep -qF "$1" "$ENGINE_LOG" && echo 1 || echo 0
}

saw_twice() { # $1 pattern
  [ "$(grep -cF "$1" "$ENGINE_LOG")" -ge 2 ] && echo 1 || echo 0
}

SAW_SHELL=$(saw "GUARD shell-loaded")
SAW_CHROME=$(saw "GUARD chrome-mousedown")
SAW_PAGE=$(saw "GUARD page-loaded")
SAW_PRESS=$(saw "GUARD page-mousedown")
SAW_REFUSED=$(saw "GUARD page-fullscreen refused")
SAW_ENTERED=$(saw "$ENTERED_LINE")
SAW_PAGE_ENTERED=$(saw "$PAGE_ENTERED_LINE")
SAW_ESCAPED=$(saw "$LEFT_LINE")
SAW_PAGE_LEFT=$(saw "$PAGE_LEFT_LINE")
SAW_REENTERED=$(saw_twice "$ENTERED_LINE")
SAW_EXITED=$(saw_twice "$LEFT_LINE")
SAW_FAULT=$(saw "domicile: a bug")
SAW_ANY=$( (grep -qF "GUARD webview-fullscreen" "$ENGINE_LOG" ||
  grep -qF "GUARD page-fullscreen" "$ENGINE_LOG") && echo 1 || echo 0)

echo
echo "shell=$SAW_SHELL page=$SAW_PAGE"
echo "presses: chrome=$SAW_CHROME page=$SAW_PRESS"
echo "fullscreen: refused=$SAW_REFUSED entered=$SAW_ENTERED page-entered=$SAW_PAGE_ENTERED escaped=$SAW_ESCAPED page-left=$SAW_PAGE_LEFT reentered=$SAW_REENTERED exited=$SAW_EXITED any=$SAW_ANY fault=$SAW_FAULT"
echo

# The verdict: names the component to blame. Checks run in dependency order.
# `packages/domicile-engine/tests/test-webview-fullscreen-guard.sh` runs this block directly.
FAILURE=""
PASSED=""
if [ "$SAW_SHELL" != "1" ]; then
  FAILURE="the shell page never ran, so nothing here was set up. This is the \
harness: the module did not load, or it threw, and the engine log has its \
console"
elif [ "$SAW_CHROME" != "1" ]; then
  FAILURE="no press reached the shell's document, so the pointer was never \
delivered to this browser. This is the harness"
elif [ "$SAW_PAGE" != "1" ]; then
  FAILURE="nothing loaded in the window, so there was no button to press. That \
is the guest: it was not made, attached or navigated"
elif [ "$SAW_PRESS" != "1" ]; then
  FAILURE="no press reached the page, so the hit test stopped at the shell. \
Nothing below was measured"
elif [ "$NEGATIVE" = "1" ]; then
  if [ "$SAW_ANY" = "1" ]; then
    FAILURE="the control pressed the half of the page that asks for nothing \
and fullscreen was reported anyway, so the positive run's report may come \
from the press or the load rather than the request"
  else
    PASSED="the control is sharp: a press that asked for nothing reported no \
fullscreen"
  fi
elif [ "$SAW_REFUSED" = "1" ]; then
  FAILURE="the page's requestFullscreen() was refused. Content refused it \
before WebViewGuest heard: no user activation from the press, or \
CanEnterFullscreenModeForTab"
elif [ "$SAW_ENTERED" != "1" ]; then
  FAILURE="the page asked for fullscreen and the shell never heard. Either \
the guest's EnterFullscreenModeForTab is not overridden (content's default \
does nothing), or PageFullscreenChanged never reached the element"
elif [ "$SAW_PAGE_ENTERED" != "1" ]; then
  FAILURE="the shell heard fullscreen and the page's own document never \
entered it. The renderer waits for the grant in the widget's visual \
properties: IsFullscreenForTabOrPending must answer true and \
SetPageFullscreen must resend them"
elif [ "$SAW_ESCAPED" != "1" ]; then
  FAILURE="Escape in a fullscreen page did not leave fullscreen, so a page \
can keep the user in. WebViewGuest::PreHandleKeyboardEvent must exit on \
Escape before the page sees it"
elif [ "$SAW_PAGE_LEFT" != "1" ]; then
  FAILURE="the shell heard the page leave fullscreen and the page's own \
document stayed in it, so the two disagree"
elif [ "$SAW_REENTERED" != "1" ]; then
  FAILURE="the button entered fullscreen once and never again. Leaving must \
reset what EnterFullscreenModeForTab checks"
elif [ "$SAW_EXITED" != "1" ]; then
  FAILURE="the shell called exitPageFullscreen() and the page stayed \
fullscreen, so a shell cannot take a page out with its window. The element \
must send ExitPageFullscreen and the guest exit through content"
elif [ "$SAW_FAULT" = "1" ]; then
  FAILURE="the page left fullscreen each time and the engine reported it \
stuck anyway, a false alarm the person would see as an urgent notification. \
WebViewGuest::CheckLeftFullscreen must read the page's own fullscreen element"
else
  PASSED="the page entered fullscreen from its button, the shell heard it, \
and Escape and exitPageFullscreen() each took it out"
fi

if [ -n "$PASSED" ]; then
  echo "PASS: $PASSED"
  exit 0
fi

annotate "guard-webview-fullscreen: $FAILURE"
echo "the engine's last words:" >&2
last_words "$ENGINE_LOG" >&2
echo "what the input did:" >&2
tail -20 "$INPUT_LOG" >&2
exit 1
