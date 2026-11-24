#!/usr/bin/env bash
# Checks that a desktop chord pressed while a browser window holds the
# keyboard still reaches the shell. See packages/domicile-engine/docs/GUARDS.md.
#
#   nix develop .#full --command \
#     ./packages/domicile-engine/scripts/guard-webview-keyboard.sh /build/chromium/src
#
# Runs headless with software compositing: nothing here is measured in pixels.
#
# A browser window's `view.focus()` moves DOM focus out of the shell document,
# so the shell sees no keys and the compositor sees none to match. The guest's
# WebContentsDelegate matches claimed chords in the browser process instead.
# A unit test cannot check this: jsdom has no nested browsing context, so focus
# never leaves the shell there.
#
# Checks, in order, since each depends on the one before:
#
#   the shell claimed a chord
#   there is a page in the window       a guest was made, attached and navigated
#   the element has the keyboard        or keys go to the shell
#   nothing was relayed                 `grab_shortcut` never reaches the
#                                        control socket: the browser process
#                                        holds the claims
#   the chord reached the shell         the main claim
#   the modifiers reached the shell     needed for Alt-dragging a float
#   an ungrabbed key reached the guest  seen as a modifier change only the
#     and not the shell's document      guest's hook reports
#   an unclaimed chord came back        Ctrl+R returns to the shell as
#     and a plain key did not           `domicile-guest-keydown`
#   each unclaimed key was delivered    `domicile-key-delivered` once for the
#     and the chord was not             plain key and once for Ctrl+R, not for
#                                        Alt+Tab
#   a lone Alt let go came back         as `domicile-guest-keyup`, which shows
#     and a plain key's release did not an Electron app's menu bar
#   the requested zoom arrives          the shell answers Ctrl+R with
#                                        setZoom(1.5); the element reports it
#                                        and the page's width changes
#
# One key is pressed before the window takes the keyboard, and the shell
# document must report it. Without that, "the shell did not see the second key"
# could mean no page receives key events. If the first key is missing too, the
# guard says so; the chord checks are browser-side and still count.
#
# NEGATIVE=1 is the control: an <iframe> in place of the <webview>, with the
# same keys. It takes the keyboard but has no guest delegate, so no chord may
# fire. This separates the delegate's matching from a harness that drives no
# key at all.
#
# The control's <iframe> loads the same page, and the element takes the
# keyboard only after it has. See step 4.
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
  annotate "guard-webview-keyboard: no path to chromium/src was given"
  exit 1
fi

# NEGATIVE=1 puts an <iframe> in place of the <webview>. See the header.
NEGATIVE="${NEGATIVE:-0}"
KIND="webview"
[ "$NEGATIVE" = "1" ] && KIND="iframe"

# Alt+Tab, the chord the page grabs by name: the evdev key the control-socket
# stand-in puts Tab on, a DOM code and key for the event, and a VKEY, without
# which Blink cannot name the key.
CHORD_EVDEV=15
CHORD_CODE="Tab"
CHORD_KEY="Tab"
CHORD_VKEY=9

# Two unclaimed keys: `b` before the window has the keyboard, `a` after.
BEFORE_EVDEV=48
BEFORE_CODE="KeyB"
BEFORE_KEY="b"
BEFORE_VKEY=66
PLAIN_EVDEV=30
PLAIN_CODE="KeyA"
PLAIN_KEY="a"
PLAIN_VKEY=65

# Ctrl+R: unclaimed and unhandled by the page, so the guest's delegate must
# return it to the shell.
UNCLAIMED_EVDEV=19
UNCLAIMED_CODE="KeyR"
UNCLAIMED_KEY="r"
UNCLAIMED_VKEY=82

# Alt alone, pressed and let go: its release must come back to the shell.
ALT_EVDEV=56
ALT_CODE="AltLeft"
ALT_KEY="Alt"
ALT_VKEY=18

OUT="${OUT:-out/Domicile}"
BROKER="${BROKER:-/tmp/domicile-webview-keyboard-broker}"
CONTROL="${CONTROL:-/tmp/domicile-webview-keyboard-control}"
PROFILE="${PROFILE:-/tmp/domicile-webview-keyboard-profile}"
WIDTH="${WIDTH:-1024}"
HEIGHT="${HEIGHT:-768}"

