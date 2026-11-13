#!/usr/bin/env bash
# A video a page puts in picture-in-picture is listed to the shell, which shows
# it and whose controls reach the page (patch 0210,
# domicile_picture_in_picture.cc).
#
#   nix develop .#full --command \
#     ./packages/domicile-engine/scripts/guard-webview-video-picture-in-picture.sh /build/chromium/src
#
# Headless and software-composited: nothing is measured in pixels, so this
# does not say the shell's element draws the video, only that the shell is
# handed it.
#
# Chrome floats a picture-in-picture video in a window of its own. The engine
# lists it instead (`DomicileHost.pictureInPictureVideos`), and the shell draws
# it in an `<app picture-in-picture>` and acts on it with
# `actOnPictureInPictureVideo`.
#
# The shell module opens guard-webview-video-picture-in-picture-server.py's
# /video in a browser window. Once the video plays, the guard asks for
# picture-in-picture with a user gesture over the debugging port. The shell
# shows each listed video and then closes it.
#
# Assertions, in order; each is meaningful only if the previous one holds:
#
#   the shell ran                    or nothing was set up
#   the shell drew the window        its page has somewhere to play
#   the video played                 a video with frames, which the request
#                                     needs (the control)
#   the page entered                 the request was granted
#   the shell heard it               listed, for the window it drew
#   the shell's close reached it     the page left, paused
#   the listing went                 the shell's list emptied
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
  annotate "guard-webview-video-picture-in-picture: no path to chromium/src was given"
  exit 1
fi

OUT="${OUT:-out/Domicile}"
BROKER="${BROKER:-/tmp/domicile-webview-video-picture-in-picture-broker}"
PROFILE="${PROFILE:-/tmp/domicile-webview-video-picture-in-picture-profile}"
WIDTH="${WIDTH:-1024}"
HEIGHT="${HEIGHT:-768}"

# Time for the shell to load and its window's page to play, and for each step
# after.
FOR_SECONDS="${FOR_SECONDS:-90}"

ENGINE_LOG="${ENGINE_LOG:-/tmp/domicile-webview-video-picture-in-picture-engine.log}"
HTTP_LOG="${HTTP_LOG:-/tmp/domicile-webview-video-picture-in-picture-http.log}"
CLICK_LOG="${CLICK_LOG:-/tmp/domicile-webview-video-picture-in-picture-ask.log}"

# What the server writes for the page's reports and for nothing else. The
# `GUARD` prefix keeps the server's banner from matching.
REPORT_LINE="GUARD report "