# Time for the shell to load, get a guest attached and navigated, and focus
# it. Generous because each step is asynchronous and the machine is shared.
FOR_SECONDS="${FOR_SECONDS:-90}"

# Separate logs for the control, so it does not overwrite the positive run's.
WHICH=""
[ "$NEGATIVE" = "1" ] && WHICH="-negative"
ENGINE_LOG="${ENGINE_LOG:-/tmp/domicile-webview-keyboard$WHICH-engine.log}"
HTTP_LOG="${HTTP_LOG:-/tmp/domicile-webview-keyboard$WHICH-http.log}"
SOCKET_LOG="${SOCKET_LOG:-/tmp/domicile-webview-keyboard$WHICH-socket.log}"
KEY_LOG="${KEY_LOG:-/tmp/domicile-webview-keyboard$WHICH-key.log}"

STARTED=()
cleanup() {
  if [ ${#STARTED[@]} -gt 0 ]; then
    kill "${STARTED[@]}" 2>/dev/null
  fi
  remove_profile "$PROFILE"
}
trap cleanup EXIT

[ -x "$CHROMIUM/$OUT/chrome" ] || {
  annotate "guard-webview-keyboard: no engine at $CHROMIUM/$OUT/chrome; build it with ./packages/domicile-engine/scripts/build.sh"
  exit 1
}
command -v python3 >/dev/null || {
  skip "guard-webview-keyboard: no python3, and the page, the control socket and the keystroke are all driven by one"
  exit 77
}

fresh_broker
rm -f "$CONTROL"; rm -rf "$PROFILE"; mkdir -p "$PROFILE"

# Waits for `$2` to appear in `$3`, for `$1` quarter seconds.
wait_for_line() { # $1 tries, $2 pattern, $3 file
  for _ in $(seq 1 "$1"); do
    grep -qF "$2" "$3" 2>/dev/null && return 0
    sleep 0.25
  done
  return 1
}

# 1. The guest page, from a local server: `crux` cannot reach arbitrary hosts.
#    Shared with guard-webview-click.sh.
rm -f "$HTTP_LOG"
python3 "$SCRIPTS/guard-webview-guest-page.py" --port 0 \
  >"$HTTP_LOG" 2>&1 &
STARTED+=($!)
wait_for_line 240 "serving" "$HTTP_LOG" || {
  annotate_from "guard-webview-keyboard: its page server never came up" "$HTTP_LOG"
  echo "the server said:" >&2
  tail -20 "$HTTP_LOG" >&2
  exit 1
}
PORT="$(served_port "$HTTP_LOG")" || {
  annotate_from "guard-webview-keyboard: its page server never said which port it took" "$HTTP_LOG"
  exit 1
}
SUBJECT="http://127.0.0.1:$PORT/page"
echo "serving a browser window's page at $SUBJECT"

# 2. A stand-in for the compositor's end of the control channel. Without a
#    listener, `ControlChannel` closes after thirty seconds, and the claim,
#    press and modifiers travel on it. It describes the keyboard the chord is
#    resolved against. `grab_shortcut` must never appear in its log.
rm -f "$SOCKET_LOG"
python3 "$SCRIPTS/guard-webview-keyboard-socket.py" --socket "$CONTROL" \
  >"$SOCKET_LOG" 2>&1 &
STARTED+=($!)
wait_for_line 240 "listening on" "$SOCKET_LOG" || {
  annotate_from "guard-webview-keyboard: the control-socket stand-in never listened on $CONTROL" "$SOCKET_LOG"
  tail -20 "$SOCKET_LOG" >&2
  exit 1
}

# 3. The engine, on a domicile:// document: the browser binds the control
#    channel and WebViewGuestHost only for that origin. `--app` matches how
#    `domicile` runs the engine.
#
#    Keys are sent over `--remote-debugging-port`, since there is no keyboard.
#    See guard-webview-keyboard-key.py.
rm -f "$ENGINE_LOG"
"$CHROMIUM/$OUT/chrome" \
  --ozone-platform=headless \
  --disable-gpu \
  --app="domicile://shell/?kind=$KIND&src=$SUBJECT" \
  --domicile-shell-root="$SCRIPTS" \
  --domicile-shell-module="guard-webview-keyboard.js" \
  --domicile-control-socket="$CONTROL" \
  --remote-debugging-port=0 \
  --no-sandbox --password-store=basic --no-first-run --disable-component-update \
  --user-data-dir="$PROFILE" \
  --window-size="$WIDTH,$HEIGHT" \
  --enable-logging=stderr --log-level=0 \
  --domicile-broker-socket="$BROKER" >"$ENGINE_LOG" 2>&1 &
STARTED+=($!)

TRIES=$((FOR_SECONDS * 4))
wait_for_line "$TRIES" "GUARD claimed" "$ENGINE_LOG" || {
  annotate_from "guard-webview-keyboard: the shell never claimed a chord, so nothing was asked for" "$ENGINE_LOG"
  echo "the engine said:" >&2
  tail -40 "$ENGINE_LOG" >&2
  exit 1
}
DEBUG_PORT="$(devtools_port "$PROFILE" "$TRIES")" || {
  annotate_from "guard-webview-keyboard: the engine never said which debugging port it took" "$ENGINE_LOG"
  exit 1
}
echo "the shell claimed Alt+Tab, showing a <$KIND>"

# 4. Wait for a page in the window, in both runs. The next key makes the page
#    focus the element, and the control's <iframe> replaces its first frame
#    when the page loads. Focus taken before that stays with the old frame, so
#    keys go to the shell's document and the shell's own claim fires.
wait_for_line "$TRIES" "GUARD guest-loaded" "$ENGINE_LOG" ||
  echo "nothing ever loaded in the window" >&2

# 5. A key while the shell still has the keyboard. The shell document must
#    report it, and it triggers focusing the window.
python3 "$SCRIPTS/guard-webview-keyboard-key.py" \
  --port "$DEBUG_PORT" --code "$BEFORE_CODE" --key "$BEFORE_KEY" \
  --evdev "$BEFORE_EVDEV" --windows-key-code "$BEFORE_VKEY" \
  >"$KEY_LOG" 2>&1 ||
  echo "the first key could not be driven; see $KEY_LOG" >&2

wait_for_line 20 "GUARD document-keydown code=$BEFORE_CODE" "$ENGINE_LOG" ||
  echo "the shell's document never reported the first key" >&2

# 6. The window takes the keyboard, on that key or on a timer if no key
#    arrived.
wait_for_line "$TRIES" "GUARD window-focused" "$ENGINE_LOG" ||
  echo "the element never became the shell document's activeElement" >&2

# 7. The chord and its key's release, then an unclaimed key. In that order,
#    the plain key reports the modifiers changing back, which is the only sign
#    that the guest's hook ran for a key it did not match.
python3 "$SCRIPTS/guard-webview-keyboard-key.py" \
  --port "$DEBUG_PORT" --code "$CHORD_CODE" --key "$CHORD_KEY" \
  --evdev "$CHORD_EVDEV" --windows-key-code "$CHORD_VKEY" --alt \
  >>"$KEY_LOG" 2>&1 ||
  echo "the chord could not be driven; see $KEY_LOG" >&2

python3 "$SCRIPTS/guard-webview-keyboard-key.py" \
  --port "$DEBUG_PORT" --code "$CHORD_CODE" --key "$CHORD_KEY" \
  --evdev "$CHORD_EVDEV" --windows-key-code "$CHORD_VKEY" --alt --up \
  >>"$KEY_LOG" 2>&1 ||
  echo "the chord's release could not be driven; see $KEY_LOG" >&2

python3 "$SCRIPTS/guard-webview-keyboard-key.py" \
  --port "$DEBUG_PORT" --code "$PLAIN_CODE" --key "$PLAIN_KEY" \
  --evdev "$PLAIN_EVDEV" --windows-key-code "$PLAIN_VKEY" \
  >>"$KEY_LOG" 2>&1 ||
  echo "the ungrabbed key could not be driven; see $KEY_LOG" >&2

python3 "$SCRIPTS/guard-webview-keyboard-key.py" \
  --port "$DEBUG_PORT" --code "$UNCLAIMED_CODE" --key "$UNCLAIMED_KEY" \
  --evdev "$UNCLAIMED_EVDEV" --windows-key-code "$UNCLAIMED_VKEY" --ctrl \
  >>"$KEY_LOG" 2>&1 ||
  echo "the unclaimed chord could not be driven; see $KEY_LOG" >&2

# `Input.dispatchKeyEvent` returns once the event is forwarded, before it is
# handled. A fixed wait, because some readings below are absences.
sleep 5

# The readings above come from the log as it is now: the keys below change the
# modifiers too, which would answer for the plain key's hook.
BEFORE_ALT="$ENGINE_LOG.before-alt"
cp "$ENGINE_LOG" "$BEFORE_ALT"

# 8. Alt alone, then the plain key's release. Only the first is a modifier.
python3 "$SCRIPTS/guard-webview-keyboard-key.py" \
  --port "$DEBUG_PORT" --code "$ALT_CODE" --key "$ALT_KEY" \
  --evdev "$ALT_EVDEV" --windows-key-code "$ALT_VKEY" --alt \
  >>"$KEY_LOG" 2>&1 ||
  echo "Alt could not be driven; see $KEY_LOG" >&2

python3 "$SCRIPTS/guard-webview-keyboard-key.py" \
  --port "$DEBUG_PORT" --code "$ALT_CODE" --key "$ALT_KEY" \
  --evdev "$ALT_EVDEV" --windows-key-code "$ALT_VKEY" --up \
  >>"$KEY_LOG" 2>&1 ||
  echo "Alt's release could not be driven; see $KEY_LOG" >&2

python3 "$SCRIPTS/guard-webview-keyboard-key.py" \
  --port "$DEBUG_PORT" --code "$PLAIN_CODE" --key "$PLAIN_KEY" \
  --evdev "$PLAIN_EVDEV" --windows-key-code "$PLAIN_VKEY" --up \
  >>"$KEY_LOG" 2>&1 ||
  echo "the plain key's release could not be driven; see $KEY_LOG" >&2

sleep 3

saw() { # $1 pattern
  grep -qF "$1" "$BEFORE_ALT" && echo 1 || echo 0
}

SAW_CLAIM=$(saw "GUARD claimed")
SAW_PAGE=$(saw "GUARD guest-loaded")
SAW_FOCUS=$(saw "GUARD window-focused")
SAW_SHORTCUT=$(saw "GUARD shortcut keycode=$CHORD_EVDEV alt=true ctrl=false shift=false meta=false")
SAW_RELEASE=$(saw "GUARD release keycode=$CHORD_EVDEV alt=true ctrl=false shift=false meta=false")
SAW_MODIFIERS=$(saw "GUARD modifiers alt=true ctrl=false shift=false meta=false")
# The guest's hook running for a key it did not match. Only
# PreHandleKeyboardEvent on the guest's delegate reports Alt released here.
SAW_HOOK=$(saw "GUARD modifiers alt=false ctrl=false shift=false meta=false")
SAW_SHELL_KEY=$(saw "GUARD document-keydown code=$BEFORE_CODE")
SAW_DOCUMENT_KEY=$(saw "GUARD document-keydown code=$PLAIN_CODE")
SAW_GUEST_KEY=$(saw "GUARD guest-keydown code=$PLAIN_CODE")
SAW_RELAY=$(grep -qF "grab_shortcut" "$SOCKET_LOG" && echo 1 || echo 0)
SAW_GUEST_CHORD=$(saw "GUARD guest-chord key=$UNCLAIMED_KEY code=$UNCLAIMED_CODE alt=false ctrl=true")
SAW_PLAIN_CHORD=$(saw "GUARD guest-chord key=$PLAIN_KEY")
SAW_ZOOM=$(saw "GUARD zoom factor=1.5")
SAW_ZOOM_DRAWN=$(saw "GUARD guest-resized")
# The plain key and Ctrl+R; a third is the claimed chord.
DELIVERED=$(grep -cF "GUARD key-delivered" "$BEFORE_ALT")
SAW_ALT_UP=$(grep -qF "GUARD guest-keyup key=$ALT_KEY code=$ALT_CODE" "$ENGINE_LOG" && echo 1 || echo 0)
SAW_PLAIN_UP=$(grep -qF "GUARD guest-keyup key=$PLAIN_KEY" "$ENGINE_LOG" && echo 1 || echo 0)

echo
echo "claimed=$SAW_CLAIM loaded=$SAW_PAGE focused=$SAW_FOCUS relayed=$SAW_RELAY"
echo "shortcut=$SAW_SHORTCUT release=$SAW_RELEASE modifiers=$SAW_MODIFIERS hook-ran-unmatched=$SAW_HOOK"
echo "the shell's document saw: before=$SAW_SHELL_KEY after=$SAW_DOCUMENT_KEY"
echo "the page in the window saw: after=$SAW_GUEST_KEY"
echo "handed back: chord=$SAW_GUEST_CHORD plain=$SAW_PLAIN_CHORD; zoom=$SAW_ZOOM drawn=$SAW_ZOOM_DRAWN"
echo "delivered: $DELIVERED of 2"
echo "let go: alt=$SAW_ALT_UP plain=$SAW_PLAIN_UP"
echo

# The verdict. `packages/domicile-engine/tests/test-webview-keyboard-guard.sh` runs this block
# directly. Checks are ordered by dependency, so each failure names the first
# layer that broke.
FAILURE=""
PASSED=""
if [ "$SAW_CLAIM" != "1" ]; then
  FAILURE="the shell never claimed a chord, so nothing here was ever asked \
for. This is the harness: the page did not run, or no desktop was \
handed to it, and the engine log has its console"
elif [ "$SAW_FOCUS" != "1" ]; then
  FAILURE="the element never became the shell document's activeElement, so \
the keyboard never left the shell and the keystrokes below were driven at the \
wrong window. This is the harness, not the hook"
elif [ "$SAW_RELAY" = "1" ]; then
  FAILURE="the claim was written to the control socket. It is the browser \
process that holds these now — the compositor sees not one key of a focused \
guest's, so a claim relayed to it is a claim nothing can match"
elif [ "$NEGATIVE" = "1" ]; then
  if [ "$SAW_SHORTCUT" = "1" ]; then
    FAILURE="a chord fired with an <iframe> in the element's place. There is \
no guest there and so no delegate to match it, which means the press did not \
come from the hook under test and the positive run is measuring something else"
  else
    PASSED="the control is sharp: an ordinary subframe takes the keyboard \
just as thoroughly and nothing fires, so the positive run is measuring the \
guest's hook and not the harness"
  fi
elif [ "$SAW_PAGE" != "1" ]; then
  FAILURE="nothing ever loaded in the window, so there was no page for the \
keyboard to be in and the readings below are about an empty frame. That is the \
guest: it was not made, not attached, or not navigated. The engine's log has \
the browser's own line for an attach, and the http log says whether the page \
was ever asked for"
elif [ "$SAW_SHORTCUT" != "1" ]; then
  FAILURE="the chord never reached the shell. The window had the keyboard and \
the claim was made, so this is the hook: either PreHandleKeyboardEvent did not \
run on the guest's delegate, or it ran and did not match, or the press did not \
come back down the control channel"
elif [ "$SAW_RELEASE" != "1" ]; then
  FAILURE="the chord fired and its key coming up in the guest never let it \
go, so an application's global shortcut stays activated. Either \
PreHandleKeyboardEvent did not pass the release to ShortcutRegistry::Release, \
or ShortcutReleased did not come back down the control channel, or the page \
did not pair it with the press"
elif [ "$SAW_MODIFIERS" != "1" ]; then
  FAILURE="the chord fired and the modifiers did not. The shell reads Alt and \
Shift from this and nothing else while a window has the keyboard, so a float \
that cannot be dragged or resized is what this failure looks like to a user"
elif [ "$SAW_HOOK" != "1" ]; then
  FAILURE="the ungrabbed key never reached the guest's delegate: the hook \
reported no modifier change for it, and nothing else in the process reports \
one. So the key went somewhere else, or nowhere, and where an unhandled key \
ends up is not decided by this run"
elif [ "$SAW_GUEST_CHORD" != "1" ]; then
  FAILURE="Ctrl+R, which nobody claimed and the page does not take, never came \
back to the shell as domicile-guest-keydown. So a browser window's chrome \
cannot bind it: WebViewGuest::HandleKeyboardEvent did not run, did not send \
UnhandledKeyDown, or the element did not dispatch it"
elif [ "$SAW_PLAIN_CHORD" = "1" ]; then
  FAILURE="a plain key was handed back to the shell as domicile-guest-keydown. \
Only chords may be: this is every keystroke typed into a page, a password's \
included, copied into the shell's document"
elif [ "$SAW_ALT_UP" != "1" ]; then
  FAILURE="Alt, pressed and let go alone, never came back to the shell as \
domicile-guest-keyup, so Alt cannot show an Electron app's menu bar over its \
window. WebViewGuest::HandleKeyboardEvent did not send UnhandledModifierUp for \
the release, or the element did not dispatch it"
elif [ "$SAW_PLAIN_UP" = "1" ]; then
  FAILURE="a plain key's release was handed back to the shell as \
domicile-guest-keyup. Only modifiers may be: this is every keystroke typed \
into a page, a password's included, copied into the shell's document"
elif [ "$DELIVERED" != "2" ]; then
  FAILURE="the shell heard domicile-key-delivered $DELIVERED times where the \
plain key and Ctrl+R owed 2. Fewer: WebViewGuest::PreHandleKeyboardEvent did \
not send KeyDelivered for an unclaimed key, or the element did not dispatch \
it, so typing in a browser window does not end a selection around it. More: \
the claimed chord was counted as typing in the page"
elif [ "$SAW_ZOOM" != "1" ]; then
  FAILURE="the shell asked for 150% and the element never reported it. \
Either SetZoom never reached the browser, or HostZoomMap set it and ReportZoom \
did not send ZoomChanged"
elif [ "$SAW_ZOOM_DRAWN" != "1" ]; then
  FAILURE="the element reported 150% and the page's width never moved. \
HostZoomMap holds a level the guest's widget did not pick up, which is a \
number rather than a zoom"
elif [ "$SAW_DOCUMENT_KEY" = "1" ]; then
  FAILURE="an ungrabbed key reached BOTH the guest's delegate and the shell's \
document. That is not the answer WebViewGuest::PreHandleKeyboardEvent records \
in its own comment, and it is good news rather than a regression: the shell's \
own non-grabbed keys still work over a browser window. Update that, then this \
arm"
elif [ "$SAW_SHELL_KEY" != "1" ]; then
  # Not a failure. The claims above are measured in the browser process. A
  # headless browser may deliver no DOM key events, which is a harness limit.
  # It only means the shell document's absence of the second key decides
  # nothing.
  PASSED="a desktop chord reached the shell while a browser window held the \
keyboard, the modifiers came with it, Ctrl+R came back to the shell with the \
zoom it asked for drawn, and an ungrabbed key reached the guest's \
delegate and not the shell. WITH ONE READING SHORT: no key reached the shell's \
document even before the window took focus, so this run cannot tell that \
absence from a page that receives no key events at all, and does not decide \
where an unhandled key ends up"
else
  PASSED="a desktop chord reached the shell while a browser window held the \
keyboard, the modifiers came with it, Ctrl+R came back to the shell with the \
zoom it asked for drawn, and an ungrabbed key reached the guest's \
delegate and not the shell's document — which the same document DID receive \
before the window took focus, so that absence is a measurement. That is the \
recorded answer to whether a guest's unhandled keys reach the embedder: they \
do not"
fi

if [ -n "$PASSED" ]; then
  echo "PASS: $PASSED"
  exit 0
fi

annotate "guard-webview-keyboard: $FAILURE"
echo "the engine's last words:" >&2
last_words "$ENGINE_LOG" >&2
echo "what the control socket was told:" >&2
tail -20 "$SOCKET_LOG" >&2
echo "what the keystrokes did:" >&2
tail -20 "$KEY_LOG" >&2
exit 1