STARTED=()
cleanup() {
  if [ ${#STARTED[@]} -gt 0 ]; then
    kill "${STARTED[@]}" 2>/dev/null
  fi
  remove_profile "$PROFILE"
}
trap cleanup EXIT

[ -x "$CHROMIUM/$OUT/chrome" ] || {
  annotate "guard-webview-video-picture-in-picture: no engine at $CHROMIUM/$OUT/chrome; build it with ./packages/domicile-engine/scripts/build.sh"
  exit 1
}
command -v python3 >/dev/null || {
  skip "guard-webview-video-picture-in-picture: no python3, and the page and the request are both driven by one"
  exit 77
}

fresh_broker
rm -rf "$PROFILE"; mkdir -p "$PROFILE"

# Waits for `$2` to appear in `$3`, for `$1` quarter-seconds.
wait_for_line() { # $1 tries, $2 pattern, $3 file
  for _ in $(seq 1 "$1"); do
    grep -qF -- "$2" "$3" 2>/dev/null && return 0
    sleep 0.25
  done
  return 1
}

# 1. The page: one local server, because `crux` cannot reach arbitrary hosts.
rm -f "$HTTP_LOG" "$CLICK_LOG"
python3 "$SCRIPTS/guard-webview-video-picture-in-picture-server.py" --port 0 \
  >"$HTTP_LOG" 2>&1 &
STARTED+=($!)
wait_for_line 240 "serving" "$HTTP_LOG" || {
  annotate_from "guard-webview-video-picture-in-picture: its page server never came up" "$HTTP_LOG"
  echo "the server said:" >&2
  tail -20 "$HTTP_LOG" >&2
  exit 1
}
PORT="$(served_port "$HTTP_LOG")" || {
  annotate_from "guard-webview-video-picture-in-picture: its page server never said which port it took" "$HTTP_LOG"
  exit 1
}
SITE="http://127.0.0.1:$PORT"
echo "serving the video at $SITE/video"

# 2. The engine, on a domicile:// document, because the browser binds
#    WebViewGuestHost and PictureInPictureVideos for that origin only. The
#    request goes in over `--remote-debugging-port`; see
#    guard-webview-video-picture-in-picture-ask.py.
rm -f "$ENGINE_LOG"
"$CHROMIUM/$OUT/chrome" \
  --ozone-platform=headless \
  --disable-gpu \
  --app="domicile://shell/?site=$SITE" \
  --domicile-shell-root="$SCRIPTS" \
  --domicile-shell-module="guard-webview-video-picture-in-picture.js" \
  --remote-debugging-port=0 \
  --no-sandbox --password-store=basic --no-first-run --disable-component-update \
  --user-data-dir="$PROFILE" \
  --window-size="$WIDTH,$HEIGHT" \
  --enable-logging=stderr --log-level=0 \
  --domicile-broker-socket="$BROKER" >"$ENGINE_LOG" 2>&1 &
STARTED+=($!)

TRIES=$((FOR_SECONDS * 4))
wait_for_line "$TRIES" "GUARD shell-loaded" "$ENGINE_LOG" || {
  annotate_from "guard-webview-video-picture-in-picture: the shell page never ran, so nothing here was ever set up" "$ENGINE_LOG"
  echo "the engine said:" >&2
  tail -40 "$ENGINE_LOG" >&2
  exit 1
}
DEBUG_PORT="$(devtools_port "$PROFILE" "$TRIES")" || {
  annotate_from "guard-webview-video-picture-in-picture: the engine never said which debugging port it took" "$ENGINE_LOG"
  exit 1
}
echo "the shell is up"

# 3. The video plays, then the request.
wait_for_line "$TRIES" "event=playing" "$HTTP_LOG" ||
  echo "the video never played" >&2
python3 "$SCRIPTS/guard-webview-video-picture-in-picture-ask.py" \
  --port "$DEBUG_PORT" --ending "/video" --tries "$TRIES" \
  >"$CLICK_LOG" 2>&1 ||
  echo "the request could not be driven; see $CLICK_LOG" >&2

# 4. The shell hears the video, shows it, and closes it.
wait_for_line "$TRIES" "GUARD pip-none" "$ENGINE_LOG" ||
  echo "the shell's list never emptied" >&2

saw() { # $1 pattern, $2 file
  grep -qF -- "$1" "$2" && echo 1 || echo 0
}

SAW_SHELL=$(saw "GUARD shell-loaded" "$ENGINE_LOG")
SAW_WINDOW=$(saw "GUARD window id=" "$ENGINE_LOG")
SAW_PLAYING=$(saw "event=playing" "$HTTP_LOG")
SAW_ENTERED=$(saw "event=entered" "$HTTP_LOG")
SAW_LISTED=$(saw "ours=true" "$ENGINE_LOG")
SAW_LEFT_PAUSED=$(saw "event=left paused=true" "$HTTP_LOG")
SAW_UNLISTED=$(saw "GUARD pip-none" "$ENGINE_LOG")

echo
cat "$CLICK_LOG" 2>/dev/null || true
grep -F "$REPORT_LINE" "$HTTP_LOG" || true
grep -F "GUARD pip" "$ENGINE_LOG" || true
echo "shell=$SAW_SHELL window=$SAW_WINDOW playing=$SAW_PLAYING"
echo "entered=$SAW_ENTERED listed=$SAW_LISTED left paused=$SAW_LEFT_PAUSED unlisted=$SAW_UNLISTED"
echo

# The verdict: names the component to blame. Checks run in dependency order.
# `packages/domicile-engine/tests/test-webview-video-picture-in-picture-guard.sh` runs this block directly.
FAILURE=""
PASSED=""
if [ "$SAW_SHELL" != "1" ]; then
  FAILURE="the shell page never ran, so nothing here was set up. This is the \
harness: the module did not load, or it threw, and the engine log has its \
console"
elif [ "$SAW_WINDOW" != "1" ]; then
  FAILURE="the shell never drew a browser window, so the page had nowhere to \
play. That is the guard's module or openBrowserWindow, not picture-in-picture"
elif [ "$SAW_PLAYING" != "1" ]; then
  FAILURE="the video never played, so there was nothing to put in \
picture-in-picture. That is the guest's page or its canvas stream"
elif [ "$SAW_ENTERED" != "1" ]; then
  FAILURE="the page's requestPictureInPicture was not granted (see what it \
said above). Blink's pictureInPictureEnabled is off, or \
WebViewGuest::EnterPictureInPicture did not answer kSuccess"
elif [ "$SAW_LISTED" != "1" ]; then
  FAILURE="the page entered picture-in-picture but the shell never heard it \
for the window it drew. ShellVideoOverlayWindow::ShowInactive did not list \
it, PictureInPictureVideos did not tell DomicileHost, or WindowOf named \
another window"
elif [ "$SAW_LEFT_PAUSED" != "1" ]; then
  FAILURE="the shell's close never left the page paused. \
actOnPictureInPictureVideo did not reach PictureInPictureVideos::Act, or \
ShellVideoOverlayWindow's kClose did not close the controller with a pause"
elif [ "$SAW_UNLISTED" != "1" ]; then
  FAILURE="the page left picture-in-picture but the shell still lists it. \
ShellVideoOverlayWindow::Hide did not drop its listing"
else
  PASSED="a video in picture-in-picture is listed for its window, and the \
shell's close pauses it and takes it off the list"
fi

if [ -n "$PASSED" ]; then
  echo "PASS: $PASSED"
  exit 0
fi

annotate "guard-webview-video-picture-in-picture: $FAILURE"
echo "the engine's last words:" >&2
last_words "$ENGINE_LOG" >&2
echo "the server said:" >&2
tail -20 "$HTTP_LOG" >&2
exit 1
